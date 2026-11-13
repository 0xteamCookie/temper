import { ALL_PROVIDER_DEFS, COMPATIBLE_PRESETS } from '../../../src/providers/catalog';
import type { ProviderPanelState } from '../../../src/shared/providers';
import { postToHost } from '../vscode';
import { Group, Help, Page } from './settingsWidgets';
import { Icon, IconButton, Picker, Spinner } from './ui';
import type { PickerOption } from './ui';

const presetIds = new Set(COMPATIBLE_PRESETS.map((d) => d.id));

export function ProvidersPage({
  state,
  connected,
  hasModels,
}: {
  state: ProviderPanelState;
  connected: boolean;
  hasModels: boolean;
}) {
  const { rows, busy, result, error } = state;
  const r = result && result.scope !== 'server' ? result : undefined;
  const have = rows.filter((p) => p.connected);
  const haveNames = new Set(have.map((p) => p.name));

  const addable = ALL_PROVIDER_DEFS.filter((d) => d.id === 'compatible' || !haveNames.has(d.name));
  const options: PickerOption[] = addable.map((d, i) => ({
    id: d.id,
    aria: `${d.label}${d.baseUrl ? `, ${d.baseUrl}` : ''}`,
    separatorBefore: presetIds.has(d.id) && !presetIds.has(addable[i - 1]?.id ?? ''),
    node: (
      <span className="opt-main">
        <span className="ellipsis opt-name">{d.label}</span>
        {d.kind === 'custom' && d.baseUrl && <span className="ellipsis muted opt-sub">{d.baseUrl}</span>}
      </span>
    ),
  }));

  return (
    <Page>
      <Group title="Connected">
        {!connected ? (
          <Help>Providers are managed in TrueForge. Connect to TrueForge to see and change them.</Help>
        ) : (
          <>
            {error && (
              <p className="err-text small" role="alert">
                <Icon name="error" /> Could not load providers: {error}
              </p>
            )}
            {have.length === 0 && !error && (
              <p className="empty-card small" role="status">
                <strong>{hasModels ? 'No providers listed.' : 'No models yet.'}</strong> Add a provider to
                get models. Keys are typed into a VS Code prompt and sent to TrueForge, not stored by
                Temper.
              </p>
            )}
            <ul className="model-list" aria-label="Connected providers">
              {have.map((p) => (
                <li key={`${p.kind}-${p.name}`} className="model-row provider-row">
                  <span className="model-info">
                    <span className="ellipsis model-name">{p.label}</span>
                    <span className="ellipsis muted small" title={p.baseUrl}>
                      {p.modelCount} model{p.modelCount === 1 ? '' : 's'}
                      {p.baseUrl ? ` · ${p.baseUrl}` : ''}
                    </span>
                  </span>
                  {busy === p.name ? (
                    <Spinner />
                  ) : (
                    <span className="row-actions">
                      <IconButton
                        icon="edit"
                        label={`Edit ${p.label}`}
                        disabled={!!busy}
                        onClick={() => postToHost({ type: 'providers.edit', name: p.name })}
                      />
                      <IconButton
                        icon="pulse"
                        label={`Check ${p.label}`}
                        disabled={!!busy}
                        onClick={() => postToHost({ type: 'providers.check', name: p.name })}
                      />
                      <IconButton
                        icon="trash"
                        label={`Remove ${p.label}`}
                        disabled={!!busy}
                        onClick={() => postToHost({ type: 'providers.remove', name: p.name })}
                      />
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {busy && !have.some((p) => p.name === busy) && (
              <p className="muted small" role="status">
                <Spinner /> Working on {busy}…
              </p>
            )}
            <div>
              <Picker
                options={options}
                onChoose={(id) => postToHost({ type: 'providers.add', id })}
                triggerClass="btn"
                triggerLabel="Add provider"
                listLabel="Available providers"
                disabled={!!busy}
                trigger={
                  <>
                    <Icon name="add" /> Add provider
                  </>
                }
              />
            </div>
          </>
        )}
        {r && (
          <p className={`small ${r.level === 'error' ? 'err-text' : 'muted'}`} role="status">
            <Icon name={r.level === 'error' ? 'warning' : 'info'} /> {r.text}
          </p>
        )}
      </Group>
    </Page>
  );
}
