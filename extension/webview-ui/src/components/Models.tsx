import { useState } from 'react';
import type { ModelInfo } from '../../../src/shared/types';
import { postToHost } from '../vscode';
import { Dot } from './ui';

export function Models({
  models,
  chain,
  agentModel,
  inlineModel,
  onChain,
  onPick,
}: {
  models: ModelInfo[];
  chain: string[];
  agentModel: string;
  inlineModel: string;
  onChain: (c: string[]) => void;
  onPick: (mode: 'agent' | 'inline', name: string) => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const byName = new Map(models.map((m) => [m.name, m]));
  const ordered = chain.map((n) => byName.get(n)).filter((m): m is ModelInfo => !!m);
  const rest = models.filter((m) => !chain.includes(m.name));

  const move = (from: number, to: number) => {
    if (to < 0 || to >= chain.length || from === to) return;
    const next = chain.slice();
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    onChain(next);
    postToHost({ type: 'models.reorder', chain: next });
  };

  const row = (m: ModelInfo, idx: number | null) => (
    <li
      key={m.name}
      className={`model-row${dragIdx === idx && idx !== null ? ' dragging' : ''}`}
      draggable={idx !== null}
      onDragStart={() => idx !== null && setDragIdx(idx)}
      onDragOver={(e) => idx !== null && dragIdx !== null && e.preventDefault()}
      onDrop={() => {
        if (idx !== null && dragIdx !== null) move(dragIdx, idx);
        setDragIdx(null);
      }}
      onDragEnd={() => setDragIdx(null)}
    >
      <Dot
        tone={m.health === 'ok' ? 'ok' : m.health === 'failing' ? 'bad' : 'unknown'}
        label={m.lastError ? `${m.health}: ${m.lastError}` : `Health: ${m.health}`}
      />
      <span className="ellipsis model-name" title={m.lastError ?? m.name}>
        {idx !== null && <span className="muted">{idx + 1}. </span>}
        {m.name}
      </span>
      {idx !== null && (
        <span className="row-actions">
          <button className="icon-btn" aria-label={`Move ${m.name} up`} disabled={idx === 0} onClick={() => move(idx, idx - 1)}>
            ↑
          </button>
          <button
            className="icon-btn"
            aria-label={`Move ${m.name} down`}
            disabled={idx === chain.length - 1}
            onClick={() => move(idx, idx + 1)}
          >
            ↓
          </button>
        </span>
      )}
    </li>
  );

  const select = (mode: 'agent' | 'inline', value: string, label: string) => (
    <label className="field">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => {
          onPick(mode, e.target.value);
          postToHost({ type: 'models.pick', mode, name: e.target.value });
        }}
      >
        {!models.some((m) => m.name === value) && <option value={value}>{value || '—'}</option>}
        {models.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="models">
      <div className="muted small">Fallback chain (first is primary). Drag or use arrows to reorder.</div>
      <ul className="model-list" aria-label="Fallback chain">
        {ordered.map((m, i) => row(m, i))}
      </ul>
      {rest.length > 0 && (
        <>
          <div className="muted small">Not in chain</div>
          <ul className="model-list">{rest.map((m) => row(m, null))}</ul>
        </>
      )}
      {select('agent', agentModel, 'Agent model')}
      {select('inline', inlineModel, 'Inline model')}
      <button className="btn" onClick={() => postToHost({ type: 'openSession' })}>
        Open TrueForge session
      </button>
    </div>
  );
}
