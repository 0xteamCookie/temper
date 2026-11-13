// TrueForge settings API for model providers (list / upsert / delete) plus the catalog. No vscode imports.
import type { FetchLike } from './discovery';
import type { CatalogModel, ProviderManifestBody } from './manifest';
import { scrubSecrets } from './scrub';

export interface ConfiguredProvider {
  name: string;
  manifest: {
    type: string;
    base_url?: string;
    models?: Array<{ model_id: string; name: string; properties?: Record<string, unknown> }>;
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

export class ProviderAdmin {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly secrets: () => string[] = () => [],
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const init = {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    };
    let res;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, init as Parameters<FetchLike>[1]);
    } catch (e) {
      // eslint-disable-next-line preserve-caught-error -- the cause is dropped on purpose; it could carry a key
      throw new Error(
        `Cannot reach TrueForge at ${this.base}: ${scrubSecrets(e instanceof Error ? e.message : String(e), this.secrets())}`,
      );
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json };
  }

  private fail(what: string, status: number, json: unknown): never {
    const j = obj(json);
    const detail = String(obj(j.error).message ?? j.message ?? j.raw ?? '').slice(0, 200);
    throw new Error(
      scrubSecrets(`${what} failed (HTTP ${status})${detail ? `: ${detail}` : ''}`, this.secrets()),
    );
  }

  async list(): Promise<ConfiguredProvider[]> {
    const { status, json } = await this.call('GET', '/api/v1/settings/model-providers');
    if (status !== 200) this.fail('Listing providers', status, json);
    const rows = obj(json).data;
    return Array.isArray(rows) ? (rows as ConfiguredProvider[]) : [];
  }

  /** Create, or replace on 409. A manifest key of "***REDACTED***" keeps the stored key. */
  async upsert(manifest: ProviderManifestBody): Promise<void> {
    const path = '/api/v1/settings/model-providers';
    const post = await this.call('POST', path, { manifest });
    if (post.status >= 200 && post.status < 300) return;
    if (post.status !== 409) this.fail('Saving the provider', post.status, post.json);
    const put = await this.call('PUT', path, { manifest });
    if (put.status < 200 || put.status >= 300)
      this.fail('Updating the provider', put.status, put.json);
  }

  async remove(name: string): Promise<void> {
    const { status, json } = await this.call(
      'DELETE',
      `/api/v1/settings/model-providers/${encodeURIComponent(name)}`,
    );
    if (status < 200 || status >= 300) this.fail('Removing the provider', status, json);
  }

  /** TrueForge's preset models for a well-known provider type (used to enrich and to preselect). */
  async catalogModels(type: string): Promise<CatalogModel[]> {
    try {
      const { status, json } = await this.call('GET', '/api/v1/catalogs/model-providers');
      if (status !== 200) return [];
      const rows = obj(json).data;
      const hit = (Array.isArray(rows) ? (rows as Json[]) : []).find((p) => p.type === type);
      return Array.isArray(hit?.models) ? (hit.models as CatalogModel[]) : [];
    } catch {
      return [];
    }
  }

  /** Names ("provider/model") that TrueForge currently serves. */
  async servedModelNames(): Promise<string[]> {
    const { status, json } = await this.call('GET', '/api/v1/models');
    if (status !== 200) this.fail('Listing models', status, json);
    const rows = obj(json).data;
    return (Array.isArray(rows) ? (rows as Json[]) : []).map((m) => String(m.name));
  }
}
