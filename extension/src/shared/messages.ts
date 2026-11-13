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

/** Extension host -> webview */
export type HostMessage =
  | { type: 'run.event'; event: RunEvent }
  | { type: 'ledger.update'; snapshot: LedgerSnapshot }
  | { type: 'models.update'; models: ModelInfo[]; chain: string[]; agentModel: string; inlineModel: string }
  | { type: 'review.open'; runId: string; changes: FileChange[] }
  | { type: 'review.closed'; runId: string; applied: number; rejected: number }
  | { type: 'checkpoints.update'; canUndo: boolean; lastLabel?: string }
  | { type: 'mention.suggestions'; query: string; items: Mention[] }
  | { type: 'connection'; trueforge: 'connected' | 'disconnected'; detail?: string };

/** Webview -> extension host */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'chat.send'; text: string; mentions: Mention[] }
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
  | { type: 'openSession' };
