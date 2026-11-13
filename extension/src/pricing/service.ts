// Price index lifecycle: bundled snapshot -> trimmed on-disk cache -> models.dev refresh (at most once per 24 h).
// No vscode import; I/O is injected so it can be tested.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import snapshot from './snapshot.json';
import { resolveContext, resolvePrice, trimModelsDev } from './resolve';
import type { PriceIndex, PriceOverrides } from './resolve';
import type { ModelInfo } from '../shared/types';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const REFRESH_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = 'models-dev-prices.json';

interface CacheFile {
  fetchedAt: number;
  index: PriceIndex;
}

export interface PricingIo {
  readFile(file: string): Promise<string | undefined>;
  writeFile(file: string, data: string): Promise<void>;
  fetchJson(url: string, signal?: AbortSignal): Promise<unknown>;
  now(): number;
}

export const nodeIo: PricingIo = {
  async readFile(file) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      return undefined;
    }
  },
  async writeFile(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data, 'utf8');
  },
  async fetchJson(url, signal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  now: () => Date.now(),
};

export interface PricingConfig {
  fetch: boolean;
  overrides: PriceOverrides;
}

export class PricingService {
  private index: PriceIndex = snapshot as PriceIndex;
  private fetchedAt = 0;

  constructor(
    private readonly storageDir: string,
    private readonly getConfig: () => PricingConfig,
    private readonly io: PricingIo = nodeIo,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  /** Load the cache, then refresh from models.dev if allowed and stale. Never throws. */
  async init(): Promise<boolean> {
    let changed = false;
    const raw = await this.io.readFile(path.join(this.storageDir, CACHE_FILE));
    if (raw) {
      try {
        const c = JSON.parse(raw) as CacheFile;
        if (c && typeof c.fetchedAt === 'number' && c.index && typeof c.index === 'object') {
          this.index = { ...(snapshot as PriceIndex), ...c.index };
          this.fetchedAt = c.fetchedAt;
          changed = true;
        }
      } catch {
        /* corrupt cache: ignore, fall back to the snapshot */
      }
    }
    return (await this.refreshIfStale()) || changed;
  }

  /** True when the index changed. */
  async refreshIfStale(): Promise<boolean> {
    if (!this.getConfig().fetch) return false;
    if (this.io.now() - this.fetchedAt < REFRESH_MS) return false;
    try {
      const index = trimModelsDev(await this.io.fetchJson(MODELS_DEV_URL));
      if (Object.keys(index).length === 0) throw new Error('empty response');
      this.index = { ...(snapshot as PriceIndex), ...index };
      this.fetchedAt = this.io.now();
      await this.io.writeFile(
        path.join(this.storageDir, CACHE_FILE),
        JSON.stringify({ fetchedAt: this.fetchedAt, index } satisfies CacheFile),
      );
      this.log(`pricing: refreshed from models.dev (${Object.keys(index).length} providers)`);
      return true;
    } catch (e) {
      // Keep what we have; retry after the next window rather than hammering a failing host.
      this.fetchedAt = this.io.now() - REFRESH_MS + 60 * 60 * 1000;
      this.log(
        `pricing: models.dev refresh failed (${e instanceof Error ? e.message : String(e)}); using cached prices`,
      );
      return false;
    }
  }

  priceOf(model: string) {
    return resolvePrice(model, this.index, this.getConfig().overrides);
  }

  /** Attach price (and a context size when TrueForge reports none) to each model. */
  enrich(models: ModelInfo[]): ModelInfo[] {
    return models.map((m) => {
      const price = this.priceOf(m.name);
      const contextLength = m.contextLength ?? resolveContext(m.name, this.index);
      return { ...m, ...(price ? { price } : {}), ...(contextLength ? { contextLength } : {}) };
    });
  }
}
