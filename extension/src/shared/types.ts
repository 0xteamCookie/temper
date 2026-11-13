// Shared contracts between Temper's modules. Keep this file dependency-free
// (no vscode import) so it can be used by the extension host, tests, and the
// webview UI alike.

/* ------------------------------------------------------------------ */
/* Run events: normalized view of a TrueForge turn                     */
/* ------------------------------------------------------------------ */

export type RunMode = 'agent' | 'inline';

export type RunEvent =
  | { kind: 'runStart'; runId: string; mode: RunMode; model: string; sessionId: string }
  | { kind: 'text'; runId: string; threadId: string; delta: string }
  | { kind: 'toolCall'; runId: string; threadId: string; id: string; name: string; args: unknown }
  | { kind: 'toolResult'; runId: string; threadId: string; id: string; content: string; isError: boolean }
  | { kind: 'approval'; runId: string; threadId: string; toolCallId: string; name: string; args: unknown }
  | { kind: 'subagent'; runId: string; threadId: string; title: string; phase: 'start' | 'done'; status?: string }
  | { kind: 'compaction'; runId: string; threadId: string; phase: 'start' | 'done' }
  | { kind: 'status'; runId: string; status: 'running' | 'paused' }
  | { kind: 'fallback'; runId: string; from: string; to: string; reason: string }
  | { kind: 'retry'; runId: string; model: string; attempt: number; delayMs: number; reason: string }
  | { kind: 'done'; runId: string; status: 'done' | 'error' | 'cancelled'; message?: string; metrics?: RunMetrics };

/** USD per 1M tokens. All zero = free. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Token usage of one model within a run (a fallback can switch models mid-run). */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface RunMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Per-model breakdown (summed over fallback attempts). */
  usage?: ModelUsage[];
  toolCalls?: number;
  durationMs?: number;
}

/** Classification of a failed turn, used by the model router. */
export type FailureKind =
  | 'unknownModel' // 422 at session create
  | 'unreachable' // "[Model Error] Cannot connect ..."
  | 'auth' // "[Model Error] Request failed (401|403)"
  | 'rateLimit' // 429
  | 'server' // 5xx
  | 'model' // other "[Model Error]"
  | 'mcp' // "[MCP Error]" - our bug, never fall back
  | 'other';

export type ApprovalDecision = { status: 'allow' } | { status: 'deny'; reason: string };

/* ------------------------------------------------------------------ */
/* Changeset / review                                                  */
/* ------------------------------------------------------------------ */

export type ScopeFlag =
  | { kind: 'outsideSelection'; detail: string }
  | { kind: 'outsidePlan'; detail: string }
  | { kind: 'unknownSymbol'; symbols: string[]; suggestions: Record<string, string[]> };

export type HunkDecision = 'pending' | 'accept' | 'reject';

export interface Hunk {
  id: string; // stable within a changeset: `${path}#${index}`
  path: string; // workspace-relative, forward slashes
  oldStart: number; // 1-based
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string; // e.g. "@@ -10,4 +10,6 @@ def get_debug_flag"
  lines: string[]; // unified-diff body lines with ' ', '-', '+' prefixes
  rationale?: string;
  flags: ScopeFlag[];
  decision: HunkDecision;
}

export interface FileChange {
  path: string;
  kind: 'modify' | 'create';
  original: string; // '' for create
  proposed: string;
  hunks: Hunk[];
}

export interface StageResult {
  ok: boolean;
  path: string;
  /** Unified diff of this edit (on success) or an actionable error for the model. */
  message: string;
  matchStrategy?: string; // which fuzzy replacer matched
}

export interface Checkpoint {
  id: string;
  createdAt: number;
  label: string;
  /** Original contents of every file touched, keyed by workspace-relative path. null = file did not exist. */
  originals: Record<string, string | null>;
  appliedHunks: number;
  rejectedHunks: number;
}

/* ------------------------------------------------------------------ */
/* Context ledger                                                      */
/* ------------------------------------------------------------------ */

export type PickReason =
  | 'mention' // @file / @symbol
  | 'selection'
  | 'symbol' // defines/uses a symbol from the task
  | 'keyword' // BM25 hit
  | 'graph' // import/call neighbour of a picked item
  | 'testPair' // test <-> source pairing
  | 'docsPair' // code <-> docs pairing
  | 'agent' // the agent read it via a tool
  | 'pinned';

export interface LedgerEntry {
  id: string; // `${path}` or `${path}#${symbol}`
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  score: number;
  reasons: { reason: PickReason; detail: string }[];
  tokens: number;
  representation: 'full' | 'outline' | 'snippet';
  included: boolean; // within budget
  pinned?: boolean;
  evicted?: boolean;
}

export interface LedgerSnapshot {
  runId: string;
  task: string;
  budgetTokens: number;
  usedTokens: number;
  candidates: number;
  entries: LedgerEntry[];
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

export type ModelHealth = 'unknown' | 'ok' | 'failing';

export interface ModelInfo {
  name: string; // TrueForge model name "<provider>/<alias>"
  provider: string;
  contextLength?: number;
  /** Estimated price from models.dev or a user override; undefined = unknown. */
  price?: ModelPrice;
  health: ModelHealth;
  lastError?: string;
}
