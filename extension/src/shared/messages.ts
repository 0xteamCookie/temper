// Typed message protocol between the extension host and the webview UI.
import type {
  FileChange,
  HunkDecision,
  LedgerSnapshot,
  ModelInfo,
  RunEvent,
} from './types';
import type { ProviderPanelState } from './providers';
import type { SessionSummary, TranscriptTurn } from './sessions';
import type { SandboxState, ServerInfo, SettingsSnapshot } from './settings';

export interface Mention {
  kind: 'file' | 'symbol';
  value: string; // path or symbol name
}

/** The active editor's selection, pushed to the composer (Claude Code-style context chip). */
export interface EditorSelection {
  path: string; // workspace-relative, forward slashes
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
}

export type ComposerMode = 'agent' | 'edit';

/** Extension host -> webview */
export type HostMessage =
  | { type: 'run.event'; event: RunEvent }
  | { type: 'ledger.update'; snapshot: LedgerSnapshot }
  | { type: 'models.update'; models: ModelInfo[]; chain: string[]; agentModel: string; inlineModel: string }
  | { type: 'review.open'; runId: string; changes: FileChange[] }
  | { type: 'review.closed'; runId: string; applied: number; rejected: number }
  | { type: 'checkpoints.update'; canUndo: boolean; lastLabel?: string }
  | { type: 'mention.suggestions'; query: string; items: Mention[] }
  | { type: 'providers.state'; state: ProviderPanelState }
  | { type: 'connection'; trueforge: 'connected' | 'disconnected'; detail?: string }
  /** Current editor selection (null when there is no non-empty selection in a workspace file). Debounced. */
  | { type: 'editor.selection'; selection: EditorSelection | null }
  /** Focus the composer, optionally pinning a selection and switching mode (from "Add Selection to Chat"). */
  | { type: 'composer.focus'; selection?: EditorSelection; mode?: ComposerMode; text?: string }
  /** A page of the session history (`append` adds to the list already shown). */
  | {
      type: 'history.page';
      sessions: SessionSummary[];
      nextPageToken?: string;
      append: boolean;
      error?: string;
    }
  /** A session's transcript, to replace the chat. `notice` explains anything that could not be restored. */
  | { type: 'session.loaded'; sessionId: string; turns: TranscriptTurn[]; notice?: string }
  | { type: 'session.loadFailed'; sessionId: string; message: string }
  /** The session the next message continues (undefined = a new chat). */
  | { type: 'session.current'; sessionId?: string }
  /** A native view-title command was run (New chat, History, Settings). */
  | { type: 'nav'; to: 'newChat' | 'history' | 'settings' }
  | { type: 'settings.state'; settings: SettingsSnapshot }
  | { type: 'sandbox.state'; state: SandboxState }
  | { type: 'server.info'; server: ServerInfo };

/** Webview -> extension host */
export type WebviewMessage =
  | { type: 'ready' }
  /** mode 'edit' runs an inline edit on `selection` (required for edit); default mode is 'agent'. */
  | { type: 'chat.send'; text: string; mentions: Mention[]; mode?: ComposerMode; selection?: EditorSelection }
  | { type: 'run.cancel' }
  | { type: 'ledger.pin'; id: string }
  | { type: 'ledger.evict'; id: string }
  | { type: 'budget.set'; tokens: number } // 0 = adaptive
  | { type: 'models.reorder'; chain: string[] }
  | { type: 'models.pick'; mode: 'agent' | 'inline'; name: string }
  | { type: 'review.decide'; hunkId: string; decision: HunkDecision }
  | { type: 'review.decideAll'; decision: HunkDecision }
  | { type: 'review.submit'; reason?: string }
  | { type: 'review.openDiff'; path: string }
  | { type: 'undo.last' }
  | { type: 'mention.query'; query: string }
  /** Open a session in the TrueForge UI (default: the current one). */
  | { type: 'openSession'; sessionId?: string }
  | { type: 'history.list'; pageToken?: string }
  | { type: 'session.load'; id: string }
  | { type: 'session.new' }
  /** Providers screen (keys are entered in host-side input boxes, never in the webview). */
  | { type: 'providers.refresh' }
  | { type: 'providers.add'; id: string }
  | { type: 'providers.edit' | 'providers.check' | 'providers.remove'; name: string }
  | { type: 'server.start' | 'server.copyCommand' | 'connection.retry' }
  /** Settings pages. `settings.update` is validated host-side against an allowlist of temper.* keys. */
  | { type: 'settings.refresh' }
  | { type: 'settings.update'; key: string; value: unknown }
  /** Reveal a list setting in settings.json (the panel does not edit allowlists or price overrides). */
  | { type: 'settings.openJson'; key: string }
  | { type: 'sandbox.connect' }
  | { type: 'trueforge.open' }
  /** Open a workspace file in the editor, optionally revealing a 1-based line. */
  | { type: 'open.file'; path: string; line?: number };
