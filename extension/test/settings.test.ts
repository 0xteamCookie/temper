import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, readSettings } from '../src/config/settings';
import type { ConfigReader } from '../src/config/settings';

const empty: ConfigReader = { get: () => undefined };

function readerFrom(values: Record<string, unknown>): ConfigReader {
  return { get: <T>(key: string) => values[key] as T | undefined };
}

describe('readSettings', () => {
  it('returns documented defaults when nothing is configured', () => {
    expect(readSettings(empty)).toEqual(DEFAULT_SETTINGS);
  });

  it('applies user values and clamps out-of-range numbers', () => {
    const settings = readSettings(
      readerFrom({
        'models.chain': ['a/b', 'c/d'],
        'models.fallback.retries': 99,
        'context.budgetPercent': 0,
        'guards.scopeFence': 'block',
      }),
    );
    expect(settings.models.chain).toEqual(['a/b', 'c/d']);
    expect(settings.models.fallback.retries).toBe(5);
    expect(settings.context.budgetPercent).toBe(1);
    expect(settings.guards.scopeFence).toBe('block');
  });

  it('falls back to defaults for invalid enum values', () => {
    const settings = readSettings(readerFrom({ 'review.mode': 'nonsense' }));
    expect(settings.review.mode).toBe('endOfRun');
  });

  it('matches the defaults declared in package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default: unknown }> } };
    };
    const declared = Object.fromEntries(
      Object.entries(pkg.contributes.configuration.properties).map(([key, def]) => [
        key.replace(/^temper\./, ''),
        def.default,
      ]),
    );
    const viaReader = readerFrom(declared);
    expect(readSettings(viaReader)).toEqual(DEFAULT_SETTINGS);
    expect(Object.keys(declared)).toHaveLength(20);
  });
});
