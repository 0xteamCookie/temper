// Keep API keys out of every string Temper can display or log. Pure; no vscode imports.

const REDACTED = '***';

const PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\b(?:sk|rk|pk|gsk|fw|xai|nvapi)[-_][A-Za-z0-9_-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi,
  /((?:x-api-key|x-goog-api-key|authorization|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
];

/** Replace the known secrets verbatim, then anything shaped like a credential. */
export function scrubSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join(REDACTED);
  }
  for (const re of PATTERNS) {
    out = out.replace(re, (m, p1) =>
      typeof p1 === 'string' && m.startsWith(p1) ? `${p1}${REDACTED}` : REDACTED,
    );
  }
  return out;
}

/** A short, key-free message for any thrown value. */
export function safeError(e: unknown, secrets: readonly (string | undefined)[] = []): string {
  const raw = e instanceof Error ? e.message : String(e);
  return scrubSecrets(raw, secrets).slice(0, 300);
}
