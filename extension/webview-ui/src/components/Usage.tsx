import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { fmtTokens } from '../../../src/shared/format';
import type { ModelInfo, ModelPrice } from '../../../src/shared/types';
import { formatCost, sessionUsage, usageOf } from '../../../src/shared/usage';
import type { PriceLookup, UsageSummary } from '../../../src/shared/usage';
import type { ChatItem, RunItem } from '../state';
import { shortModel } from './ui';

const PriceContext = createContext<PriceLookup>(() => undefined);

/** Gives usage components the model prices the host attached to `models.update`. */
export function PriceProvider({ models, children }: { models: ModelInfo[]; children: ReactNode }) {
  const lookup = useMemo<PriceLookup>(() => {
    const m = new Map<string, ModelPrice | undefined>(models.map((x) => [x.name, x.price]));
    return (name) => m.get(name);
  }, [models]);
  return <PriceContext.Provider value={lookup}>{children}</PriceContext.Provider>;
}

const ESTIMATE_NOTE =
  'Estimated from models.dev list prices or your temper.pricing.overrides setting. Actual billing may differ. A dash means the price is unknown.';

function costText(s: UsageSummary): string {
  const c = formatCost(s);
  return c === 'free' || c === '—' ? c : `≈ ${c}`;
}

function line(s: UsageSummary): string[] {
  return [`${fmtTokens(s.inputTokens)} in`, `${fmtTokens(s.outputTokens)} out`, costText(s)];
}

/** `12.4k in · 1.8k out · ≈ $0.03 · claude-sonnet-5-5` for one finished run. */
export function RunUsage({ run }: { run: RunItem }) {
  const priceOf = useContext(PriceContext);
  const m = run.metrics;
  if (!m || (m.inputTokens == null && m.outputTokens == null && !m.usage?.length)) return null;
  const s = sessionUsage([m], priceOf, run.model);
  const models = s.models.length > 0 ? s.models : run.model ? [run.model] : [];
  const cache = [
    m.cacheReadTokens ? `${m.cacheReadTokens.toLocaleString()} cache read` : '',
    m.cacheWriteTokens ? `${m.cacheWriteTokens.toLocaleString()} cache write` : '',
    m.reasoningTokens ? `${m.reasoningTokens.toLocaleString()} reasoning` : '',
  ].filter(Boolean);
  const tip = [
    `${(m.inputTokens ?? s.inputTokens).toLocaleString()} input, ${(m.outputTokens ?? s.outputTokens).toLocaleString()} output tokens`,
    ...cache,
    ESTIMATE_NOTE,
  ].join('\n');
  return (
    <div className="muted small usage-line" title={tip}>
      {[...line(s), models.map(shortModel).join(' + ')].filter(Boolean).join(' · ')}
    </div>
  );
}

/** Session total, one muted line above the composer. Renders nothing until a run reports usage. */
export function SessionUsage({ items }: { items: ChatItem[] }) {
  const priceOf = useContext(PriceContext);
  const s = useMemo(() => {
    // Runs without a per-model breakdown are attributed to the model the run started on.
    const runs = items
      .flatMap((i) => (i.kind === 'run' ? [{ usage: usageOf(i.metrics, i.model) }] : []))
      .filter((r) => r.usage.length > 0);
    return runs.length ? sessionUsage(runs, priceOf) : undefined;
  }, [items, priceOf]);
  if (!s) return null;
  return (
    <div className="muted small usage-bar" title={`Session total.\n${ESTIMATE_NOTE}`}>
      <span>Session</span>
      <span aria-hidden="true">{'·'}</span>
      <span>{line(s).join(' · ')}</span>
    </div>
  );
}
