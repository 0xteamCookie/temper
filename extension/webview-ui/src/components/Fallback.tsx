import { useState } from 'react';
import type { ModelInfo } from '../../../src/shared/types';
import { formatPrice } from '../../../src/shared/usage';
import type { SettingsSnapshot } from '../../../src/shared/settings';
import { postToHost } from '../vscode';
import { Group, Help, NumberField, Page, Toggle, update } from './settingsWidgets';
import { HealthPill, Icon, IconButton, Picker, shortModel } from './ui';
import type { PickerOption } from './ui';

const NONE = '\u0000none';

export function FallbackPage({
  models,
  chain,
  settings,
  connected,
  onChain,
}: {
  models: ModelInfo[];
  chain: string[];
  settings: SettingsSnapshot;
  connected: boolean;
  onChain: (c: string[]) => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const byName = new Map(models.map((m) => [m.name, m]));
  const ordered = chain.map((n) => byName.get(n)).filter((m): m is ModelInfo => !!m);
  const rest = models.filter((m) => !chain.includes(m.name));

  const commit = (next: string[]) => {
    onChain(next);
    postToHost({ type: 'models.reorder', chain: next });
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= chain.length || from === to) return;
    const next = chain.slice();
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    commit(next);
  };

  const addOptions: PickerOption[] = rest.length
    ? rest.map((m) => ({
        id: m.name,
        aria: `${m.name}, ${m.provider}`,
        node: (
          <span className="opt-main">
            <span className="ellipsis opt-name">{shortModel(m.name)}</span>
            <span className="ellipsis muted opt-sub">
              {m.provider}
              {m.price ? ` · ${formatPrice(m.price)} per 1M` : ''}
            </span>
          </span>
        ),
      }))
    : [{ id: NONE, node: <span className="muted">Every model is already in the chain</span> }];

  return (
    <Page>
      <Group>
        <Help>
          Temper tries these models in order and switches to the next when one fails before any edit is
          staged.
        </Help>
        {!connected ? (
          <Help>Connect to TrueForge to see its models.</Help>
        ) : (
          <>
            <ul className="model-list" aria-label="Fallback chain">
              {ordered.map((m, i) => (
                <li
                  key={m.name}
                  className={`model-row${dragIdx === i ? ' dragging' : ''}${overIdx === i && dragIdx !== i ? ' over' : ''}`}
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={(e) => {
                    if (dragIdx !== null) {
                      e.preventDefault();
                      setOverIdx(i);
                    }
                  }}
                  onDrop={() => {
                    if (dragIdx !== null) move(dragIdx, i);
                    setDragIdx(null);
                    setOverIdx(null);
                  }}
                  onDragEnd={() => {
                    setDragIdx(null);
                    setOverIdx(null);
                  }}
                >
                  <Icon name="gripper" className="muted grip" />
                  <span className="rank muted" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="model-info">
                    <span className="model-line">
                      <span className="ellipsis model-name" title={m.name}>
                        {shortModel(m.name)}
                      </span>
                      <HealthPill health={m.health} lastError={m.lastError} />
                    </span>
                    <span className="ellipsis muted small">
                      {m.provider}
                      {m.price ? ` · ${formatPrice(m.price)} per 1M` : ''}
                    </span>
                    {m.health === 'failing' && m.lastError && (
                      <span className="ellipsis err-text small" title={m.lastError}>
                        {m.lastError}
                      </span>
                    )}
                  </span>
                  <span className="row-actions">
                    <IconButton icon="arrow-up" label={`Move ${m.name} up`} disabled={i === 0} onClick={() => move(i, i - 1)} />
                    <IconButton
                      icon="arrow-down"
                      label={`Move ${m.name} down`}
                      disabled={i === ordered.length - 1}
                      onClick={() => move(i, i + 1)}
                    />
                    <IconButton
                      icon="close"
                      label={`Remove ${m.name} from the chain`}
                      disabled={ordered.length <= 1}
                      onClick={() => commit(chain.filter((n) => n !== m.name))}
                    />
                  </span>
                </li>
              ))}
              {ordered.length === 0 && <li className="muted small">No models in the chain yet.</li>}
            </ul>
            <div>
              <Picker
                options={addOptions}
                onChoose={(id) => id !== NONE && commit([...chain, id])}
                triggerClass="btn"
                triggerLabel="Add model to the chain"
                listLabel="Models not in the chain"
                disabled={rest.length === 0}
                trigger={
                  <>
                    <Icon name="add" /> Add model
                  </>
                }
              />
            </div>
          </>
        )}
      </Group>
      <Group title="Behaviour">
        <Toggle
          label="Fall back automatically"
          checked={settings.fallback.enabled}
          onChange={(v) => update('models.fallback.enabled', v)}
          help="When off, a failed request stops the run instead of trying the next model."
        />
        <NumberField
          label="Retries on the same model"
          value={settings.fallback.retries}
          min={0}
          max={5}
          help="How many times to retry a model before moving to the next one."
          onCommit={(n) => update('models.fallback.retries', n)}
        />
      </Group>
    </Page>
  );
}
