import { describe, expect, it } from 'vitest';
import { COMPATIBLE_PRESETS, CATALOG_PROVIDERS } from '../../src/providers/catalog';
import {
  buildManifest,
  REDACTED_KEY,
  suggestModels,
  toResourceName,
} from '../../src/providers/manifest';

const anthropic = CATALOG_PROVIDERS.find((d) => d.id === 'anthropic')!;
const ollama = COMPATIBLE_PRESETS.find((d) => d.id === 'ollama')!;
const generic = COMPATIBLE_PRESETS.find((d) => d.id === 'compatible')!;

describe('toResourceName', () => {
  it('lowercases and hyphenates', () => {
    expect(toResourceName('Claude Sonnet_4.5')).toBe('claude-sonnet-4-5');
    expect(toResourceName('--x--')).toBe('x');
  });
});

describe('buildManifest', () => {
  it('builds a catalog manifest with auth and default properties', () => {
    const m = buildManifest({
      def: anthropic,
      apiKey: 'k-123',
      models: [{ id: 'claude-sonnet-5-5', context: 200000 }],
    });
    expect(m).toEqual({
      type: 'anthropic',
      auth: { api_key: 'k-123' },
      models: [
        {
          model_id: 'claude-sonnet-5-5',
          name: 'claude-sonnet-5-5',
          properties: { context_length: 200000, max_output_tokens: 8192 },
        },
      ],
    });
  });

  it('catalog properties override discovery; duplicate names get a suffix', () => {
    const m = buildManifest({
      def: anthropic,
      apiKey: 'k',
      models: [{ id: 'a', context: 1 }],
      catalog: [{ model_id: 'a', name: 'shared', properties: { context_length: 999 } }],
    });
    expect(m.models[0]).toMatchObject({ name: 'shared', properties: { context_length: 999 } });
    const dup = buildManifest({
      def: anthropic,
      apiKey: 'k',
      models: [{ id: 'x/y' }, { id: 'x:y' }],
    });
    expect(dup.models.map((x) => x.name)).toEqual(['x-y', 'x-y-2']);
  });

  it('builds a custom manifest with name and trimmed base_url; no auth for keyless servers', () => {
    const m = buildManifest({
      def: ollama,
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1/',
      models: [{ id: 'qwen2.5-coder:7b' }],
    });
    expect(m).toMatchObject({
      type: 'custom',
      name: 'ollama',
      base_url: 'http://127.0.0.1:11434/v1',
    });
    expect('auth' in m).toBe(false);
    expect(m.models[0]!.name).toBe('qwen2-5-coder-7b');
  });

  it('uses the user-chosen name for generic endpoints and requires url and models', () => {
    expect(
      buildManifest({
        def: generic,
        apiKey: 'k',
        name: 'My GW',
        baseUrl: 'https://gw.example/v1',
        models: [{ id: 'm' }],
      }).name,
    ).toBe('my-gw');
    expect(() =>
      buildManifest({ def: generic, apiKey: 'k', name: 'gw', models: [{ id: 'm' }] }),
    ).toThrow(/base URL/);
    expect(() => buildManifest({ def: anthropic, apiKey: 'k', models: [] })).toThrow(
      /at least one/,
    );
  });

  it('keeps the redacted marker on edit and preserves existing model names', () => {
    const m = buildManifest({
      def: anthropic,
      apiKey: REDACTED_KEY,
      models: [{ id: 'claude-sonnet-5-5' }],
      keepNames: new Map([['claude-sonnet-5-5', 'sonnet']]),
    });
    expect(m.auth?.api_key).toBe('***REDACTED***');
    expect(m.models[0]!.name).toBe('sonnet');
  });
});

describe('suggestModels', () => {
  it('preselects tool-capable chat models, catalog-known first, skipping embeddings', () => {
    const picks = suggestModels(
      [
        { id: 'text-embedding-3', context: 8000 },
        { id: 'big-no-tools', context: 1_000_000, tools: false },
        { id: 'known', context: 10 },
        { id: 'unknown-large', context: 500_000 },
      ],
      new Set(['known']),
      2,
    );
    expect([...picks]).toEqual(['known', 'unknown-large']);
  });
});
