import { isRunning } from '../state';
import type { State, View } from '../state';
import { postToHost } from '../vscode';
import { IconButton } from './ui';

export function Header({
  state,
  onToggleModels,
  onToggleHistory,
  onNewChat,
}: {
  state: State;
  onToggleModels: () => void;
  onToggleHistory: () => void;
  onNewChat: () => void;
}) {
  const busy = isRunning(state);
  const conn = state.connection;
  const tone = conn.trueforge === 'connected' ? 'ok' : conn.trueforge === 'disconnected' ? 'bad' : 'unknown';
  const word = conn.trueforge === 'connected' ? 'TrueForge' : conn.trueforge === 'disconnected' ? 'Offline' : 'Connecting';
  const full =
    conn.trueforge === 'connected'
      ? 'TrueForge connected'
      : conn.trueforge === 'disconnected'
        ? 'TrueForge disconnected'
        : 'Connecting to TrueForge';
  const tip = conn.detail ? `${full}: ${conn.detail}` : full;
  return (
    <header className="app-header">
      <h1>Temper</h1>
      <span className={`pill pill-${tone}`} title={tip} aria-label={tip}>
        <span className="dot" aria-hidden="true" />
        <span className="ellipsis">{word}</span>
      </span>
      <span className="spacer" />
      <IconButton
        icon="add"
        label="New chat"
        title={busy ? 'Stop the current run before starting a new chat' : 'New chat'}
        disabled={busy}
        onClick={onNewChat}
      />
      <IconButton
        icon="history"
        label="History"
        pressed={state.view === 'history'}
        onClick={onToggleHistory}
      />
      <IconButton
        icon="discard"
        label={state.canUndo ? `Undo: ${state.undoLabel ?? 'last change'}` : 'Undo last change'}
        disabled={!state.canUndo}
        onClick={() => postToHost({ type: 'undo.last' })}
      />
      <IconButton icon="link-external" label="Open TrueForge session" onClick={() => postToHost({ type: 'openSession' })} />
      <IconButton icon="settings-gear" label="Models" pressed={state.view === 'models'} onClick={onToggleModels} />
    </header>
  );
}

export function SubHeader({ view, onBack }: { view: Exclude<View, 'conversation'>; onBack: () => void }) {
  return (
    <div className="sub-header">
      <button type="button" className="back-btn" onClick={onBack} aria-label="Back to conversation">
        <span className="codicon codicon-arrow-left" aria-hidden="true" />
        Conversation
      </button>
      <span className="sub-title">
        {view === 'review' ? 'Review' : view === 'history' ? 'History' : 'Models'}
      </span>
    </div>
  );
}
