import { useState } from 'react';
import type { LedgerSnapshot } from '../../../src/shared/types';
import { entryLabel, Ledger, ReasonChips } from './Ledger';
import { FileLink, fmtTokens, Icon } from './ui';

/** Per-run Context card: top ledger entries, expandable to the full ledger. */
export function ContextCard({
  snapshot,
  live,
  onBudget,
}: {
  snapshot: LedgerSnapshot;
  live: boolean;
  onBudget: (t: number) => void;
}) {
  // Open while the run is live; collapses when it ends unless the user chose otherwise.
  const [manual, setManual] = useState<boolean | undefined>(undefined);
  const [all, setAll] = useState(false);
  const open = manual ?? live;

  const included = snapshot.entries.filter((e) => e.included && !e.evicted);
  const files = new Set(included.map((e) => e.path)).size;
  const cap = snapshot.budgetTokens || snapshot.usedTokens || 1;
  const pct = Math.min(100, Math.round((snapshot.usedTokens / cap) * 100));
  const hot = pct >= 90;
  const summary = `${files} file${files === 1 ? '' : 's'} · ${fmtTokens(snapshot.usedTokens)} / ${
    snapshot.budgetTokens ? fmtTokens(snapshot.budgetTokens) : 'auto'
  }`;

  return (
    <section className="ctx-card" aria-label="Context">
      <button type="button" className="ctx-head" aria-expanded={open} onClick={() => setManual(!open)}>
        <Icon name="library" />
        <span className="ctx-title">Context</span>
        <span className="muted ellipsis">{summary}</span>
        {hot && (
          <span className="chip chip-warn" title="Context budget almost full">
            <Icon name="warning" />
            full
          </span>
        )}
        <span className="spacer" />
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
      </button>
      <div
        className="bar"
        role="progressbar"
        aria-label="Context budget used"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={snapshot.usedTokens}
      >
        <div className={`bar-fill${hot ? ' bar-hot' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      {open && (
        <div className="ctx-body">
          {snapshot.task && (
            <div className="muted small ellipsis" title={snapshot.task}>
              {snapshot.task}
            </div>
          )}
          {!all && (
            <ul className="ledger-list" aria-label="Top context entries">
              {included.slice(0, 4).map((e) => (
                <li key={e.id} className="ledger-row">
                  <div className="ledger-main">
                    <Icon name={e.symbol ? 'symbol-method' : 'file'} className="muted" />
                    <FileLink path={e.path} line={e.startLine} className="ellipsis grow" label={entryLabel(e)} />
                  </div>
                  <div className="ledger-sub">
                    <ReasonChips e={e} />
                  </div>
                </li>
              ))}
              {included.length === 0 && <li className="muted small">Nothing selected yet.</li>}
            </ul>
          )}
          {all && <Ledger snapshot={snapshot} onBudget={onBudget} />}
          {(snapshot.entries.length > 4 || all) && (
            <button type="button" className="link-btn" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? 'Show less' : `Show all ${snapshot.entries.length} · budget`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
