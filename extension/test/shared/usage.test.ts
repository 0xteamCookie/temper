import { describe, expect, it } from 'vitest';
import { fmtTokens } from '../../src/shared/format';
import {
  computeCost,
  formatCost,
  formatPrice,
  mergeUsage,
  sessionUsage,
} from '../../src/shared/usage';
import type { ModelPrice } from '../../src/shared/types';

const sonnet: ModelPrice = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };

describe('computeCost', () => {
  it('charges input and output per 1M tokens', () => {
    expect(
      computeCost({ model: 'm', inputTokens: 1_000_000, outputTokens: 100_000 }, sonnet),
    ).toBeCloseTo(3);
  });

  it('prices cached tokens at the cache rate and subtracts them from input', () => {
    const c = computeCost(
      {
        model: 'm',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 800_000,
        cacheWriteTokens: 100_000,
      },
      sonnet,
    );
    // 100k plain * 2 + 800k * 0.1 + 100k * 2.5 = 0.2 + 0.08 + 0.25
    expect(c).toBeCloseTo(0.53);
  });

  it('treats input as exclusive of cache when cache exceeds input', () => {
    const c = computeCost(
      { model: 'm', inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 9_000 },
      sonnet,
    );
    expect(c).toBeCloseTo((1_000 * 2 + 9_000 * 0.1) / 1e6);
  });

  it('falls back to the input price when cache prices are missing', () => {
    expect(
      computeCost(
        { model: 'm', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 500_000 },
        { input: 1, output: 1 },
      ),
    ).toBeCloseTo(1);
  });
});

describe('sessionUsage', () => {
  const prices: Record<string, ModelPrice> = {
    a: { input: 1, output: 2 },
    local: { input: 0, output: 0 },
  };
  const priceOf = (m: string) => prices[m];

  it('sums per model across runs and fallbacks', () => {
    const s = sessionUsage(
      [
        { usage: [{ model: 'a', inputTokens: 1_000_000, outputTokens: 0 }] },
        {
          usage: [
            { model: 'a', inputTokens: 0, outputTokens: 1_000_000 },
            { model: 'b', inputTokens: 5, outputTokens: 5 },
          ],
        },
      ],
      priceOf,
    );
    expect(s.inputTokens).toBe(1_000_005);
    expect(s.outputTokens).toBe(1_000_005);
    expect(s.costUsd).toBeCloseTo(3);
    expect(s.partial).toBe(true);
    expect(formatCost(s)).toBe('$3.00+');
  });

  it('attributes plain metrics to the fallback model', () => {
    const s = sessionUsage([{ inputTokens: 1_000_000, outputTokens: 0 }], priceOf, 'a');
    expect(s.costUsd).toBeCloseTo(1);
    expect(s.partial).toBe(false);
  });

  it('reports unknown as a dash and free as free', () => {
    expect(formatCost(sessionUsage([{ inputTokens: 5, outputTokens: 5 }], priceOf, 'zzz'))).toBe(
      '—',
    );
    expect(formatCost(sessionUsage([{ inputTokens: 5, outputTokens: 5 }], priceOf, 'local'))).toBe(
      'free',
    );
  });

  it('merges usage per model', () => {
    expect(
      mergeUsage([
        { model: 'a', inputTokens: 1, outputTokens: 2 },
        { model: 'a', inputTokens: 3, outputTokens: 4 },
      ]),
    ).toEqual([
      {
        model: 'a',
        inputTokens: 4,
        outputTokens: 6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    ]);
  });
});

describe('formatting', () => {
  it('formats cost', () => {
    const f = (costUsd: number) => formatCost({ costUsd, free: false, partial: false });
    expect(f(0.004)).toBe('< $0.01');
    expect(f(0.03)).toBe('$0.03');
    expect(f(12.34)).toBe('$12.3');
    expect(f(124.6)).toBe('$125');
  });

  it('formats price per 1M and tokens', () => {
    expect(formatPrice({ input: 2, output: 10 })).toBe('$2 / $10');
    expect(formatPrice({ input: 0.25, output: 1.5 })).toBe('$0.25 / $1.5');
    expect(formatPrice({ input: 0, output: 0 })).toBe('free');
    expect(fmtTokens(12400)).toBe('12.4K');
  });
});
