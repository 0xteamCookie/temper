// TrueForge sandbox provider (Daytona) and capabilities. No vscode imports; the key only ever lives in the
// argument of one call and is scrubbed from every message. TrueForge supports exactly one provider: Daytona.
import type { FetchLike } from './discovery';
import { scrubSecrets } from './scrub';

export const REDACTED = '***REDACTED***';

/** TrueForge's catalog defaults for Daytona (GET /api/v1/catalogs/sandbox-providers). */
export const DAYTONA_DEFAULTS = {
  exec_timeout_ms: 60_000,
  auto_stop_interval_in_minutes: 5,
  auto_archive_interval_in_minutes: 60,
  auto_delete_interval_in_minutes: 7200,
} as const;

export interface SandboxManifest {
  type: 'daytona';
  auth: { api_key: string };
  exec_timeout_ms: number;
  auto_stop_interval_in_minutes: number;
  auto_archive_interval_in_minutes: number;
  auto_delete_interval_in_minutes: number;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});

function int(v: unknown, fallback: number, min: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min ? v : fallback;
}

/**
 * Manifest for PUT /settings/sandbox-providers. Keeps the intervals of an existing configuration so that
 * replacing the key does not reset anything else. An empty `apiKey` sends the redacted value, which keeps
 * the stored key.
 */
export function buildSandboxManifest(apiKey: string, existing?: unknown): SandboxManifest {
  const e = obj(existing);
  const key = apiKey.trim();
  const d = DAYTONA_DEFAULTS;
  return {
    type: 'daytona',
    auth: { api_key: key || REDACTED },
    exec_timeout_ms: int(e.exec_timeout_ms, d.exec_timeout_ms, 1),
    auto_stop_interval_in_minutes: int(e.auto_stop_interval_in_minutes, d.auto_stop_interval_in_minutes, 0),
    auto_archive_interval_in_minutes: int(e.auto_archive_interval_in_minutes, d.auto_archive_interval_in_minutes, 0),
    auto_delete_interval_in_minutes: int(e.auto_delete_interval_in_minutes, d.auto_delete_interval_in_minutes, 0),
  };
}

export interface SandboxStatus {
  /** A sandbox provider is configured. */
  connected: boolean;
  skills?: { enabled: boolean; reason?: string };
  /** Manifest as returned by TrueForge (key redacted), when configured. */
  manifest?: unknown;
}

export class SandboxAdmin {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly secrets: () => string[] = () => [],
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
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
    throw new Error(scrubSecrets(`${what} failed (HTTP ${status})${detail ? `: ${detail}` : ''}`, this.secrets()));
  }

  /** The configured provider's manifest, or undefined when none is configured (404). */
  async get(): Promise<unknown> {
    const { status, json } = await this.call('GET', '/api/v1/settings/sandbox-providers');
    if (status === 404) return undefined;
    if (status !== 200) this.fail('Reading the sandbox provider', status, json);
    return obj(obj(json).data).manifest;
  }

  async put(manifest: SandboxManifest): Promise<void> {
    const { status, json } = await this.call('PUT', '/api/v1/settings/sandbox-providers', { manifest });
    if (status < 200 || status >= 300) this.fail('Saving the sandbox provider', status, json);
  }

  async status(): Promise<SandboxStatus> {
    const manifest = await this.get();
    let connected = manifest !== undefined;
    let skills: SandboxStatus['skills'];
    try {
      const { status, json } = await this.call('GET', '/api/v1/capabilities');
      if (status === 200) {
        const d = obj(obj(json).data);
        const sb = obj(d.sandbox);
        if (typeof sb.enabled === 'boolean') connected = sb.enabled;
        const sk = obj(d.skill);
        if (typeof sk.enabled === 'boolean')
          skills = { enabled: sk.enabled, ...(typeof sk.reason === 'string' ? { reason: sk.reason } : {}) };
      }
    } catch {
      /* capabilities are advisory; the manifest already tells us whether it is configured */
    }
    return { connected, skills, manifest };
  }

  /** TrueForge version from /healthz, or undefined. */
  async version(): Promise<string | undefined> {
    try {
      const { status, json } = await this.call('GET', '/healthz');
      const v = obj(json).version;
      return status === 200 && typeof v === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  }
}
