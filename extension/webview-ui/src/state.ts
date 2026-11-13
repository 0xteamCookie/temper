import type { ComposerMode, EditorSelection, Mention, HostMessage } from '../../src/shared/messages';
import type {
  FileChange,
  HunkDecision,
  LedgerSnapshot,
  ModelInfo,
  RunEvent,
  RunMetrics,
} from '../../src/shared/types';
import type { ProviderPanelState } from '../../src/shared/providers';
import type { SessionSummary, TranscriptTurn } from '../../src/shared/sessions';

export type RunStatus = 'running' | 'paused' | 'done' | 'error' | 'cancelled';

export type Block =
  | { type: 'text'; key: string; threadId: string; parent?: string; text: string }
  | {
      type: 'tool';
      key: string;
      threadId: string;
      parent?: string;
      id: string;
      name: string;
      args: unknown;
      pending: boolean;
      isError?: boolean;
      content?: string;
    }
  | { type: 'approval'; key: string; threadId: string; parent?: string; name: string; args: unknown }
  | {
      type: 'subagent';
      key: string;
      threadId: string;
      parent?: string;
      title: string;
      phase: 'start' | 'done';
      status?: string;
    }
  | { type: 'compaction'; key: string; threadId: string; parent?: string; phase: 'start' | 'done' }
  | {
      type: 'banner';
      key: string;
      parent?: undefined;
      tone: 'warn' | 'info';
      kind: 'fallback' | 'retry';
      /** fallback: failed model; retry: model being retried */
      from: string;
      to?: string;
      reason: string;
      attempt?: number;
      delayMs?: number;
    };

export interface RunItem {
  kind: 'run';
  runId: string;
  model: string;
  mode: string;
  status: RunStatus;
  message?: string;
  metrics?: RunMetrics;
  mainThread?: string;
  startedAt: number;
  /** Set when the review for this run closes. */
  applied?: { applied: number; rejected: number; files: number };
  blocks: Block[];
}

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
  mentions: Mention[];
  mode?: ComposerMode;
  selection?: EditorSelection;
}

export type ChatItem = RunItem | UserItem;

export interface ReviewState {
  runId: string;
  changes: FileChange[];
}

export type View = 'conversation' | 'review' | 'models' | 'history';

export interface HistoryState {
  sessions: SessionSummary[];
  next?: string;
  loading: boolean;
  error?: string;
  /** Set when opening a session failed. */
  loadError?: string;
}

export interface State {
  view: View;
  /** Active editor selection pushed by the host (null = none). */
  selection: EditorSelection | null;
  /** Composer focus request; `nonce` changes on every request so the composer can react. */
  focus?: { nonce: number; selection?: EditorSelection; mode?: ComposerMode; text?: string };
  connection: { trueforge: 'connected' | 'disconnected' | 'unknown'; detail?: string };
  items: ChatItem[];
  ledger?: LedgerSnapshot;
  models: ModelInfo[];
  chain: string[];
  agentModel: string;
  inlineModel: string;
  providers: ProviderPanelState;
  review?: ReviewState;
  canUndo: boolean;
  undoLabel?: string;
  suggestions?: { query: string; items: Mention[] };
  /** The TrueForge session the next message continues (undefined = a new chat). */
  sessionId?: string;
  /** Shown above the chat after loading a session that could not be fully restored. */
  notice?: string;
  history: HistoryState;
  seq: number;
}

export const initialState: State = {
  view: 'conversation',
  selection: null,
  connection: { trueforge: 'unknown' },
  items: [],
  models: [],
  chain: [],
  agentModel: '',
  inlineModel: '',
  providers: { rows: [], busy: null },
  canUndo: false,
  history: { sessions: [], loading: false },
  seq: 0,
};

export type Action =
  | { t: 'host'; m: HostMessage }
  | { t: 'userSend'; text: string; mentions: Mention[]; mode?: ComposerMode; selection?: EditorSelection }
  | { t: 'view'; view: View }
  | { t: 'fill'; text: string }
  | { t: 'reset' }
  /** Clear the chat for a new session (the host forgets the current one). */
  | { t: 'newChat' }
  | { t: 'historyLoading' }
  | { t: 'decide'; hunkIds: string[]; decision: HunkDecision }
  | { t: 'decideAll'; decision: HunkDecision }
  | { t: 'clearSuggestions' }
  | { t: 'localChain'; chain: string[] }
  | { t: 'localPick'; mode: 'agent' | 'inline'; name: string }
  | { t: 'localBudget'; tokens: number };

function emptyRun(runId: string): RunItem {
  return { kind: 'run', runId, model: '', mode: 'agent', status: 'running', startedAt: Date.now(), blocks: [] };
}

function updateRun(items: ChatItem[], runId: string, fn: (r: RunItem) => RunItem): ChatItem[] {
  const idx = items.findIndex((i) => i.kind === 'run' && i.runId === runId);
  if (idx < 0) return [...items, fn(emptyRun(runId))];
  const copy = items.slice();
  copy[idx] = fn(copy[idx] as RunItem);
  return copy;
}

