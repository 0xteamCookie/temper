import { describe, expect, it } from 'vitest';
import { safeError, scrubSecrets } from '../../src/providers/scrub';

describe('scrubSecrets', () => {
  it('removes the known key verbatim wherever it appears', () => {
    const key = 'abc123SECRETvalue';
    expect(scrubSecrets(`failed for ${key} and again ${key}`, [key])).toBe(
      'failed for *** and again ***',
    );
  });

  it('removes credential-shaped strings even when the key is unknown', () => {
    const out = scrubSecrets(
      'Authorization: Bearer sk-ant-api03-ABCDEFGHIJKL; url https://x/v1/models?key=AIzaSyA1234567890abcdefghijk&x=1; x-api-key: hunter2hunter2; gsk_ABCDEFGHIJ12',
    );
    expect(out).not.toMatch(/sk-ant|AIzaSy|hunter2|gsk_/);
    expect(out).toContain('x=1');
  });

  it('leaves ordinary text and short secrets alone', () => {
    expect(scrubSecrets('HTTP 401 from api.openai.com', ['ab'])).toBe(
      'HTTP 401 from api.openai.com',
    );
  });
});

describe('safeError', () => {
  it('scrubs and truncates thrown values', () => {
    const e = new Error(`bad key sk-ABCDEFGHIJKLMNOP ${'x'.repeat(500)}`);
    const out = safeError(e, ['sk-ABCDEFGHIJKLMNOP']);
    expect(out).not.toContain('sk-ABCDEFGHIJKLMNOP');
    expect(out.length).toBeLessThanOrEqual(300);
    expect(safeError('plain')).toBe('plain');
  });
});
