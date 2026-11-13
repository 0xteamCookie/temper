import { describe, expect, it } from 'vitest';
import { CATALOG_PROVIDERS, COMPATIBLE_PRESETS } from '../../src/providers/catalog';
import { discoverModels } from '../../src/providers/discovery';
import type { FetchLike } from '../../src/providers/discovery';
import { buildRows, compareServed } from '../../src/providers/rows';
import { fmtTokens } from '../../src/shared/format';

const reply = (body: unknown, status = 200): ReturnType<FetchLike> =>
  Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
const def = (id: string) => [...CATALOG_PROVIDERS, ...COMPATIBLE_PRESETS].find((d) => d.id === id)!;

describe('discoverModels', () => {
  it('lists OpenRouter models with tool support from supported_parameters', async () => {
    let seen: { url: string; headers?: Record<string, string> } | undefined;
    const f: FetchLike = (url, init) => {
      seen = { url, headers: init?.headers };
      return reply({
        data: [
          { id: 'a/b', context_length: 64000, supported_parameters: ['tools'] },
          { id: 'c/d', supported_parameters: ['temperature'] },
        ],
      });
    };
    const out = await discoverModels({ def: def('openrouter'), key: 'K' }, f);
    expect(seen).toEqual({
      url: 'https://openrouter.ai/api/v1/models',
      headers: { authorization: 'Bearer K' },
    });
    expect(out.map((m) => [m.id, m.context, m.tools])).toEqual([
      ['a/b', 64000, true],
      ['c/d', undefined, false],
    ]);
  });

  it('keeps only Gemini models that can generateContent', async () => {
    const f: FetchLike = () =>
      reply({
        models: [
          {
            name: 'models/g1',
            supportedGenerationMethods: ['generateContent'],
            inputTokenLimit: 1048576,
          },
          { name: 'models/e1', supportedGenerationMethods: ['embedContent'] },
        ],
      });
    expect(
      (await discoverModels({ def: def('google-gemini'), key: 'K' }, f)).map((m) => m.id),
    ).toEqual(['g1']);
  });

  it('accepts a bare array (Together) and sends no auth header without a key (Ollama)', async () => {
    expect(
      (await discoverModels({ def: def('together'), key: 'K' }, () => reply([{ id: 't1' }]))).map(
        (m) => m.id,
      ),
    ).toEqual(['t1']);
    let headers: Record<string, string> | undefined;
    await discoverModels({ def: def('ollama'), baseUrl: 'http://127.0.0.1:11434/v1' }, (_u, i) => {
      headers = i?.headers;
      return reply({ data: [] });
    });
    expect(headers).toEqual({});
  });

  it('turns a rejected key into a short error that never contains the key', async () => {
    const key = 'sk-SECRETSECRETSECRET';
    const f: FetchLike = () =>
      reply({ error: { message: `Incorrect API key provided: ${key}` } }, 401);
    const err = await discoverModels({ def: def('openai'), key }, f).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 401.*rejected/);
    expect((err as Error).message).not.toContain(key);
  });
});

describe('rows', () => {
  const cfg = [
    {
      name: 'anthropic',
      manifest: {
        type: 'anthropic',
        models: [
          { model_id: 'x', name: 'x' },
          { model_id: 'y', name: 'y' },
        ],
      },
    },
    {
      name: 'ollama',
      manifest: {
        type: 'custom',
        base_url: 'http://127.0.0.1:11434/v1',
        models: [{ model_id: 'q', name: 'q' }],
      },
    },
  ];
  it('lists catalog providers then custom ones with connected counts from /models', () => {
    const rows = buildRows(cfg, ['anthropic/x', 'ollama/q']);
    expect(rows.find((r) => r.name === 'anthropic')).toMatchObject({
      connected: true,
      modelCount: 1,
    });
    expect(rows.find((r) => r.name === 'openai')).toMatchObject({
      connected: false,
      modelCount: 0,
    });
    expect(rows.at(-1)).toMatchObject({ name: 'ollama', kind: 'custom', connected: true });
  });
  it('compareServed reports models TrueForge does not serve', () => {
    expect(compareServed(cfg[0]!, ['anthropic/x'])).toEqual({
      expected: 2,
      served: 1,
      missing: ['anthropic/y'],
    });
  });
});

describe('fmtTokens', () => {
  it('formats context sizes', () => {
    expect([8000, 12500, 128000, 200000, 1048576, 1000000].map(fmtTokens)).toEqual([
      '8000',
      '12.5K',
      '128K',
      '200K',
      '1M',
      '1M',
    ]);
  });
});