/** Which open subagent (if any) a non-main-thread event nests under. */
function parentFor(run: RunItem, threadId: string): string | undefined {
  if (run.mainThread === undefined || threadId === run.mainThread) return undefined;
  for (let i = run.blocks.length - 1; i >= 0; i--) {
    const b = run.blocks[i]!;
    if (b.type === 'subagent' && (b.threadId === threadId || b.phase === 'start')) return b.key;
  }
  return undefined;
}

function applyRunEvent(run: RunItem, e: RunEvent, seq: number): RunItem {
  const key = `b${seq}`;
  const withThread = (threadId: string): RunItem =>
    run.mainThread === undefined ? { ...run, mainThread: threadId } : run;
  switch (e.kind) {
    case 'runStart':
      return { ...run, model: e.model, mode: e.mode, status: 'running', startedAt: Date.now() };
    case 'text': {
      const r = withThread(e.threadId);
      const parent = parentFor(r, e.threadId);
      const last = r.blocks[r.blocks.length - 1];
      if (last && last.type === 'text' && last.threadId === e.threadId && last.parent === parent) {
        const blocks = r.blocks.slice(0, -1);
        blocks.push({ ...last, text: last.text + e.delta });
        return { ...r, blocks };
      }
      return { ...r, blocks: [...r.blocks, { type: 'text', key, threadId: e.threadId, parent, text: e.delta }] };
    }
    case 'toolCall': {
      const r = withThread(e.threadId);
      return {
        ...r,
        blocks: [
          ...r.blocks,
          {
            type: 'tool',
            key,
            threadId: e.threadId,
            parent: parentFor(r, e.threadId),
            id: e.id,
            name: e.name,
            args: e.args,
            pending: true,
          },
        ],
      };
    }
    case 'toolResult':
      return {
        ...run,
        blocks: run.blocks.map((b) =>
          b.type === 'tool' && b.id === e.id
            ? { ...b, pending: false, isError: e.isError, content: e.content }
            : b,
        ),
      };
    case 'approval': {
      const r = withThread(e.threadId);
      return {
        ...r,
        blocks: [
          ...r.blocks,
          { type: 'approval', key, threadId: e.threadId, parent: parentFor(r, e.threadId), name: e.name, args: e.args },
        ],
      };
    }
    case 'subagent': {
      if (e.phase === 'start') {
        const r = withThread(e.threadId);
        return {
          ...r,
          blocks: [
            ...r.blocks,
            { type: 'subagent', key, threadId: e.threadId, parent: undefined, title: e.title, phase: 'start' },
          ],
        };
      }
      let done = false;
      const blocks = run.blocks.slice();
      for (let i = blocks.length - 1; i >= 0 && !done; i--) {
        const b = blocks[i]!;
        if (b.type === 'subagent' && b.phase === 'start' && (b.title === e.title || b.threadId === e.threadId)) {
          blocks[i] = { ...b, phase: 'done', status: e.status };
          done = true;
        }
      }
      return { ...run, blocks };
    }
    case 'compaction': {
      const r = withThread(e.threadId);
      if (e.phase === 'done') {
        const i = r.blocks.map((b) => b.type === 'compaction' && b.phase === 'start').lastIndexOf(true);
        if (i >= 0) {
          const blocks = r.blocks.slice();
          blocks[i] = { ...(blocks[i] as Extract<Block, { type: 'compaction' }>), phase: 'done' };
          return { ...r, blocks };
        }
      }
      return {
        ...r,
        blocks: [...r.blocks, { type: 'compaction', key, threadId: e.threadId, parent: parentFor(r, e.threadId), phase: e.phase }],
      };
    }
    case 'status':
      return { ...run, status: e.status };
    case 'fallback':
      return {
        ...run,
        model: e.to,
        blocks: [
          ...run.blocks,
          { type: 'banner', key, tone: 'warn', kind: 'fallback', from: e.from, to: e.to, reason: e.reason },
        ],
      };
    case 'retry':
      return {
        ...run,
        blocks: [
          ...run.blocks,
          { type: 'banner', key, tone: 'info', kind: 'retry', from: e.model, reason: e.reason, attempt: e.attempt, delayMs: e.delayMs },
        ],
      };
    case 'done':
      return { ...run, status: e.status, message: e.message, metrics: e.metrics };
  }
}

function setDecisions(review: ReviewState, ids: Set<string> | 'all', decision: HunkDecision): ReviewState {
  return {
    ...review,
    changes: review.changes.map((c) => ({
      ...c,
      hunks: c.hunks.map((h) => (ids === 'all' || ids.has(h.id) ? { ...h, decision } : h)),
    })),
  };
}

