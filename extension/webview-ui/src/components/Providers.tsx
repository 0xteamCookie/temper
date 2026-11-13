import type { ProviderPanelState, ProviderRow } from '../../../src/shared/providers';
import { postToHost } from '../vscode';
import { Icon, IconButton, Spinner } from './ui';

/** TrueForge unreachable: start it or retry. */
export function ServerDown({ detail, state }: { detail?: string; state: ProviderPanelState }) {
  const r = state.result?.scope === 'server' ? state.result : undefined;
  return (
    <section className="empty-card" aria-labelledby="srv-h">
      <h3 id="srv-h">
        <Icon name="debug-disconnect" /> TrueForge is not reachable
      </h3>
      <p className="muted small help">
        Temper runs its agent on a local TrueForge server and calls models only through it.
        {detail ? ` (${detail})` : ''}
      </p>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => postToHost({ type: 'server.start' })}
        >
          <Icon name="play" /> Start TrueForge
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => postToHost({ type: 'connection.retry' })}
        >
          <Icon name="refresh" /> Retry
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => postToHost({ type: 'server.copyCommand' })}
        >
          <Icon name="copy" /> Copy command
        </button>
      </div>
      {r && (
        <p className={`small ${r.level === 'error' ? 'err-text' : 'muted'}`} role="status">
          {r.text}
          {r.command && (
            <>
              {' '}
              <code>{r.command}</code>
            </>
          )}
        </p>
      )}
    </section>
  );
}

function statusText(r: ProviderRow): string {
  return r.connected
    ? `Connected · ${r.modelCount} model${r.modelCount === 1 ? '' : 's'}`
    : 'Not connected';
}

export function Providers({ state, hasModels }: { state: ProviderPanelState; hasModels: boolean }) {
  const { rows, busy, result, error } = state;
  const r = result && result.scope !== 'server' ? result : undefined;
  return (
    <section aria-labelledby="prov-h" className="providers">
      <h3 id="prov-h">Providers</h3>
      {!hasModels && !error && (
        <p className="empty-card small" role="status">
          <strong>No models yet.</strong> Add a provider below. Keys are typed into a VS Code prompt
          and sent to TrueForge, not stored by Temper.
        </p>
      )}
      {error && (
        <p className="err-text small" role="alert">
          <Icon name="error" /> Could not load providers: {error}
        </p>
      )}
      <ul className="model-list" aria-label="Providers">
        {rows.map((p) => {
          const isBusy = busy === p.name;
          return (
            <li key={`${p.kind}-${p.name}`} className="model-row provider-row">
              <span className="model-info">
                <span className="ellipsis model-name">{p.label}</span>
                <span className={`ellipsis small ${p.connected ? 'ok-text' : 'muted'}`}>
                  <Icon name={p.connected ? 'check' : 'circle-outline'} /> {statusText(p)}
                  {p.baseUrl ? <span className="muted"> · {p.baseUrl}</span> : null}
                </span>
              </span>
              {isBusy ? (
                <Spinner />
              ) : p.connected ? (
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
              ) : (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!!busy}
                  onClick={() => postToHost({ type: 'providers.add', id: p.name })}
                >
                  Add key
                </button>
              )}
            </li>
          );
        })}
        <li className="model-row provider-row">
          <span className="model-info">
            <span className="ellipsis model-name">OpenAI-compatible</span>
            <span className="ellipsis muted small">
              Ollama, LM Studio, OpenRouter, Groq, gateways
            </span>
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!!busy}
            onClick={() => postToHost({ type: 'providers.add', id: 'compatible-pick' })}
          >
            <Icon name="add" /> Add
          </button>
        </li>
      </ul>
      {r && (
        <p className={`small ${r.level === 'error' ? 'err-text' : 'muted'}`} role="status">
          <Icon name={r.level === 'error' ? 'warning' : 'info'} /> {r.text}
        </p>
      )}
    </section>
  );
}
