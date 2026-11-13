// Price resolution: TrueForge model name ("provider/model") -> price per 1M tokens. Pure, no I/O.
import type { ModelPrice } from '../shared/types';

/** The trimmed models.dev shape we keep: only cost and limit per model. */
export interface PriceEntry {
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
}
export type PriceIndex = Record<string, Record<string, PriceEntry>>;

export type PriceOverrides = Record<
  string,
  { input: number; output: number; cacheRead?: number; cacheWrite?: number }
>;

/** TrueForge provider name -> models.dev provider id. Unlisted names are tried as-is. */
export const PROVIDER_MAP: Record<string, string> = {
  anthropic: 'anthropic',
  openrouter: 'openrouter',
  'google-gemini': 'google',
  google: 'google',
  groq: 'groq',
  vertex: 'google-vertex',
  openai: 'openai',
  mistral: 'mistral',
  deepseek: 'deepseek',
  xai: 'xai',
};

/** Local runtimes: always free. */
const FREE_PROVIDERS = new Set(['ollama', 'lmstudio', 'llamacpp', 'vllm']);

/** Preferred order for the cross-provider fallback search (first-party before resellers). */
const SEARCH_ORDER = [
  'anthropic',
  'openai',
  'google',
  'google-vertex',
  'mistral',
  'deepseek',
  'xai',
  'groq',
  'openrouter',
];

/** "Llama-3.3-70B" and "llama-3-3-70b" compare equal: lowercase, runs of non-alphanumerics become "-". */
export function normId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function splitModelName(name: string): { provider: string; model: string } {
  const i = name.indexOf('/');
  return i < 0
    ? { provider: '', model: name }
    : { provider: name.slice(0, i), model: name.slice(i + 1) };
}

function toPrice(e: PriceEntry): ModelPrice | undefined {
  const c = e.cost;
  if (!c || typeof c.input !== 'number' || typeof c.output !== 'number') return undefined;
  return {
    input: c.input,
    output: c.output,
    ...(typeof c.cache_read === 'number' ? { cacheRead: c.cache_read } : {}),
    ...(typeof c.cache_write === 'number' ? { cacheWrite: c.cache_write } : {}),
  };
}

const FREE: ModelPrice = { input: 0, output: 0 };

function findIn(
  models: Record<string, PriceEntry> | undefined,
  candidates: string[],
): PriceEntry | undefined {
  if (!models) return undefined;
  const byNorm = new Map(Object.keys(models).map((k) => [normId(k), k]));
  for (const c of candidates) {
    const key = byNorm.get(normId(c));
    if (key) return models[key];
  }
  return undefined;
}

/** Look up the entry (price and limits) for a TrueForge model name, or undefined when unknown. */
export function findEntry(name: string, index: PriceIndex): PriceEntry | undefined {
  const { provider, model } = splitModelName(name);
  // "google/gemini-3.5-flash" (vertex) also matches a bare "gemini-3.5-flash"; ":free" variants fall back to the base id.
  const tail = model.slice(model.lastIndexOf('/') + 1);
  const candidates = [
    ...new Set([model, tail, model.replace(/:free$/, ''), tail.replace(/:free$/, '')]),
  ];
  const pid = PROVIDER_MAP[provider] ?? provider;
  const direct = findIn(index[pid], candidates);
  if (direct) return direct;
  for (const p of [...SEARCH_ORDER, ...Object.keys(index)]) {
    if (p === pid) continue;
    const hit = findIn(index[p], candidates);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Resolve the price of a TrueForge model name. Order: user override, local provider (free),
 * ":free" suffix (free), models.dev lookup. Unknown models return undefined (shown as "—", never $0).
 */
export function resolvePrice(
  name: string,
  index: PriceIndex,
  overrides: PriceOverrides = {},
): ModelPrice | undefined {
  const o = overrides[name];
  if (o && typeof o.input === 'number' && typeof o.output === 'number') {
    return {
      input: o.input,
      output: o.output,
      ...(typeof o.cacheRead === 'number' ? { cacheRead: o.cacheRead } : {}),
      ...(typeof o.cacheWrite === 'number' ? { cacheWrite: o.cacheWrite } : {}),
    };
  }
  const { provider, model } = splitModelName(name);
  if (FREE_PROVIDERS.has(provider)) return FREE;
  const entry = findEntry(name, index);
  const price = entry ? toPrice(entry) : undefined;
  if (price) return price;
  if (model.endsWith(':free')) return FREE;
  return undefined;
}

/** Context window from the index, used when TrueForge does not report one. */
export function resolveContext(name: string, index: PriceIndex): number | undefined {
  const c = findEntry(name, index)?.limit?.context;
  return typeof c === 'number' && c > 0 ? c : undefined;
}

const COST_KEYS = ['input', 'output', 'cache_read', 'cache_write'];
const LIMIT_KEYS = ['context', 'output'];

function pickNums<T extends object>(o: T, keys: string[]): T {
  const r: Record<string, number> = {};
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === 'number') r[k] = v;
  }
  return r as T;
}

/** Keep only cost and limit per model, dropping everything else in the ~6 MB models.dev payload. */
export function trimModelsDev(raw: unknown): PriceIndex {
  const out: PriceIndex = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [pid, prov] of Object.entries(raw as Record<string, unknown>)) {
    const models = (prov as { models?: Record<string, PriceEntry> } | null)?.models;
    if (!models || typeof models !== 'object') continue;
    const kept: Record<string, PriceEntry> = {};
    for (const [mid, m] of Object.entries(models)) {
      if (!m || typeof m !== 'object' || (!m.cost && !m.limit)) continue;
      kept[mid] = {
        ...(m.cost ? { cost: pickNums(m.cost, COST_KEYS) } : {}),
        ...(m.limit ? { limit: pickNums(m.limit, LIMIT_KEYS) } : {}),
      };
    }
    if (Object.keys(kept).length > 0) out[pid] = kept;
  }
  return out;
}
