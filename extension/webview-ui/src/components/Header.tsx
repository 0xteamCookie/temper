import type { State } from '../state';
import { postToHost } from '../vscode';
import { Icon, Spinner } from './ui';

/**
 * Connection status, shown only when something is wrong: nothing while connected. The view title and its
 * actions (New chat, History, Undo, Open session, Settings) live in VS Code's native title bar.
 */
export function ConnectionBanner({ state }: { state: State }) {
  const conn = state.connection;
  if (conn.trueforge === 'connected') return null;
  const result = state.providers.result?.scope === 'server' ? state.providers.result : undefined;
  if (conn.trueforge === 'unknown') {
    return (
      <div className="conn-banner" role="status">
        <Spinner />
        <span className="grow">Connecting to TrueForge…</span>
      </div>
    );
  }
  return (
    <div className="conn-banner conn-banner-bad" role="alert">
      <Icon name="debug-disconnect" className="bad-text" />
      <div className="grow conn-text">
        <strong>TrueForge is not reachable.</strong>{' '}
        <span className="muted">
          {conn.detail ?? 'Temper runs its agent on a local TrueForge server.'}
        </span>
        {result && (
          <div className={`small ${result.level === 'error' ? 'err-text' : 'muted'}`}>
            {result.text}
            {result.command && (
              <>
                {' '}
                <code>{result.command}</code>
              </>
            )}
          </div>
        )}
      </div>
      <div className="conn-actions">
        <button type="button" className="btn btn-sm btn-primary" onClick={() => postToHost({ type: 'server.start' })}>
          <Icon name="play" /> Start TrueForge
        </button>
        <button type="button" className="btn btn-sm" onClick={() => postToHost({ type: 'connection.retry' })}>
          <Icon name="refresh" /> Retry
        </button>
      </div>
    </div>
  );
}

/** Sub-view header (Review, History, Settings): a back button and the current title. */
export function SubHeader({
  backLabel,
  title,
  onBack,
}: {
  /** What the back button returns to ("Conversation", "Settings"). */
  backLabel: string;
  title: string;
  onBack: () => void;
}) {
  return (
    <div className="sub-header">
      <button type="button" className="back-btn" onClick={onBack} aria-label={`Back to ${backLabel}`}>
        <span className="codicon codicon-arrow-left" aria-hidden="true" />
        {backLabel}
      </button>
      <Icon name="chevron-right" className="muted" />
      <h1 className="sub-title ellipsis">{title}</h1>
    </div>
  );
}
