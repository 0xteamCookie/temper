// Settings contracts shared by the host, tests and the webview. Dependency-free.
// The webview may change only the keys listed in SETTING_RULES; values are validated host-side.

export type ScopeFence = 'flagAndReject' | 'block' | 'warn' | 'off';
export type SymbolCheck = 'bounceThenWarn' | 'bounce' | 'warn' | 'off';
export type ReviewModeSetting = 'endOfRun' | 'perEdit';

/** The temper.* values the Settings pages show. */
export interface SettingsSnapshot {
  fallback: { enabled: boolean; retries: number };
  context: { budgetTokens: number; budgetPercent: number; exclude: string[] };
  review: { mode: ReviewModeSetting };
  guards: { scopeFence: ScopeFence; symbolCheck: SymbolCheck };
  commands: { allowlist: string[]; runInShadowWorktree: boolean };
  pricing: { fetch: boolean; overrideCount: number };
}

/** Shown until the host sends the real values (matches the package.json defaults). */
export const DEFAULT_SNAPSHOT: SettingsSnapshot = {
  fallback: { enabled: true, retries: 1 },
  context: { budgetTokens: 0, budgetPercent: 25, exclude: ['.git', 'node_modules', 'dist', 'out', '.venv', '__pycache__'] },
  review: { mode: 'endOfRun' },
  guards: { scopeFence: 'flagAndReject', symbolCheck: 'bounceThenWarn' },
  commands: { allowlist: ['pytest', 'python -c', 'git diff', 'git status', 'flask --help'], runInShadowWorktree: true },
  pricing: { fetch: true, overrideCount: 0 },
};

export interface ServerInfo {
  baseUrl: string;
  /** From TrueForge /healthz; undefined while unknown. */
  version?: string;
}

/** Sandbox (Daytona) status as reported by TrueForge. No key ever reaches the webview. */
export interface SandboxState {
  loaded: boolean;
  /** A Daytona key is saved in TrueForge. */
  connected: boolean;
  /** TrueForge can run sandboxes (its environment image is built). */
  ready?: boolean;
  /** Default sandbox environment build status and TrueForge's reason, e.g. a Daytona permission error. */
  environment?: { status: string; reason?: string };
  skills?: { enabled: boolean; reason?: string };
  busy: boolean;
  result?: { level: 'info' | 'error'; text: string };
  /** Status could not be loaded. */
  error?: string;
}

export const ENUMS = {
  'review.mode': ['endOfRun', 'perEdit'],
  'guards.scopeFence': ['flagAndReject', 'block', 'warn', 'off'],
  'guards.symbolCheck': ['bounceThenWarn', 'bounce', 'warn', 'off'],
} as const;

type Rule =
  | { kind: 'bool' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'strings'; maxItems: number; maxLen: number };

/** Keys (relative to the `temper` section) the webview may write. Everything else is refused. */
export const SETTING_RULES = {
  'models.fallback.enabled': { kind: 'bool' },
  'models.fallback.retries': { kind: 'int', min: 0, max: 5 },
  'context.budgetTokens': { kind: 'int', min: 0, max: 10_000_000 },
  'context.budgetPercent': { kind: 'int', min: 1, max: 90 },
  'context.exclude': { kind: 'strings', maxItems: 100, maxLen: 200 },
  'review.mode': { kind: 'enum', values: ENUMS['review.mode'] },
  'guards.scopeFence': { kind: 'enum', values: ENUMS['guards.scopeFence'] },
  'guards.symbolCheck': { kind: 'enum', values: ENUMS['guards.symbolCheck'] },
  'commands.runInShadowWorktree': { kind: 'bool' },
  'pricing.fetch': { kind: 'bool' },
} as const satisfies Record<string, Rule>;

export type SettingKey = keyof typeof SETTING_RULES;

/** Keys the webview may ask the host to reveal in settings.json (lists it does not edit itself). */
export const JSON_ONLY_KEYS = ['commands.allowlist', 'pricing.overrides', 'trueforge.baseUrl'] as const;
export type JsonOnlyKey = (typeof JSON_ONLY_KEYS)[number];

export function isJsonOnlyKey(key: unknown): key is JsonOnlyKey {
  return typeof key === 'string' && (JSON_ONLY_KEYS as readonly string[]).includes(key);
}

export type SettingCheck = { ok: true; value: unknown } | { ok: false; reason: string };

/** Validate (and normalise) a settings update from the webview. */
export function validateSetting(key: unknown, value: unknown): SettingCheck {
  if (typeof key !== 'string' || !Object.hasOwn(SETTING_RULES, key))
    return { ok: false, reason: `Setting "${String(key)}" cannot be changed from the panel.` };
  const rule: Rule = SETTING_RULES[key as SettingKey];
  switch (rule.kind) {
    case 'bool':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: 'Expected true or false.' };
    case 'int': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'Expected a number.' };
      const n = Math.trunc(value);
      return n >= rule.min && n <= rule.max
        ? { ok: true, value: n }
        : { ok: false, reason: `Expected a number from ${rule.min} to ${rule.max}.` };
    }
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value)
        ? { ok: true, value }
        : { ok: false, reason: `Expected one of: ${rule.values.join(', ')}.` };
    case 'strings': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
        return { ok: false, reason: 'Expected a list of text values.' };
      const seen = new Set<string>();
      const out: string[] = [];
      for (const raw of value as string[]) {
        const s = raw.trim();
        if (!s || seen.has(s)) continue;
        if (s.length > rule.maxLen) return { ok: false, reason: `Entries are limited to ${rule.maxLen} characters.` };
        seen.add(s);
        out.push(s);
      }
      return out.length <= rule.maxItems
        ? { ok: true, value: out }
        : { ok: false, reason: `At most ${rule.maxItems} entries.` };
    }
  }
}
