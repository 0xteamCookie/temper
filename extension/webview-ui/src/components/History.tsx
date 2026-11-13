import type { SessionSummary } from '../../../src/shared/sessions';
import type { HistoryState } from '../state';
import { postToHost } from '../vscode';
import { Icon, IconButton, shortModel, Spinner } from './ui';

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} d ago`;
  return new Date(t).toLocaleDateString();
}

function Row({ s, current, busy }: { s: SessionSummary; current: boolean; busy: boolean }) {
  const title = s.title?.trim() || 'Untitled session';
  const meta = [
    relativeTime(s.updatedAt),
    `${s.turns} ${s.turns === 1 ? 'turn' : 'turns'}`,
    s.model ? shortModel(s.model) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className={`session-row${current ? ' current' : ''}`}>
      <button
        type="button"
        className="session-open"
        disabled={busy}
        aria-current={current ? 'true' : undefined}
        title={current ? 'Current session' : 'Open this session'}
        onClick={() => postToHost({ type: 'session.load', id: s.id })}
      >
        <span className="ellipsis session-title">{title}</span>
        <span className="ellipsis muted session-meta">{meta}</span>
      </button>
      {current && <span className="pill pill-ok session-current">Current</span>}
      <IconButton
        icon="link-external"
        label={`Open "${title}" in TrueForge`}
        onClick={() => postToHost({ type: 'openSession', sessionId: s.id })}
      />
    </li>
  );
}

export function History({
  history,
  sessionId,
  running,
  onMore,
}: {
  history: HistoryState;
  sessionId?: string;
  running: boolean;
  onMore: () => void;
}) {
  const { sessions, loading, error, loadError, next } = history;
  return (
    <div className="history">
      {running && (
        <div className="callout" role="status">
          <Icon name="info" />
          <span>A run is in progress. Stop it before opening another session.</span>
        </div>
      )}
      {loadError && (
        <div className="callout callout-bad" role="alert">
          <Icon name="error" />
          <span>Could not open that session: {loadError}</span>
        </div>
      )}
      {error && (
        <div className="callout callout-bad" role="alert">
          <Icon name="error" />
          <span>Could not load the history: {error}</span>
        </div>
      )}
      {sessions.length > 0 && (
        <ul className="session-list" aria-label="Past sessions">
          {sessions.map((s) => (
            <Row key={s.id} s={s} current={s.id === sessionId} busy={running} />
          ))}
        </ul>
      )}
      {loading && (
        <div className="notice" role="status">
          <Spinner />
          <span>Loading sessions</span>
        </div>
      )}
      {!loading && !error && sessions.length === 0 && (
        <p className="muted">
          No sessions yet. Your Temper chats show up here, including ones continued in TrueForge.
        </p>
      )}
      {!loading && next && (
        <button type="button" className="btn btn-sm session-more" onClick={onMore}>
          Load more
        </button>
      )}
    </div>
  );
}
