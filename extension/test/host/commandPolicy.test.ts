import { describe, expect, it } from 'vitest';
import { checkCommand, hasShellMetachars, matchesAllowlist, tailTruncate, tokenize } from '../../src/host/commandPolicy';

const ALLOW = ['pytest', 'python -c', 'git diff', 'git status', 'flask --help'];

describe('allowlist', () => {
  it('matches by prefix on word boundaries', () => {
    expect(matchesAllowlist('pytest', ALLOW)).toBe(true);
    expect(matchesAllowlist('pytest tests/test_cli.py -q', ALLOW)).toBe(true);
    expect(matchesAllowlist('  git   diff  HEAD ', ALLOW)).toBe(true);
    expect(matchesAllowlist('pytestx', ALLOW)).toBe(false);
    expect(matchesAllowlist('rm -rf /', ALLOW)).toBe(false);
    expect(matchesAllowlist('git push', ALLOW)).toBe(false);
    expect(matchesAllowlist('python script.py', ALLOW)).toBe(false);
  });
  it('an empty allowlist allows nothing', () => {
    expect(matchesAllowlist('pytest', [])).toBe(false);
    expect(matchesAllowlist('pytest', [''])).toBe(false);
  });
});

describe('shell metacharacters', () => {
  it.each(['pytest; rm -rf x', 'pytest && ls', 'pytest | cat', 'pytest > out', 'pytest < in', 'pytest `id`', 'pytest $(id)', 'pytest ${X}', 'pytest\nls'])(
    'rejects %j',
    (c) => {
      expect(hasShellMetachars(c)).toBe(true);
      const r = checkCommand(c, ALLOW);
      expect(r.ok).toBe(false);
    },
  );
  it('accepts plain commands and quoted args', () => {
    const r = checkCommand('python -c "print(1+1)"', ALLOW);
    expect(r).toMatchObject({ ok: true, argv: ['python', '-c', 'print(1+1)'] });
  });
  it('explains refusals', () => {
    const r = checkCommand('curl x', ALLOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not allowed/i);
  });
});

describe('tokenize', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(tokenize(`pytest -k "a b" 'c d'`)).toEqual(['pytest', '-k', 'a b', 'c d']);
    expect(tokenize('a "" b')).toEqual(['a', '', 'b']);
  });
  it('returns undefined on unbalanced quotes', () => {
    expect(tokenize('pytest "oops')).toBeUndefined();
  });
});

describe('tailTruncate', () => {
  it('keeps the end of long output', () => {
    const out = tailTruncate('x'.repeat(100) + 'END', 10);
    expect(out.endsWith('xxxxxxxEND')).toBe(true);
    expect(out).toMatch(/truncated/);
  });
  it('leaves short output alone', () => {
    expect(tailTruncate('ok', 10)).toBe('ok');
  });
});
