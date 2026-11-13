import { useEffect, useRef, useState } from 'react';
import type { LedgerEntry, LedgerSnapshot, PickReason } from '../../../src/shared/types';
import { postToHost } from '../vscode';
import { FileLink, fmtTokens, Icon, IconButton } from './ui';

const MAX_BUDGET = 64000;

export const REASON_LABEL: Record<PickReason, string> = {
  mention: 'mention',
  selection: 'selection',
  symbol: 'symbol',
  keyword: 'keyword',
  graph: 'import',
  testPair: 'test',
  docsPair: 'docs',
  agent: 'agent',
  pinned: 'pinned',
};

export function entryLabel(e: LedgerEntry): string {
  return e.symbol ? `${e.path} › ${e.symbol}` : e.path;
}

export function ReasonChips({ e }: { e: LedgerEntry }) {
  return (
    <span className="chips">
      {e.reasons.map((r, i) => (
        <span key={r.reason + i} className="chip chip-reason" title={r.detail || r.reason} tabIndex={0}>
          {REASON_LABEL[r.reason] ?? r.reason}
        </span>
      ))}
      {e.evicted && <span className="chip chip-reason">evicted</span>}
    </span>
  );
}

function Row({ e }: { e: LedgerEntry }) {
  const label = entryLabel(e);
  const off = !(e.included && !e.evicted);
  return (
    <li className={`ledger-row${off ? ' excluded' : ''}`}>
      <div className="ledger-main">
        <Icon name={e.symbol ? 'symbol-method' : 'file'} className="muted" />
        <FileLink path={e.path} line={e.startLine} className="ellipsis grow" label={label} />
        <span className="muted nowrap small">
          {fmtTokens(e.tokens)} · {e.representation}
        </span>
      </div>
      <div className="ledger-sub">
        <ReasonChips e={e} />
        <span className="row-actions">
          <IconButton
            icon={e.pinned ? 'pinned' : 'pin'}
            pressed={!!e.pinned}
            label={`${e.pinned ? 'Unpin' : 'Pin'} ${label}`}
            title={e.pinned ? 'Unpin' : 'Pin to context'}
            onClick={() => postToHost({ type: 'ledger.pin', id: e.id })}
          />
          <IconButton
            icon="close"
            label={`Evict ${label}`}
            title="Evict from context"
            onClick={() => postToHost({ type: 'ledger.evict', id: e.id })}
          />
        </span>
      </div>
    </li>
  );
}

/** Full ledger: budget slider, every candidate with pin / evict, and the over-budget group. */
export function Ledger({ snapshot, onBudget }: { snapshot: LedgerSnapshot; onBudget: (t: number) => void }) {
  const [budget, setBudget] = useState(snapshot.budgetTokens);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!dirty.current) setBudget(snapshot.budgetTokens);
  }, [snapshot.budgetTokens]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const change = (v: number) => {
    dirty.current = true;
    setBudget(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      postToHost({ type: 'budget.set', tokens: v });
      onBudget(v);
      dirty.current = false;
    }, 250);
  };

  const included = snapshot.entries.filter((e) => e.included && !e.evicted);
  const excluded = snapshot.entries.filter((e) => !(e.included && !e.evicted));

  return (
    <div className="ledger">
      <label className="slider">
        <span>Budget: {budget === 0 ? 'Auto' : fmtTokens(budget)}</span>
        <input
          type="range"
          min={0}
          max={MAX_BUDGET}
          step={1000}
          value={budget}
          aria-valuetext={budget === 0 ? 'Auto' : `${budget} tokens`}
          onChange={(e) => change(Number(e.target.value))}
        />
      </label>
      <div className="muted small">
        {included.length} of {snapshot.candidates} candidates fit the budget
      </div>
      <ul className="ledger-list" aria-label="Included context">
        {included.map((e) => (
          <Row key={e.id} e={e} />
        ))}
      </ul>
      {excluded.length > 0 && (
        <>
          <div className="divider" role="separator">
            <span>Over budget</span>
          </div>
          <ul className="ledger-list" aria-label="Excluded context">
            {excluded.map((e) => (
              <Row key={e.id} e={e} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
