// Session history: which TrueForge sessions Temper lists, and how a stored session becomes a chat
// transcript. Pure (no vscode import); the TrueForge calls sit behind HistoryClient.
import { sessionMetadata } from '../trueforge/namedAgent';
import { unwrapCall, unwrapToolContent } from '../trueforge/turnRunner';
import type { RunEvent, RunMetrics } from '../shared/types';
import type { SessionSummary, TranscriptTurn } from '../shared/sessions';

/** Loosely typed JSON off the wire (snake_case) or from the SDK (camelCase). */
type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return v && typeof v === 'object' ? (v as Rec) : {};
}

function g(o: unknown, camel: string, snake: string): unknown {
  const r = rec(o);
  return r[camel] ?? r[snake];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

export const TITLE_MAX = 60;

/** A session title from the first user message: one line, trimmed to ~60 characters. */
export function trimTitle(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1).trimEnd()}…` : s;
}

/**
 * True for sessions Temper's agent mode created (shown in History). Sessions stamped by Temper are
 * judged by their mode (inline edits are hidden); older or unstamped ones by the agent's name.
 */
export function isTemperAgentSession(raw: unknown, agentName: string): boolean {
  const s = rec(raw);
  const meta = rec(s.metadata);
  if (meta.app === 'temper') return meta.mode === 'agent';
  const agent = rec(s.agent);
  return agent.type !== 'inline' && agent.name === agentName;
}

export function toSummary(raw: unknown): SessionSummary {
  const s = rec(raw);
  const agent = rec(s.agent);
  const model = str(rec(rec(agent.spec).model).name);
  return {
    id: String(s.id),
    title: str(s.title) ?? null,
    createdAt: str(g(s, 'createdAt', 'created_at')) ?? '',
    updatedAt: str(g(s, 'updatedAt', 'updated_at')) ?? '',
    turns: num(g(rec(s.metrics), 'totalTurns', 'total_turns')) ?? 0,
    ...(model ? { model } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Events -> transcript                                                */
/* ------------------------------------------------------------------ */

/** The text of a stored user message: string content or text parts; leading @mention lines are dropped. */
export function userText(input: unknown): string | undefined {
  const parts: string[] = [];
  for (const item of Array.isArray(input) ? input : []) {
    const it = rec(item);
    if (it.type !== 'user.message') continue;
    const c = it.content;
    if (typeof c === 'string') parts.push(c);
    else if (Array.isArray(c))
      for (const p of c) if (typeof rec(p).text === 'string') parts.push(rec(p).text as string);
  }
  if (parts.length === 0) return undefined;
  return parts.join('\n').replace(/^(?:@\S+\n)+\n/, '');
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (typeof rec(p).text === 'string' ? (rec(p).text as string) : ''))
    .join('');
}

export interface Transcript {
  turns: TranscriptTurn[];
  /** Model of the newest model message, if any. */
  model?: string;
  /** State of the newest turn. */
  lastStatus?: string;
}

/**
 * Rebuild the chat of a session. `turns` are the session's turns (any order); `events` the session
 * events as listed by TrueForge ({turn_id, event}, newest first; deltas already merged). Only turns
 * that have events are shown, oldest first. Approvals are not restored (nothing can be decided now);
 * a turn that never finished is shown as stopped.
 */
export function buildTranscript(
  turns: unknown[],
  events: unknown[],
  sessionId: string,
): Transcript {
  const turnById = new Map<string, Rec>();
  for (const t of turns) turnById.set(String(rec(t).id), rec(t));

  const order: string[] = [];
  const byTurn = new Map<string, Rec[]>();
  for (const item of [...events].reverse()) {
    const turnId = str(g(item, 'turnId', 'turn_id'));
    if (!turnId) continue;
    let list = byTurn.get(turnId);
    if (!list) {
      list = [];
      byTurn.set(turnId, list);
      order.push(turnId);
    }
    list.push(rec(rec(item).event));
  }

  let model: string | undefined;
  let lastStatus: string | undefined;
  const out: TranscriptTurn[] = [];
  for (const turnId of order) {
    const turn = turnById.get(turnId);
    const status = str(rec(turn?.state).status);
    const evs: RunEvent[] = [];
    const runId = turnId;
    const threads = new Map<string, string>();
    let turnModel: string | undefined;
    let toolCalls = 0;
    let createdAt: string | undefined;
    let done = false;

    for (const e of byTurn.get(turnId)!) {
      switch (e.type) {
        case 'turn.created':
          createdAt = str(g(e, 'createdAt', 'created_at'));
          break;
        case 'model.message': {
          const name = str(rec(e.model).name);
          if (name) turnModel ??= name;
          const threadId = str(g(e, 'threadId', 'thread_id')) ?? 'main';
          const text = messageText(e.content);
          if (text) evs.push({ kind: 'text', runId, threadId, delta: text });
          const calls = g(e, 'toolCalls', 'tool_calls');
          for (const tc of Array.isArray(calls) ? calls : []) {
            const c = rec(tc);
            const id = str(c.id);
            if (!id) continue;
            const fn = rec(c.function);
            const { name: toolName, args } = unwrapCall(str(fn.name) ?? '', fn.arguments);
            toolCalls++;
            evs.push({ kind: 'toolCall', runId, threadId, id, name: toolName, args });
          }
          break;
        }
        case 'tool.response': {
          const { content, isError } = unwrapToolContent(e.content);
          const id = str(g(e, 'toolCallId', 'tool_call_id'));
          if (id)
            evs.push({
              kind: 'toolResult',
              runId,
              threadId: str(g(e, 'threadId', 'thread_id')) ?? 'main',
              id,
              content,
              isError,
            });
          break;
        }
        case 'thread.created': {
          const threadId = str(g(e, 'threadId', 'thread_id'));
          if (!threadId) break;
          const title = String(
            e.title ?? e.name ?? e.description ?? e.agentName ?? e.agent_name ?? threadId,
          );
          threads.set(threadId, title);
          evs.push({ kind: 'subagent', runId, threadId, title, phase: 'start' });
          break;
        }
        case 'thread.done': {
          const threadId = str(g(e, 'threadId', 'thread_id'));
          if (!threadId) break;
          evs.push({
            kind: 'subagent',
            runId,
            threadId,
            title: threads.get(threadId) ?? threadId,
            phase: 'done',
            status: str(rec(e.state).status ?? e.status),
          });
          break;
        }
        case 'thread.context_compaction_started':
        case 'thread.context_compaction_finished':
          evs.push({
            kind: 'compaction',
            runId,
            threadId: str(g(e, 'threadId', 'thread_id')) ?? 'main',
            phase: String(e.type).endsWith('started') ? 'start' : 'done',
          });
          break;
        case 'turn.done': {
          done = true;
          const st = rec(e.state);
          const m = rec(st.metrics);
          const metrics: RunMetrics = {
            inputTokens: num(g(m, 'totalInputTokens', 'total_input_tokens')),
            outputTokens: num(g(m, 'totalOutputTokens', 'total_output_tokens')),
            toolCalls,
          };
          const completed = str(g(st, 'completedAt', 'completed_at'));
          if (createdAt && completed) {
            const d = Date.parse(completed) - Date.parse(createdAt);
            if (Number.isFinite(d)) metrics.durationMs = d;
          }
          const s = str(st.status);
          if (s === 'done') evs.push({ kind: 'done', runId, status: 'done', metrics });
          else if (s === 'cancelled')
            evs.push({
              kind: 'done',
              runId,
              status: 'cancelled',
              message: str(st.reason),
              metrics,
            });
          else
            evs.push({
              kind: 'done',
              runId,
              status: 'error',
              message: str(st.message) ?? `Turn ended with status '${s}'`,
              metrics,
            });
          break;
        }
        default:
          break; // mcp.initialize, approvals, user.* echoes, sandbox events
      }
    }
    if (!done) {
      if (status === 'done')
        evs.push({ kind: 'done', runId, status: 'done', metrics: { toolCalls } });
      else if (status === 'error')
        evs.push({ kind: 'done', runId, status: 'error', message: 'The turn failed.' });
      else
        evs.push({
          kind: 'done',
          runId,
          status: 'cancelled',
          message:
            status === 'cancelled' ? undefined : 'This turn had not finished when it was loaded.',
        });
    }
    evs.unshift({ kind: 'runStart', runId, mode: 'agent', model: turnModel ?? '', sessionId });
    if (turnModel) model = turnModel;
    lastStatus = status;
    out.push({ turnId, user: userText(turn?.input), events: evs });
  }
  return { turns: out, model, lastStatus };
}

export const UNFINISHED_NOTICE =
  'The last turn of this session is still running or waiting for approval in TrueForge. Sending a message now will cancel it.';

/* ------------------------------------------------------------------ */
/* Listing and loading                                                 */
/* ------------------------------------------------------------------ */

/** The TrueForge calls History needs; implemented by TrueForgeClient and by test fakes. */
export interface HistoryClient {
  /** Resolve a registered agent's id by name (undefined when it is not registered). */
  getAgentId(name: string): Promise<string | undefined>;
  listSessions(opts: {
    pageToken?: string;
    limit?: number;
    agentId?: string;
    metadata?: Record<string, string>;
  }): Promise<{ sessions: unknown[]; nextPageToken?: string }>;
  listTurns(sessionId: string): Promise<unknown[]>;
  /** Every listed event of the session, newest first. */
  listSessionEvents(sessionId: string): Promise<unknown[]>;
}

export interface HistoryPage {
  sessions: SessionSummary[];
  nextPageToken?: string;
}

export class SessionHistory {
  private agentId: string | undefined;

  constructor(
    private readonly client: HistoryClient,
    private readonly agentName: string,
  ) {}

  /** One page, newest first. Sessions without an agent id on file fall back to Temper's metadata stamp. */
  async list(pageToken?: string): Promise<HistoryPage> {
    this.agentId ??= await this.client.getAgentId(this.agentName).catch(() => undefined);
    const page = await this.client.listSessions({
      pageToken,
      limit: 25,
      ...(this.agentId ? { agentId: this.agentId } : { metadata: sessionMetadata('agent') }),
    });
    return {
      sessions: page.sessions.filter((s) => isTemperAgentSession(s, this.agentName)).map(toSummary),
      nextPageToken: page.nextPageToken,
    };
  }

  async load(sessionId: string): Promise<Transcript> {
    const [turns, events] = await Promise.all([
      this.client.listTurns(sessionId),
      this.client.listSessionEvents(sessionId),
    ]);
    return buildTranscript(turns, events, sessionId);
  }
}
