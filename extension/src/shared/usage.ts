// Token usage and cost: pure functions shared by the host, the webview and tests (no vscode import).
import type { ModelPrice, ModelUsage, RunMetrics } from './types';

export type PriceLookup = (model: string) => ModelPrice | undefined;

export function isFree(p: ModelPrice): boolean {
  return p.input === 0 && p.output === 0 && !p.cacheRead && !p.cacheWrite;
}

/**
 * Estimated USD cost of one model's usage. Prices are USD per 1M tokens.
 *
 *   cost = (input - cacheRead - cacheWrite) * in
 *        + cacheRead * cacheReadPrice + cacheWrite * cacheWritePrice
 *        + output * out                       (all / 1e6)
 *
 * TrueForge's `input_tokens` is treated as the TOTAL prompt size, cached tokens included, so cached
 * tokens are subtracted from the full-rate bucket. If the cached counts exceed the input count the
 * provider reported input EXCLUDING cache (Anthropic style) and the full input is billed at the
 * input rate. Missing cache prices fall back to the input price. Reasoning tokens are already part
 * of output tokens and are not billed again.
 */
export function computeCost(u: ModelUsage, p: ModelPrice): number {
  const read = u.cacheReadTokens ?? 0;
  const write = u.cacheWriteTokens ?? 0;
  const cached = read + write;
  const plain = cached <= u.inputTokens ? u.inputTokens - cached : u.inputTokens;
  const usd =
    plain * p.input +
    read * (p.cacheRead ?? p.input) +
    write * (p.cacheWrite ?? p.input) +
    u.outputTokens * p.output;
  return usd / 1e6;
}

/** Merge entries for the same model (several attempts or turns). */
export function mergeUsage(list: ModelUsage[]): ModelUsage[] {
  const by = new Map<string, ModelUsage>();
  for (const u of list) {
    const cur = by.get(u.model);
    if (!cur) {
      by.set(u.model, { ...u });
      continue;
    }
    cur.inputTokens += u.inputTokens;
    cur.outputTokens += u.outputTokens;
    cur.cacheReadTokens = (cur.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
    cur.cacheWriteTokens = (cur.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    cur.reasoningTokens = (cur.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0);
  }
  return [...by.values()];
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  /** Sum over the models that have a known price; undefined when none do. */
  costUsd?: number;
  /** True when every model with usage is free (cost 0 or local). */
  free: boolean;
  /** True when at least one model with usage has no known price (the cost is a lower bound). */
  partial: boolean;
  models: string[];
}

/** Usage entries of a run; old/partial metrics without `usage` are attributed to `fallbackModel`. */
export function usageOf(m: RunMetrics | undefined, fallbackModel?: string): ModelUsage[] {
  if (!m) return [];
  if (m.usage && m.usage.length > 0) return m.usage;
  if (m.inputTokens == null && m.outputTokens == null) return [];
  return [
    {
      model: fallbackModel ?? '',
      inputTokens: m.inputTokens ?? 0,
      outputTokens: m.outputTokens ?? 0,
      cacheReadTokens: m.cacheReadTokens,
      cacheWriteTokens: m.cacheWriteTokens,
      reasoningTokens: m.reasoningTokens,
    },
  ];
}

/** Total tokens and estimated cost across runs, summed per model. Also used by the History view. */
export function sessionUsage(
  runs: RunMetrics[],
  priceOf: PriceLookup,
  fallbackModel?: string,
): UsageSummary {
  const merged = mergeUsage(runs.flatMap((m) => usageOf(m, fallbackModel)));
  let costUsd: number | undefined;
  let partial = false;
  let allFree = merged.length > 0;
  for (const u of merged) {
    const p = u.model ? priceOf(u.model) : undefined;
    if (!p) {
      partial = true;
      allFree = false;
      continue;
    }
    costUsd = (costUsd ?? 0) + computeCost(u, p);
    if (!isFree(p)) allFree = false;
  }
  return {
    inputTokens: merged.reduce((s, u) => s + u.inputTokens, 0),
    outputTokens: merged.reduce((s, u) => s + u.outputTokens, 0),
    ...(costUsd !== undefined ? { costUsd } : {}),
    free: allFree,
    partial,
    models: merged.map((u) => u.model).filter(Boolean),
  };
}

/** "free", "—" (unknown), "< $0.01", "$0.03", "$12.5", "$124"; a trailing "+" marks a lower bound. */
export function formatCost(s: Pick<UsageSummary, 'costUsd' | 'free' | 'partial'>): string {
  if (s.free) return 'free';
  if (s.costUsd === undefined) return '—';
  const plus = s.partial ? '+' : '';
  const c = s.costUsd;
  if (c < 0.01) return `< $0.01${plus}`;
  if (c < 10) return `$${c.toFixed(2)}${plus}`;
  return `$${c.toFixed(c < 100 ? 1 : 0)}${plus}`;
}

/** USD per 1M tokens: "$3", "$0.25", "$1.5". */
export function formatPerMillion(n: number): string {
  if (n === 0) return '$0';
  const s = n >= 10 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, '');
  return `$${s}`;
}

/** "$2 / $10" (input / output per 1M), or "free". */
export function formatPrice(p: ModelPrice): string {
  return isFree(p) ? 'free' : `${formatPerMillion(p.input)} / ${formatPerMillion(p.output)}`;
}
