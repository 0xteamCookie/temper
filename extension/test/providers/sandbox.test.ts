import { describe, expect, it } from 'vitest';
import { buildSandboxManifest, DAYTONA_DEFAULTS, REDACTED, SandboxAdmin } from '../../src/providers/sandbox';
import type { FetchLike } from '../../src/providers/discovery';

const KEY = 'dtn_supersecretkey_123456';

describe('buildSandboxManifest', () => {
  it('uses the catalog defaults for a first-time connection', () => {
    expect(buildSandboxManifest(`  ${KEY} `)).toEqual({
      type: 'daytona',
      auth: { api_key: KEY },
      ...DAYTONA_DEFAULTS,
    });
  });

  it('keeps the intervals of an existing configuration when the key is replaced', () => {
    const existing = {
      auth: { api_key: REDACTED },
      exec_timeout_ms: 90_000,
      auto_stop_interval_in_minutes: 0,
      auto_archive_interval_in_minutes: 30,
      auto_delete_interval_in_minutes: 100,
    };
    const m = buildSandboxManifest(KEY, existing);
    expect(m.auth.api_key).toBe(KEY);
    expect(m.exec_timeout_ms).toBe(90_000);
    expect(m.auto_stop_interval_in_minutes).toBe(0);
    expect(m.auto_archive_interval_in_minutes).toBe(30);
    expect(m.auto_delete_interval_in_minutes).toBe(100);
  });

  it('sends the redacted value (keep the stored key) when no key is given', () => {
    expect(buildSandboxManifest('').auth.api_key).toBe(REDACTED);
  });

  it('falls back to defaults for invalid existing values', () => {
    const m = buildSandboxManifest(KEY, {
      exec_timeout_ms: 0,
      auto_stop_interval_in_minutes: -5,
      auto_archive_interval_in_minutes: '1',
    });
    expect(m).toMatchObject(DAYTONA_DEFAULTS);
  });
});

interface Seen {
  url: string;
  method?: string;
  body?: string;
}

function fakeFetch(routes: Record<string, { status: number; body: unknown }>, seen: Seen[] = []): FetchLike {
  return async (url, init) => {
    const method = init?.method ?? 'GET';
    seen.push({ url, method, body: (init as { body?: string } | undefined)?.body });
    const hit = routes[`${method} ${new URL(url).pathname}`] ?? { status: 404, body: {} };
    return { ok: hit.status < 300, status: hit.status, text: async () => JSON.stringify(hit.body) };
  };
}

describe('SandboxAdmin', () => {
  it('reports not connected on 404 and reads the skills capability', async () => {
    const admin = new SandboxAdmin(
      'http://tf',
      fakeFetch({
        'GET /api/v1/settings/sandbox-providers': { status: 404, body: { error: { message: 'No sandbox provider configured' } } },
        'GET /api/v1/capabilities': {
          status: 200,
          body: { data: { sandbox: { enabled: false }, skill: { enabled: false, reason: 'Skills run in a sandbox' } } },
        },
      }),
    );
    expect(await admin.status()).toEqual({
      connected: false,
      ready: false,
      environment: undefined,
      skills: { enabled: false, reason: 'Skills run in a sandbox' },
      manifest: undefined,
    });
  });

  it('keeps the key as connected but not ready when the environment build failed', async () => {
    const admin = new SandboxAdmin(
      'http://tf',
      fakeFetch({
        'GET /api/v1/settings/sandbox-providers': {
          status: 200,
          body: { data: { manifest: { type: 'daytona', auth: { api_key: '***REDACTED***' } } } },
        },
        'GET /api/v1/capabilities': { status: 200, body: { data: { sandbox: { enabled: false }, skill: { enabled: false } } } },
        'GET /api/v1/sandbox-environments': {
          status: 200,
          body: { data: [{ is_default: true, status: 'failed', status_reason: 'API key is missing required permissions' }] },
        },
      }),
    );
    const s = await admin.status();
    expect(s.connected).toBe(true);
    expect(s.ready).toBe(false);
    expect(s.environment).toEqual({ status: 'failed', reason: 'API key is missing required permissions' });
  });

  it('reports connected with the redacted manifest', async () => {
    const manifest = { type: 'daytona', auth: { api_key: REDACTED }, exec_timeout_ms: 1 };
    const admin = new SandboxAdmin(
      'http://tf',
      fakeFetch({
        'GET /api/v1/settings/sandbox-providers': { status: 200, body: { data: { manifest } } },
        'GET /api/v1/capabilities': { status: 200, body: { data: { sandbox: { enabled: true }, skill: { enabled: true } } } },
      }),
    );
    const s = await admin.status();
    expect(s.connected).toBe(true);
    expect(s.skills).toEqual({ enabled: true });
    expect(s.manifest).toEqual(manifest);
  });

  it('PUTs the manifest and scrubs the key from errors', async () => {
    const seen: Seen[] = [];
    const admin = new SandboxAdmin(
      'http://tf/',
      fakeFetch(
        { 'PUT /api/v1/settings/sandbox-providers': { status: 400, body: { error: { message: `bad key ${KEY}` } } } },
        seen,
      ),
      () => [KEY],
    );
    const err = await admin.put(buildSandboxManifest(KEY)).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 400/);
    expect((err as Error).message).not.toContain(KEY);
    expect(seen[0]).toMatchObject({ method: 'PUT', url: 'http://tf/api/v1/settings/sandbox-providers' });
    expect(JSON.parse(seen[0]!.body!).manifest.type).toBe('daytona');
  });

  it('scrubs the key from network errors', async () => {
    const admin = new SandboxAdmin(
      'http://tf',
      async () => {
        throw new Error(`connect failed Bearer ${KEY}`);
      },
      () => [KEY],
    );
    const err = (await admin.get().catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/Cannot reach TrueForge/);
    expect(err.message).not.toContain(KEY);
  });

  it('reads the version from /healthz', async () => {
    const admin = new SandboxAdmin(
      'http://tf',
      fakeFetch({ 'GET /healthz': { status: 200, body: { status: 'ok', version: '0.185.0' } } }),
    );
    expect(await admin.version()).toBe('0.185.0');
  });
});
