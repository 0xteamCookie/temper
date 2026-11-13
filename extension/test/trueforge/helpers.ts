import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ApprovalDecision, RunEvent } from '../../src/shared/types';
import type { AgentSpec, RawEvent, StreamOptions, TrueForgeClientLike } from '../../src/trueforge/client';

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): RawEvent[] {
  return JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
}

export function collect(): { events: RunEvent[]; push: (e: RunEvent) => void } {
  const events: RunEvent[] = [];
  return { events, push: (e) => events.push(e) };
}

export function errorTurn(message: string, turnId = 't1'): RawEvent[] {
  return [
    { type: 'turn.created', id: `${turnId}-c`, turnId, createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'turn.done', id: `${turnId}-d`, state: { status: 'error', message, completedAt: '2026-01-01T00:00:01.000Z', metrics: {} } },
  ];
}

export function okTurn(turnId = 't1'): RawEvent[] {
  return [
    { type: 'turn.created', id: `${turnId}-c`, turnId, createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'model.message', id: `${turnId}-m`, threadId: 'main', model: { name: 'x' } },
    { type: 'model.message.delta', id: `${turnId}-m`, content: 'hello' },
    { type: 'turn.done', id: `${turnId}-d`, state: { status: 'done', completedAt: '2026-01-01T00:00:01.000Z', metrics: { totalInputTokens: 1, totalOutputTokens: 2 } } },
  ];
}

export type Script = RawEvent[] | { createError: Error } | { hang: true; before?: RawEvent[] };

/** Fake client: each streamTurn pops the next script registered for the session's model. */
export class FakeClient implements TrueForgeClientLike {
  scripts = new Map<string, Script[]>();
  sessions: { id: string; model: string }[] = [];
  cancelled: string[] = [];
  approvals: { toolCallId: string; decision: ApprovalDecision }[] = [];
  private cancelResolvers = new Map<string, () => void>();
  private n = 0;

  script(model: string, ...s: Script[]): this {
    this.scripts.set(model, [...(this.scripts.get(model) ?? []), ...s]);
    return this;
  }

  async createSession(spec: AgentSpec): Promise<{ id: string }> {
    const model = spec.model.name;
    const s = this.scripts.get(model)?.[0];
    if (s && 'createError' in s) {
      this.scripts.get(model)!.shift();
      throw s.createError;
    }
    const id = `s${++this.n}`;
    this.sessions.push({ id, model });
    return { id };
  }

  async *streamTurn(sessionId: string, _text: string, opts: StreamOptions = {}): AsyncIterable<RawEvent> {
    const model = this.sessions.find((x) => x.id === sessionId)!.model;
    const s = this.scripts.get(model)!.shift()!;
    if (Array.isArray(s)) {
      for (const ev of s) yield ev;
      return;
    }
    if ('hang' in s) {
      for (const ev of s.before ?? []) yield ev;
      await new Promise<void>((resolve) => {
        this.cancelResolvers.set(sessionId, resolve);
        opts.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      if (this.cancelled.includes(sessionId)) {
        yield { type: 'turn.done', id: 'cancel-done', state: { status: 'cancelled', reason: 'client-cancelled', metrics: {} } };
      }
    }
  }

  async *subscribe(): AsyncIterable<RawEvent> {}

  async approve(_s: string, _t: string, _th: string, toolCallId: string, decision: ApprovalDecision): Promise<void> {
    this.approvals.push({ toolCallId, decision });
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId);
    this.cancelResolvers.get(sessionId)?.();
  }
}

/** View a typed event as a loose record, for asserting on fields of a narrowed-by-kind event. */
export const loose = (e: unknown): Record<string, unknown> => e as Record<string, unknown>;
