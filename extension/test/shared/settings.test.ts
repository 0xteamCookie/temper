import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isJsonOnlyKey, SETTING_RULES, validateSetting } from '../../src/shared/settings';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, unknown> } };
};

describe('settings allowlist', () => {
  it('only allows keys that are declared temper.* settings', () => {
    for (const key of Object.keys(SETTING_RULES))
      expect(pkg.contributes.configuration.properties).toHaveProperty(`temper.${key}`);
  });

  it('refuses keys outside the allowlist', () => {
    for (const key of [
      'commands.allowlist',
      'trueforge.baseUrl',
      'trueforge.agent',
      'mcp.port',
      'pricing.overrides',
      '__proto__',
      'toString',
      '',
    ])
      expect(validateSetting(key, 'x').ok).toBe(false);
    expect(validateSetting(undefined, true).ok).toBe(false);
  });

  it('validates booleans, enums and integers', () => {
    expect(validateSetting('pricing.fetch', false)).toEqual({ ok: true, value: false });
    expect(validateSetting('pricing.fetch', 'yes').ok).toBe(false);
    expect(validateSetting('review.mode', 'perEdit')).toEqual({ ok: true, value: 'perEdit' });
    expect(validateSetting('review.mode', 'never').ok).toBe(false);
    expect(validateSetting('context.budgetPercent', 40.9)).toEqual({ ok: true, value: 40 });
    expect(validateSetting('context.budgetPercent', 0).ok).toBe(false);
    expect(validateSetting('context.budgetPercent', 91).ok).toBe(false);
    expect(validateSetting('models.fallback.retries', Number.NaN).ok).toBe(false);
    expect(validateSetting('context.budgetTokens', -1).ok).toBe(false);
  });

  it('trims, dedupes and bounds string lists', () => {
    expect(validateSetting('context.exclude', [' node_modules ', '', 'dist', 'dist'])).toEqual({
      ok: true,
      value: ['node_modules', 'dist'],
    });
    expect(validateSetting('context.exclude', ['a', 3]).ok).toBe(false);
    expect(validateSetting('context.exclude', 'dist').ok).toBe(false);
    expect(validateSetting('context.exclude', ['x'.repeat(201)]).ok).toBe(false);
    expect(validateSetting('context.exclude', Array.from({ length: 101 }, (_, i) => `g${i}`)).ok).toBe(false);
  });

  it('only reveals known list settings in settings.json', () => {
    expect(isJsonOnlyKey('commands.allowlist')).toBe(true);
    expect(isJsonOnlyKey('context.exclude')).toBe(false);
    expect(isJsonOnlyKey(undefined)).toBe(false);
  });
});
