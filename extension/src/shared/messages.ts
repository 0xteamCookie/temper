// Typed message protocol between the extension host and the webview UI.
import type {
  FileChange,
  HunkDecision,
  LedgerSnapshot,
  ModelInfo,
  RunEvent,
} from './types';

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
  | { type: 'connection'; trueforge: 'connected' | 'disconnected'; detail?: string }
  /** Current editor selection (null when there is no non-empty selection in a workspace file). Debounced. */
  | { type: 'editor.selection'; selection: EditorSelection | null }
  /** Focus the composer, optionally pinning a selection and switching mode (from "Add Selection to Chat"). */
  | { type: 'composer.focus'; selection?: EditorSelection; mode?: ComposerMode; text?: string };

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
  | { type: 'openSession' }
  /** Open a workspace file in the editor, optionally revealing a 1-based line. */
  | { type: 'open.file'; path: string; line?: number };
