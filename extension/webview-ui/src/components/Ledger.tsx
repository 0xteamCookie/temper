import { useEffect, useRef, useState } from 'react';
import type { LedgerEntry, LedgerSnapshot } from '../../../src/shared/types';
import { postToHost } from '../vscode';
import { fmtTokens } from './ui';

const MAX_BUDGET = 64000;

function Row({ e }: { e: LedgerEntry }) {
  const label = e.symbol ? `${e.path} › ${e.symbol}` : e.path;
  const range = e.startLine ? `:${e.startLine}${e.endLine ? `-${e.endLine}` : ''}` : '';
  return (
    <li className={`ledger-row${e.included && !e.evicted ? '' : ' excluded'}`}>
      <div className="ledger-main">
        <span className="ledger-path ellipsis" title={label + range}>
          {label}
        </span>
        <span className="muted nowrap">
          {e.tokens} tok · {e.representation}
        </span>
      </div>
      <div className="ledger-sub">
        <span className="chips">
          {e.reasons.map((r, i) => (
            <span key={r.reason + i} className={`chip reason reason-${r.reason}`} title={r.detail || r.reason} tabIndex={0}>
              {r.reason}
            </span>
          ))}
          {e.evicted && <span className="chip">evicted</span>}
        </span>
        <span className="row-actions">
          <button
            className="icon-btn"
            aria-pressed={!!e.pinned}
            aria-label={`${e.pinned ? 'Unpin' : 'Pin'} ${label}`}
            title={e.pinned ? 'Unpin' : 'Pin'}
            onClick={() => postToHost({ type: 'ledger.pin', id: e.id })}
          >
            {e.pinned ? '★' : '☆'}
          </button>
          <button
            className="icon-btn"
            aria-label={`Evict ${label}`}
            title="Evict from context"
            onClick={() => postToHost({ type: 'ledger.evict', id: e.id })}
          >
            ✕
          </button>
        </span>
      </div>
    </li>
  );
}

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
  const cap = snapshot.budgetTokens || snapshot.usedTokens || 1;
  const pct = Math.min(100, Math.round((snapshot.usedTokens / cap) * 100));

  return (
    <div className="ledger">
      <div className="muted task ellipsis" title={snapshot.task}>
        {snapshot.task}
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-label="Context budget used"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={snapshot.usedTokens}
      >
        <div className={`bar-fill${pct >= 90 ? ' bar-hot' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="bar-label">
        <span>
          {fmtTokens(snapshot.usedTokens)} / {snapshot.budgetTokens ? fmtTokens(snapshot.budgetTokens) : 'auto'} tokens
        </span>
        <span className="muted">
          {included.length} of {snapshot.candidates} candidates
        </span>
      </div>
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
