import { useState } from 'react';
import type { ModelInfo } from '../../../src/shared/types';
import { fmtTokens } from '../../../src/shared/format';
import { formatPrice } from '../../../src/shared/usage';
import { postToHost } from '../vscode';
import { HealthPill, Icon, IconButton, ModelPicker, shortModel } from './ui';

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
  const [overIdx, setOverIdx] = useState<number | null>(null);
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

  const pick = (mode: 'agent' | 'inline') => (name: string) => {
    onPick(mode, name);
    postToHost({ type: 'models.pick', mode, name });
  };

  const row = (m: ModelInfo, idx: number | null) => (
    <li
      key={m.name}
      className={`model-row${dragIdx === idx && idx !== null ? ' dragging' : ''}${overIdx === idx && idx !== null && dragIdx !== idx ? ' over' : ''}`}
      draggable={idx !== null}
      onDragStart={() => idx !== null && setDragIdx(idx)}
      onDragOver={(e) => {
        if (idx !== null && dragIdx !== null) {
          e.preventDefault();
          setOverIdx(idx);
        }
      }}
      onDrop={() => {
        if (idx !== null && dragIdx !== null) move(dragIdx, idx);
        setDragIdx(null);
        setOverIdx(null);
      }}
      onDragEnd={() => {
        setDragIdx(null);
        setOverIdx(null);
      }}
    >
      {idx !== null ? <Icon name="gripper" className="muted grip" /> : <span className="grip" />}
      {idx !== null && <span className="rank muted">{idx + 1}</span>}
      <span className="model-info">
        <span className="ellipsis model-name" title={m.name}>
          {shortModel(m.name)}
        </span>
        <span className="ellipsis muted small">
          {m.provider}
          {m.contextLength ? ` · ${fmtTokens(m.contextLength)} ctx` : ''}
          {m.price ? ` · ${formatPrice(m.price)} per 1M` : ''}
          {m.health === 'failing' && m.lastError ? ` · ${m.lastError}` : ''}
        </span>
      </span>
      <HealthPill health={m.health} lastError={m.lastError} />
      {idx !== null && (
        <span className="row-actions">
          <IconButton icon="arrow-up" label={`Move ${m.name} up`} disabled={idx === 0} onClick={() => move(idx, idx - 1)} />
          <IconButton icon="arrow-down" label={`Move ${m.name} down`} disabled={idx === chain.length - 1} onClick={() => move(idx, idx + 1)} />
        </span>
      )}
    </li>
  );

  return (
    <div className="models">
      <div className="field">
        <span className="field-label">Agent model</span>
        <ModelPicker variant="field" label="Agent model" models={models} value={agentModel} onPick={pick('agent')} />
      </div>
      <div className="field">
        <span className="field-label">Inline edit model</span>
        <ModelPicker variant="field" label="Inline edit model" models={models} value={inlineModel} onPick={pick('inline')} />
      </div>
      <h3>Fallback chain</h3>
      <p className="muted small help">
        Temper tries these in order and switches automatically when a model fails before any edit is staged.
      </p>
      <ul className="model-list" aria-label="Fallback chain">
        {ordered.map((m, i) => row(m, i))}
        {ordered.length === 0 && <li className="muted small">No models in the chain yet.</li>}
      </ul>
      {rest.length > 0 && (
        <>
          <h3>Not in chain</h3>
          <ul className="model-list" aria-label="Models not in the chain">
            {rest.map((m) => row(m, null))}
          </ul>
        </>
      )}
    </div>
  );
}
