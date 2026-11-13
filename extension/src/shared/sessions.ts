// Session history contracts shared by the extension host and the webview (no vscode import).
import type { RunEvent } from './types';

/** One TrueForge session as listed in the History view. */
export interface SessionSummary {
  id: string;
  /** Null until titled (Temper titles a session after its first message). */
  title: string | null;
  createdAt: string;
  updatedAt: string;
  turns: number;
  /** Known only for sessions created from an inline spec. */
  model?: string;
}

/** One turn of a loaded session, as the UI replays it: the user's message, then the run's events. */
export interface TranscriptTurn {
  turnId: string;
  user?: string;
  events: RunEvent[];
}
