import { describe, expect, it } from 'vitest';
import {
  buildTranscript,
  isTemperAgentSession,
  SessionHistory,
  toSummary,
  trimTitle,
  userText,
} from '../../src/host/sessionHistory';
import type { HistoryClient } from '../../src/host/sessionHistory';

const AGENT = 'temper-agent';

describe('isTemperAgentSession', () => {
  it('keeps stamped agent-mode sessions and hides stamped inline ones', () => {
    expect(isTemperAgentSession({ metadata: { app: 'temper', mode: 'agent' } }, AGENT)).toBe(true);
    expect(isTemperAgentSession({ metadata: { app: 'temper', mode: 'inline' } }, AGENT)).toBe(
      false,
    );
  });

  it('falls back to the agent name for sessions without the stamp', () => {
    expect(
      isTemperAgentSession({ metadata: {}, agent: { type: 'reference', name: AGENT } }, AGENT),
    ).toBe(true);
    expect(
      isTemperAgentSession(
        { metadata: {}, agent: { type: 'reference', name: 'temper-inline' } },
        AGENT,
      ),
    ).toBe(false);
    expect(isTemperAgentSession({ metadata: {}, agent: { type: 'inline', spec: {} } }, AGENT)).toBe(
      false,
    );
    expect(
      isTemperAgentSession(
        { metadata: { app: 'other' }, agent: { type: 'reference', name: 'x' } },
        AGENT,
      ),
    ).toBe(false);
  });

  it('does not trust a foreign stamp over the agent name', () => {
    expect(
      isTemperAgentSession(
        { metadata: { app: 'other' }, agent: { type: 'reference', name: AGENT } },
        AGENT,
      ),
    ).toBe(true);
  });
});

describe('trimTitle / toSummary', () => {
  it('collapses whitespace and trims to about 60 characters', () => {
    expect(trimTitle('  fix\n\n the   bug ')).toBe('fix the bug');
    const t = trimTitle('x'.repeat(100));
    expect(t.length).toBe(60);
    expect(t.endsWith('…')).toBe(true);
  });

  it('reads snake_case wire sessions', () => {
    const s = toSummary({
      id: 's1',
      title: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      metrics: { total_turns: 3 },
      agent: { type: 'inline', spec: { model: { name: 'p/m' } } },
    });
    expect(s).toEqual({
      id: 's1',
      title: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      turns: 3,
      model: 'p/m',
    });
  });
});

describe('userText', () => {
  it('reads string and part content and drops leading @mention lines', () => {
    expect(userText([{ type: 'user.message', content: '@src/a.ts\n@symbol:foo\n\nfix it' }])).toBe(
      'fix it',
    );
    expect(userText([{ type: 'user.message', content: [{ type: 'text', text: 'hello' }] }])).toBe(
      'hello',
    );
    expect(userText([])).toBeUndefined();
    expect(userText(undefined)).toBeUndefined();
  });
});

const turn = (id: string, text: string, status = 'done') => ({
  id,
  input: [{ type: 'user.message', content: text }],
  state: { status },
});
const ev = (turn_id: string, event: Record<string, unknown>) => ({ turn_id, event });