export function reducer(state: State, a: Action): State {
  switch (a.t) {
    case 'userSend':
      return {
        ...state,
        notice: undefined,
        seq: state.seq + 1,
        items: [
          ...state.items,
          { kind: 'user', id: `u${state.seq}`, text: a.text, mentions: a.mentions, mode: a.mode, selection: a.selection },
        ],
      };
    case 'view':
      return { ...state, view: a.view };
    case 'fill':
      return { ...state, focus: { nonce: (state.focus?.nonce ?? 0) + 1, text: a.text } };
    case 'reset':
      return {
        ...initialState,
        connection: state.connection,
        models: state.models,
        chain: state.chain,
        agentModel: state.agentModel,
        inlineModel: state.inlineModel,
        providers: state.providers,
        selection: state.selection,
      };
    case 'newChat':
      return {
        ...reducer(state, { t: 'reset' }),
        canUndo: state.canUndo,
        undoLabel: state.undoLabel,
        history: state.history,
      };
    case 'historyLoading':
      return {
        ...state,
        history: { ...state.history, loading: true, error: undefined, loadError: undefined },
      };
    case 'decide':
      return state.review
        ? { ...state, review: setDecisions(state.review, new Set(a.hunkIds), a.decision) }
        : state;
    case 'decideAll':
      return state.review ? { ...state, review: setDecisions(state.review, 'all', a.decision) } : state;
    case 'clearSuggestions':
      return { ...state, suggestions: undefined };
    case 'localChain':
      return { ...state, chain: a.chain };
    case 'localPick':
      return a.mode === 'agent' ? { ...state, agentModel: a.name } : { ...state, inlineModel: a.name };
    case 'localBudget':
      return state.ledger ? { ...state, ledger: { ...state.ledger, budgetTokens: a.tokens } } : state;
    case 'host':
      return reduceHost(state, a.m);
  }
}

function reduceHost(state: State, m: HostMessage): State {
  switch (m.type) {
    case 'run.event': {
      const seq = state.seq + 1;
      return { ...state, seq, items: updateRun(state.items, m.event.runId, (r) => applyRunEvent(r, m.event, seq)) };
    }
    case 'ledger.update':
      return { ...state, ledger: m.snapshot };
    case 'models.update':
      return { ...state, models: m.models, chain: m.chain, agentModel: m.agentModel, inlineModel: m.inlineModel };
    case 'providers.state':
      return { ...state, providers: m.state };
    case 'review.open':
      return { ...state, review: { runId: m.runId, changes: m.changes }, view: 'review' };
    case 'review.closed': {
      const files = state.review
        ? state.review.changes.filter((c) => c.hunks.some((h) => h.decision === 'accept')).length
        : 0;
      const has = state.items.some((i) => i.kind === 'run' && i.runId === m.runId);
      return {
        ...state,
        review: undefined,
        view: state.view === 'review' ? 'conversation' : state.view,
        items:
          has && (m.applied > 0 || m.rejected > 0)
            ? updateRun(state.items, m.runId, (r) => ({ ...r, applied: { applied: m.applied, rejected: m.rejected, files } }))
            : state.items,
      };
    }
    case 'editor.selection':
      return { ...state, selection: m.selection };
    case 'composer.focus':
      return {
        ...state,
        view: state.view === 'review' ? state.view : 'conversation',
        focus: { nonce: (state.focus?.nonce ?? 0) + 1, selection: m.selection, mode: m.mode, text: m.text },
      };
    case 'checkpoints.update':
      return { ...state, canUndo: m.canUndo, undoLabel: m.lastLabel };
    case 'mention.suggestions':
      return { ...state, suggestions: { query: m.query, items: m.items } };
    case 'connection':
      return { ...state, connection: { trueforge: m.trueforge, detail: m.detail } };
    case 'history.page':
      return {
        ...state,
        history: {
          sessions: m.append ? [...state.history.sessions, ...m.sessions] : m.sessions,
          next: m.nextPageToken,
          loading: false,
          error: m.error,
        },
      };
    case 'session.loaded': {
      const { items, seq } = transcriptItems(m.turns, state.seq);
      return {
        ...state,
        items,
        seq,
        sessionId: m.sessionId,
        notice: m.notice,
        review: undefined,
        ledger: undefined,
        view: 'conversation',
        history: { ...state.history, loadError: undefined },
      };
    }
    case 'session.loadFailed':
      return { ...state, history: { ...state.history, loadError: m.message } };
    case 'session.current':
      return { ...state, sessionId: m.sessionId };
  }
}

/** Replay a loaded session's turns through the same reducer path live runs use. */
function transcriptItems(
  turns: TranscriptTurn[],
  seq0: number,
): { items: ChatItem[]; seq: number } {
  let seq = seq0;
  const items: ChatItem[] = [];
  for (const t of turns) {
    if (t.user !== undefined)
      items.push({ kind: 'user', id: `u${seq++}`, text: t.user, mentions: [] });
    let run = emptyRun(t.turnId);
    for (const e of t.events) run = applyRunEvent(run, e, ++seq);
    items.push(run);
  }
  return { items, seq };
}

export function isRunning(state: State): boolean {
  const last = [...state.items].reverse().find((i): i is RunItem => i.kind === 'run');
  return !!last && (last.status === 'running' || last.status === 'paused');
}
