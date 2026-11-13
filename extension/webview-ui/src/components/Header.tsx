import type { State } from '../state';
import { Dot } from './ui';

export function Header({ state, onOpenModels }: { state: State; onOpenModels: () => void }) {
  const conn = state.connection;
  const model = state.models.find((m) => m.name === state.agentModel);
  const health = model?.health ?? 'unknown';
  const connLabel =
    conn.trueforge === 'connected'
      ? 'TrueForge connected'
      : conn.trueforge === 'disconnected'
        ? 'TrueForge disconnected'
        : 'TrueForge status unknown';
  return (
    <header className="app-header">
      <h1>Temper</h1>
      <span title={conn.detail ? `${connLabel}: ${conn.detail}` : connLabel}>
        <Dot tone={conn.trueforge === 'connected' ? 'ok' : conn.trueforge === 'disconnected' ? 'bad' : 'unknown'} label={connLabel} />
      </span>
      <span className="spacer" />
      <button
        className="chip model-chip"
        onClick={onOpenModels}
        aria-label={`Active agent model ${state.agentModel || 'none'}. Open models`}
        title={model?.lastError ?? 'Open models'}
      >
        <Dot tone={health === 'ok' ? 'ok' : health === 'failing' ? 'bad' : 'unknown'} label={`Model health: ${health}`} />
        <span className="ellipsis">{state.agentModel || 'no model'}</span>
      </button>
    </header>
  );
}