describe('buildTranscript', () => {
  // newest first, as the API returns them
  const events = [
    ev('t2', {
      type: 'turn.done',
      id: 'd2',
      state: { status: 'done', metrics: { total_input_tokens: 5, total_output_tokens: 2 } },
    }),
    ev('t2', {
      type: 'model.message',
      id: 'm3',
      thread_id: 'main',
      model: { name: 'p/m' },
      content: 'All done.',
    }),
    ev('t2', { type: 'turn.created', id: 'c2', turn_id: 't2', created_at: '2026-01-01T00:01:00Z' }),
    ev('t1', {
      type: 'turn.done',
      id: 'd1',
      state: { status: 'done', completed_at: '2026-01-01T00:00:10Z', metrics: {} },
    }),
    ev('t1', {
      type: 'tool.response',
      id: 'r1',
      thread_id: 'main',
      tool_call_id: 'call1',
      content: 'file contents',
    }),
    ev('t1', {
      type: 'model.message',
      id: 'm1',
      thread_id: 'main',
      model: { name: 'p/m' },
      content: [{ type: 'text', text: 'Looking.' }],
      tool_calls: [{ id: 'call1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
    }),
    ev('t1', { type: 'turn.created', id: 'c1', turn_id: 't1', created_at: '2026-01-01T00:00:00Z' }),
  ];
  const turns = [turn('t2', 'and now?'), turn('t1', '@a.ts\n\nread a.ts')];

  it('orders turns oldest first with the user message and mapped run events', () => {
    const t = buildTranscript(turns, events, 's1');
    expect(t.turns.map((x) => [x.turnId, x.user])).toEqual([
      ['t1', 'read a.ts'],
      ['t2', 'and now?'],
    ]);
    expect(t.turns[0]!.events.map((e) => e.kind)).toEqual([
      'runStart',
      'text',
      'toolCall',
      'toolResult',
      'done',
    ]);
    expect(t.turns[0]!.events[0]).toMatchObject({
      kind: 'runStart',
      model: 'p/m',
      sessionId: 's1',
    });
    expect(t.turns[0]!.events[2]).toMatchObject({
      kind: 'toolCall',
      id: 'call1',
      name: 'read_file',
      args: { path: 'a.ts' },
    });
    expect(t.turns[0]!.events[3]).toMatchObject({
      kind: 'toolResult',
      id: 'call1',
      content: 'file contents',
      isError: false,
    });
    expect(t.turns[0]!.events[4]).toMatchObject({
      kind: 'done',
      status: 'done',
      metrics: { durationMs: 10000, toolCalls: 1 },
    });
    expect(t.turns[1]!.events[2]).toMatchObject({
      kind: 'done',
      metrics: { inputTokens: 5, outputTokens: 2 },
    });
    expect(t.model).toBe('p/m');
    expect(t.lastStatus).toBe('done');
  });

  it('unwraps call_tool and failed tool results', () => {
    const t = buildTranscript(
      [turn('t', 'x')],
      [
        ev('t', {
          type: 'tool.response',
          id: 'r',
          thread_id: 'main',
          tool_call_id: 'c',
          content: '{"error":"User denied tool call: nope"}',
        }),
        ev('t', {
          type: 'model.message',
          id: 'm',
          thread_id: 'main',
          tool_calls: [
            {
              id: 'c',
              function: {
                name: 'call_tool',
                arguments: '{"tool_name":"propose_edit","input":{"path":"a"}}',
              },
            },
          ],
        }),
      ],
      's',
    );
    const evs = t.turns[0]!.events;
    expect(evs.find((e) => e.kind === 'toolCall')).toMatchObject({
      name: 'propose_edit',
      args: { path: 'a' },
    });
    expect(evs.find((e) => e.kind === 'toolResult')).toMatchObject({
      isError: true,
      content: 'User denied tool call: nope',
    });
  });

  it('maps subagent threads and compaction', () => {
    const t = buildTranscript(
      [turn('t', 'x')],
      [
        ev('t', { type: 'thread.done', id: '4', thread_id: 'th', state: { status: 'done' } }),
        ev('t', { type: 'thread.context_compaction_finished', id: '3', thread_id: 'main' }),
        ev('t', { type: 'thread.context_compaction_started', id: '2', thread_id: 'main' }),
        ev('t', { type: 'thread.created', id: '1', thread_id: 'th', title: 'Scout' }),
      ],
      's',
    );
    expect(t.turns[0]!.events.map((e) => e.kind)).toEqual([
      'runStart',
      'subagent',
      'compaction',
      'compaction',
      'subagent',
      'done',
    ]);
  });

  it('shows a turn that never finished as stopped, and reports its status', () => {
    const t = buildTranscript(
      [turn('t', 'x', 'paused')],
      [ev('t', { type: 'model.message', id: 'm', thread_id: 'main', content: 'working' })],
      's',
    );
    const last = t.turns[0]!.events.at(-1);
    expect(last).toMatchObject({ kind: 'done', status: 'cancelled' });
    expect(t.lastStatus).toBe('paused');
  });

  it('skips turns that have no events', () => {
    expect(buildTranscript([turn('t', 'x')], [], 's').turns).toEqual([]);
  });
});

describe('SessionHistory', () => {
  const rows = [
    { id: 'a', metadata: { app: 'temper', mode: 'agent' } },
    { id: 'b', metadata: { app: 'temper', mode: 'inline' } },
    { id: 'c', metadata: {}, agent: { type: 'reference', name: AGENT } },
    { id: 'd', metadata: {}, agent: { type: 'reference', name: 'someone-elses' } },
  ];
  function fake(agentId: string | undefined) {
    const calls: unknown[] = [];
    const client: HistoryClient = {
      getAgentId: async () => agentId,
      listSessions: async (o) => {
        calls.push(o);
        return { sessions: rows, nextPageToken: o.pageToken ? undefined : 'next' };
      },
      listTurns: async () => [],
      listSessionEvents: async () => [],
    };
    return { client, calls };
  }

  it('filters out inline and foreign sessions and keeps the page token', async () => {
    const { client } = fake('ag1');
    const page = await new SessionHistory(client, AGENT).list();
    expect(page.sessions.map((s) => s.id)).toEqual(['a', 'c']);
    expect(page.nextPageToken).toBe('next');
  });

  it('asks the server for the agent id when known, else for the metadata stamp', async () => {
    const withAgent = fake('ag1');
    await new SessionHistory(withAgent.client, AGENT).list('tok');
    expect(withAgent.calls[0]).toMatchObject({ agentId: 'ag1', pageToken: 'tok' });
    const without = fake(undefined);
    await new SessionHistory(without.client, AGENT).list();
    expect(without.calls[0]).toMatchObject({ metadata: { app: 'temper', mode: 'agent' } });
  });
});
