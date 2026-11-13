import { describe, expect, it } from 'vitest';
import snapshot from '../../src/pricing/snapshot.json';
import { normId, resolveContext, resolvePrice, trimModelsDev } from '../../src/pricing/resolve';
import type { PriceIndex } from '../../src/pricing/resolve';
import { PricingService, REFRESH_MS } from '../../src/pricing/service';
import type { PricingIo } from '../../src/pricing/service';

const index: PriceIndex = {
  anthropic: {
    'claude-sonnet-5-5': {
      cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
      limit: { context: 1_000_000, output: 128_000 },
    },
  },
  google: { 'gemini-flash-latest': { cost: { input: 0.75, output: 3.75, cache_read: 0.075 } } },
  'google-vertex': { 'gemini-3.5-flash': { cost: { input: 1.5, output: 9 } } },
  groq: { 'llama-3.3-70b-versatile': { cost: { input: 0.59, output: 0.79 } } },
  openrouter: {
    'qwen/qwen3-coder:free': { cost: { input: 0, output: 0 } },
    'meta-llama/llama-3.3-70b-instruct': { cost: { input: 0.1, output: 0.3 } },
  },
};

describe('normId', () => {
  it('treats dots, dashes and case alike', () => {
    expect(normId('Llama-3.3-70B')).toBe(normId('llama-3-3-70b'));
  });
});

describe('resolvePrice', () => {
  it('maps provider names and keeps cache prices', () => {
    expect(resolvePrice('anthropic/claude-sonnet-5-5', index)).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    });
    expect(resolvePrice('google-gemini/gemini-flash-latest', index)).toEqual({
      input: 0.75,
      output: 3.75,
      cacheRead: 0.075,
    });
  });

  it('matches aliases with dashes for dots, and vertex google/ prefixes', () => {
    expect(resolvePrice('groq/llama-3-3-70b-versatile', index)?.input).toBe(0.59);
    expect(resolvePrice('vertex/google/gemini-3.5-flash', index)?.output).toBe(9);
  });

  it('falls back to a search across providers by model id', () => {
    expect(resolvePrice('truefoundry/claude-sonnet-5-5', index)?.input).toBe(2);
  });

  it('treats ollama and :free models as free', () => {
    expect(resolvePrice('ollama/qwen2.5-coder', index)).toEqual({ input: 0, output: 0 });
    expect(resolvePrice('openrouter/some-model:free', index)).toEqual({ input: 0, output: 0 });
  });

  it('returns undefined (not zero) for unknown models', () => {
    expect(resolvePrice('openrouter/never-heard-of-it', index)).toBeUndefined();
  });

  it('lets overrides win', () => {
    const p = resolvePrice('anthropic/claude-sonnet-5-5', index, {
      'anthropic/claude-sonnet-5-5': { input: 1, output: 2 },
    });
    expect(p).toEqual({ input: 1, output: 2 });
    expect(
      resolvePrice('x/custom', index, { 'x/custom': { input: 3, output: 4, cacheRead: 0.3 } }),
    ).toEqual({ input: 3, output: 4, cacheRead: 0.3 });
  });

  it('reads the context window', () => {
    expect(resolveContext('anthropic/claude-sonnet-5-5', index)).toBe(1_000_000);
    expect(resolveContext('groq/llama-3-3-70b-versatile', index)).toBeUndefined();
  });
});

describe('bundled snapshot', () => {
  it('prices the pinned anthropic models', () => {
    for (const m of ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']) {
      expect(resolvePrice(`anthropic/${m}`, snapshot as PriceIndex)).toBeDefined();
    }
  });
});

describe('trimModelsDev', () => {
  it('keeps only cost and limit numbers', () => {
    const out = trimModelsDev({
      anthropic: {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          a: {
            name: 'A',
            cost: { input: 1, output: 2, tiers: [{ input: 9 }] },
            limit: { context: 10, output: 5 },
            reasoning: true,
          },
          nocost: { name: 'x' },
        },
      },
      empty: { models: {} },
    });
    expect(out).toEqual({
      anthropic: { a: { cost: { input: 1, output: 2 }, limit: { context: 10, output: 5 } } },
    });
  });
});

describe('PricingService', () => {
  function makeIo(over: Partial<PricingIo> = {}) {
    const files = new Map<string, string>();
    let t = 1_000_000_000_000;
    let fetches = 0;
    const io: PricingIo = {
      readFile: async (f) => files.get(f),
      writeFile: async (f, d) => void files.set(f, d),
      fetchJson: async () => {
        fetches++;
        return {
          anthropic: { models: { 'claude-sonnet-5-5': { cost: { input: 99, output: 99 } } } },
        };
      },
      now: () => t,
      ...over,
    };
    return { io, files, tick: (ms: number) => (t += ms), fetches: () => fetches };
  }

  it('fetches once, caches, and refreshes only after 24 h', async () => {
    const h = makeIo();
    const svc = new PricingService('/store', () => ({ fetch: true, overrides: {} }), h.io);
    expect(await svc.init()).toBe(true);
    expect(svc.priceOf('anthropic/claude-sonnet-5-5')?.input).toBe(99);
    expect(h.files.size).toBe(1);
    await svc.refreshIfStale();
    expect(h.fetches()).toBe(1);
    h.tick(REFRESH_MS + 1);
    await svc.refreshIfStale();
    expect(h.fetches()).toBe(2);

    // A new service reads the cache and does not fetch again.
    const svc2 = new PricingService('/store', () => ({ fetch: true, overrides: {} }), h.io);
    await svc2.init();
    expect(h.fetches()).toBe(2);
    expect(svc2.priceOf('anthropic/claude-sonnet-5-5')?.input).toBe(99);
  });

  it('never fetches when temper.pricing.fetch is off and uses the snapshot', async () => {
    const h = makeIo();
    const svc = new PricingService('/store', () => ({ fetch: false, overrides: {} }), h.io);
    await svc.init();
    expect(h.fetches()).toBe(0);
    expect(svc.priceOf('anthropic/claude-sonnet-5-5')?.input).toBe(2);
  });

  it('keeps working when the fetch fails', async () => {
    const h = makeIo({ fetchJson: async () => Promise.reject(new Error('offline')) });
    const svc = new PricingService('/store', () => ({ fetch: true, overrides: {} }), h.io);
    expect(await svc.init()).toBe(false);
    expect(svc.priceOf('anthropic/claude-haiku-5-5')).toBeDefined();
  });

  it('enriches models with price and a fallback context size', () => {
    const svc = new PricingService('/store', () => ({ fetch: false, overrides: {} }), makeIo().io);
    const [m] = svc.enrich([
      { name: 'anthropic/claude-sonnet-5-5', provider: 'anthropic', health: 'ok' },
    ]);
    expect(m?.price?.output).toBe(10);
    expect(m?.contextLength).toBe(1_000_000);
  });
});
