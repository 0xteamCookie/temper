import { isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import type { RunEvent, RunMetrics } from '../shared/types';
import type { RawEvent, TrueForgeClientLike } from './client';

type Emit = (ev: RunEvent) => void;

/** Read a field that may arrive camelCase (SDK) or snake_case (raw wire). */
function g(o: any, camel: string, snake: string): any {
  return o?.[camel] ?? o?.[snake];
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Deferred tools are invoked through `call_tool`; report the inner tool and its input instead. */
function unwrapCall(name: string, rawArgs: unknown): { name: string; args: unknown } {
  const args = parseArgs(rawArgs);
  if (name === 'call_tool' && args && typeof args === 'object') {
    const a = args as Record<string, any>;
    const inner = a.tool_name ?? a.toolName ?? a.name;
    if (typeof inner === 'string') {
      const input = a.input ?? a.arguments ?? a.args ?? {};
      return { name: inner, args: parseArgs(input) };
    }
  }
  return { name, args };
}

/**
 * Tool failures come back double wrapped, e.g.
 * `{"error":[{"type":"text","text":"{\"error\":\"User denied tool call: x\"}"}]}`.
 */
export function unwrapToolContent(content: unknown): { content: string; isError: boolean } {
  if (typeof content !== 'string') return { content: JSON.stringify(content ?? ''), isError: false };
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { content, isError: false };
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed) {
    let err: any = parsed.error;
    if (Array.isArray(err)) err = err.map((p) => (typeof p?.text === 'string' ? p.text : JSON.stringify(p))).join('\n');
    if (typeof err === 'string') {
      try {
        const inner = JSON.parse(err);
        if (inner && typeof inner === 'object' && typeof inner.error === 'string') err = inner.error;
      } catch {
        /* plain text */
      }
      return { content: err, isError: true };
    }
    return { content: JSON.stringify(err), isError: true };
  }
  return { content, isError: false };
}

interface MsgState {
  msg: any; // merged model.message (mutated in place by mergeEventDelta)
  shell: any; // pristine copy of the original model.message event
  threadId: string;
  emittedText: number;
  emittedCalls: Set<string>;
}

/**
 * Consumes raw TrueForge events for ONE turn and emits normalized RunEvents.
 * Pure and synchronous: feed it events, get callbacks. Replay-safe (dedupes by event id),
 * which makes resubscribing after a dropped stream safe.
 */
export class TurnRunner {
  turnId?: string;
  /** Id of the last non-delta event seen; the resume point after a dropped stream. */
  lastEventId?: string;
  finished = false;
  doneEvent?: Extract<RunEvent, { kind: 'done' }>;
  toolCallCount = 0;

  private readonly msgs = new Map<string, MsgState>();
  private readonly seen = new Set<string>();
  private readonly approvalsSeen = new Set<string>();
  private readonly threadTitles = new Map<string, string>();
  private lastWasShellOf?: string;
  private createdAt?: string;

  constructor(private readonly runId: string, private readonly emit: Emit) {}

  feed(ev: RawEvent): void {
    if (this.finished) return;
    if (isEventDelta(ev as any)) {
      this.onDelta(ev);
      return;
    }
    if (ev.id) {
      if (this.seen.has(ev.id)) return;
      this.seen.add(ev.id);
      this.lastEventId = ev.id;
    }
    this.lastWasShellOf = undefined;
    switch (ev.type) {
      case 'turn.created':
        this.turnId = g(ev, 'turnId', 'turn_id') ?? this.turnId;
        this.createdAt = g(ev, 'createdAt', 'created_at');
        this.emit({ kind: 'status', runId: this.runId, status: 'running' });
        break;
      case 'turn.update': {
        const st = ev.state?.status;
        if (st === 'paused' || st === 'running') this.emit({ kind: 'status', runId: this.runId, status: st });
        break;
      }
      case 'model.message': {
        this.flushAll();
        const threadId = g(ev, 'threadId', 'thread_id') ?? 'main';
        const msg = structuredClone(ev);
        this.msgs.set(ev.id as string, { msg, shell: structuredClone(ev), threadId, emittedText: 0, emittedCalls: new Set() });
        this.lastWasShellOf = ev.id;
        this.emitTextFor(this.msgs.get(ev.id as string)!);
        break;
      }
      case 'tool.response': {
        this.flushAll();
        const { content, isError } = unwrapToolContent(ev.content);
        this.emit({
          kind: 'toolResult',
          runId: this.runId,
          threadId: g(ev, 'threadId', 'thread_id') ?? 'main',
          id: g(ev, 'toolCallId', 'tool_call_id'),
          content,
          isError,
        });
        break;
      }
      case 'tool.approval_required':
        this.flushAll();
        this.onApproval(ev);
        break;
      case 'thread.created': {
        const threadId = g(ev, 'threadId', 'thread_id');
        if (!threadId) break;
        const title = String(ev.title ?? ev.name ?? ev.description ?? ev.agentName ?? ev.agent_name ?? threadId);
        this.threadTitles.set(threadId, title);
        this.emit({ kind: 'subagent', runId: this.runId, threadId, title, phase: 'start' });
        break;
      }
      case 'thread.done': {
        const threadId = g(ev, 'threadId', 'thread_id');
        if (!threadId) break;
        this.emit({
          kind: 'subagent',
          runId: this.runId,
          threadId,
          title: this.threadTitles.get(threadId) ?? threadId,
          phase: 'done',
          status: ev.state?.status ?? ev.status,
        });
        break;
      }
      case 'thread.context_compaction_started':
      case 'thread.context_compaction_finished':
        this.emit({
          kind: 'compaction',
          runId: this.runId,
          threadId: g(ev, 'threadId', 'thread_id') ?? 'main',
          phase: ev.type.endsWith('started') ? 'start' : 'done',
        });
        break;
      case 'turn.done':
        this.flushAll();
        this.onDone(ev);
        break;
      default:
        break; // mcp.initialize, user.tool_approval echoes, etc.
    }
  }

  /** Emit a terminal error because the stream could not be (re)established. */
  fail(message: string): void {
    if (this.finished) return;
    this.flushAll();
    this.finished = true;
    this.doneEvent = { kind: 'done', runId: this.runId, status: 'error', message };
    this.emit(this.doneEvent);
  }

  /** Emit a terminal cancelled event (used when the stream was aborted without a server turn.done). */
  cancelled(message?: string): void {
    if (this.finished) return;
    this.flushAll();
    this.finished = true;
    this.doneEvent = { kind: 'done', runId: this.runId, status: 'cancelled', message };
    this.emit(this.doneEvent);
  }

  /** Call before resubscribing: the message being streamed when we dropped will replay its deltas from the start. */
  prepareResume(): void {
    const st = this.lastWasShellOf ? this.msgs.get(this.lastWasShellOf) : undefined;
    if (st) st.msg = structuredClone(st.shell);
  }

  /* ------------------------------------------------------------ */

  private onDelta(ev: RawEvent): void {
    const id = ev.id as string;
    let st = this.msgs.get(id);
    if (!st) {
      const shell = { type: 'model.message', id, threadId: 'main' };
      st = { msg: structuredClone(shell), shell, threadId: 'main', emittedText: 0, emittedCalls: new Set() };
      this.msgs.set(id, st);
    }
    mergeEventDelta(st.msg, ev as any);
    this.emitTextFor(st);
    if (g(ev, 'finishReason', 'finish_reason')) this.flushCalls(st);
  }

  private emitTextFor(st: MsgState): void {
    const content = st.msg.content;
    if (typeof content !== 'string' || content.length <= st.emittedText) return;
    const delta = content.slice(st.emittedText);
    st.emittedText = content.length;
    this.emit({ kind: 'text', runId: this.runId, threadId: st.threadId, delta });
  }

  private callsOf(st: MsgState): any[] {
    return g(st.msg, 'toolCalls', 'tool_calls') ?? [];
  }

  private flushCalls(st: MsgState): void {
    for (const tc of this.callsOf(st)) {
      if (!tc?.id || st.emittedCalls.has(tc.id)) continue;
      st.emittedCalls.add(tc.id);
      this.toolCallCount++;
      const { name, args } = unwrapCall(tc.function?.name ?? '', tc.function?.arguments);
      this.emit({ kind: 'toolCall', runId: this.runId, threadId: st.threadId, id: tc.id, name, args });
    }
  }

  private flushAll(): void {
    for (const st of this.msgs.values()) this.flushCalls(st);
  }

  private findCall(sourceEventId: string | undefined, callId: string): { st: MsgState; tc: any } | undefined {
    const src = sourceEventId ? this.msgs.get(sourceEventId) : undefined;
    const pools = src ? [src, ...this.msgs.values()] : [...this.msgs.values()];
    for (const st of pools) {
      const tc = this.callsOf(st).find((c) => c?.id === callId);
      if (tc) return { st, tc };
    }
    return undefined;
  }

  private onApproval(ev: RawEvent): void {
    const threadId = g(ev, 'threadId', 'thread_id') ?? 'main';
    for (const ref of g(ev, 'toolCalls', 'tool_calls') ?? []) {
      const id: string = ref.id;
      if (!id || this.approvalsSeen.has(id)) continue; // duplicate approval events (#508)
      this.approvalsSeen.add(id);
      const found = this.findCall(g(ref, 'sourceEventId', 'source_event_id'), id);
      const { name, args } = found
        ? unwrapCall(found.tc.function?.name ?? '', found.tc.function?.arguments)
        : { name: 'unknown', args: {} };
      this.emit({ kind: 'approval', runId: this.runId, threadId, toolCallId: id, name, args });
    }
  }

  private onDone(ev: RawEvent): void {
    const state = ev.state ?? {};
    const status: string = state.status;
    const m = state.metrics ?? {};
    const completedAt = g(state, 'completedAt', 'completed_at');
    const metrics: RunMetrics = {
      inputTokens: g(m, 'totalInputTokens', 'total_input_tokens'),
      outputTokens: g(m, 'totalOutputTokens', 'total_output_tokens'),
      toolCalls: this.toolCallCount,
    };
    if (this.createdAt && completedAt) {
      const d = Date.parse(completedAt) - Date.parse(this.createdAt);
      if (Number.isFinite(d)) metrics.durationMs = d;
    }
    let done: Extract<RunEvent, { kind: 'done' }>;
    if (status === 'done') done = { kind: 'done', runId: this.runId, status: 'done', metrics };
    else if (status === 'cancelled') done = { kind: 'done', runId: this.runId, status: 'cancelled', message: state.reason, metrics };
    else done = { kind: 'done', runId: this.runId, status: 'error', message: state.message ?? `Turn ended with status '${status}'`, metrics };
    this.finished = true;
    this.doneEvent = done;
    this.emit(done);
  }
}

export interface ConsumeOptions {
  client: TrueForgeClientLike;
  sessionId: string;
  text: string;
  runner: TurnRunner;
  signal?: AbortSignal;
  previousTurnId?: string;
  /** Max resubscribe attempts after a dropped stream. Default 3. */
  maxResumes?: number;
  /** Delay before resubscribing, multiplied by the attempt number. Default 250ms. */
  resumeDelayMs?: number;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Drive one turn to completion: start the stream, feed the runner, and when the stream drops
 * before `turn.done` resubscribe from the last event id (up to `maxResumes` times).
 * Resolves when the runner has finished (done/error/cancelled). Never rejects.
 */
export async function consumeTurn(opts: ConsumeOptions): Promise<void> {
  const { client, sessionId, text, runner, signal } = opts;
  const maxResumes = opts.maxResumes ?? 3;
  const delay = opts.resumeDelayMs ?? 250;
  let resumes = 0;
  let lastError = '';
  let first = true;
  while (!runner.finished) {
    if (signal?.aborted) return;
    try {
      let source: AsyncIterable<RawEvent>;
      if (first) {
        source = client.streamTurn(sessionId, text, { signal, previousTurnId: opts.previousTurnId });
      } else {
        runner.prepareResume();
        source = client.subscribe(sessionId, runner.turnId!, runner.lastEventId, signal);
      }
      first = false;
      for await (const ev of source) {
        runner.feed(ev);
        if (runner.finished) return;
      }
    } catch (e) {
      if (signal?.aborted) return;
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (runner.finished || signal?.aborted) return;
    if (!runner.turnId) {
      runner.fail(lastError || 'The TrueForge stream ended before the turn started.');
      return;
    }
    if (resumes >= maxResumes) {
      runner.fail(`Lost the connection to TrueForge and could not resume the turn after ${maxResumes} attempts${lastError ? `: ${lastError}` : '.'}`);
      return;
    }
    resumes++;
    await wait(delay * resumes, signal);
  }
}
