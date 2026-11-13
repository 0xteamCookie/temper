import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/shared/types';
import { consumeTurn, TurnRunner, unwrapToolContent } from '../../src/trueforge';
import type { RawEvent } from '../../src/trueforge';
import { FakeClient, collect, fixture, loose, okTurn } from './helpers';

function replay(name: string): { events: RunEvent[]; runner: TurnRunner } {
  const { events, push } = collect();
  const runner = new TurnRunner('r1', push);
  for (const ev of fixture(name)) runner.feed(ev);
  return { events, runner };
}
const kinds = (evs: RunEvent[]) => evs.map((e) => e.kind);

describe('TurnRunner: replayed spike streams', () => {
  it('tool turn with allow', () => {
    const { events, runner } = replay('tool-allow');
    expect(runner.turnId).toBeTruthy();
    expect(kinds(events)).toEqual([
      'status', 'toolCall', 'toolResult', 'toolCall', 'approval', 'status', 'status', 'toolResult', 'text', 'done',
    ]);
    const calls = events.filter((e) => e.kind === 'toolCall');
    expect(calls[0]).toMatchObject({ id: 'call_read1', name: 'read_file', args: { path: 'src/app.py' }, threadId: 'main' });
    expect(calls[1]).toMatchObject({ id: 'call_edit1', name: 'propose_edit', args: { path: 'src/app.py', new_content: "print('bye')\n" } });
    expect(events.find((e) => e.kind === 'approval')).toMatchObject({
      toolCallId: 'call_edit1', name: 'propose_edit', threadId: 'main', args: { path: 'src/app.py' },
    });
    expect(events.filter((e) => e.kind === 'status').map((e) => e.status)).toEqual(['running', 'paused', 'running']);
    const results = events.filter((e) => e.kind === 'toolResult') as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ id: 'call_read1', content: "# src/app.py\nprint('hello')\n", isError: false });
    expect(results[1]).toMatchObject({ id: 'call_edit1', content: 'edit to src/app.py recorded', isError: false });
    expect(events.find((e) => e.kind === 'text')).toMatchObject({ delta: 'Done. Last tool result: edit to src/app.py recorded' });
    expect(events.at(-1)).toMatchObject({ kind: 'done', status: 'done', metrics: { inputTokens: 30, outputTokens: 15, toolCalls: 2 } });
    expect(runner.finished).toBe(true);
  });

  it('approval is emitted after its toolCall', () => {
    const { events } = replay('tool-allow');
    const iCall = events.findIndex((e) => e.kind === 'toolCall' && loose(e).id === 'call_edit1');
    const iAppr = events.findIndex((e) => e.kind === 'approval');
    expect(iCall).toBeGreaterThanOrEqual(0);
    expect(iAppr).toBeGreaterThan(iCall);
  });

  it('tool turn with deny reports the denial as an error result', () => {
    const { events } = replay('tool-deny');
    const results = events.filter((e) => e.kind === 'toolResult') as Array<Record<string, unknown>>;
    expect(results[1]).toMatchObject({ id: 'call_edit1', content: 'User denied tool call: not today', isError: true });
    expect(events.at(-1)).toMatchObject({ kind: 'done', status: 'done' });
  });

  it('cancel while paused', () => {
    const { events } = replay('cancel-paused');
    expect(events.filter((e) => e.kind === 'status').map((e) => e.status)).toEqual(['running', 'paused']);
    expect(events.at(-1)).toMatchObject({ kind: 'done', status: 'cancelled', message: 'client-cancelled' });
  });

  it('stream left paused emits approval and no done', () => {
    const { events, runner } = replay('tool-noapprove');
    expect(kinds(events)).toContain('approval');
    expect(events.at(-1)).toMatchObject({ kind: 'status', status: 'paused' });
    expect(runner.finished).toBe(false);
  });

  it('cancel while streaming text merges deltas and finishes cancelled', () => {
    const { events } = replay('cancel-slow');
    const text = events.filter((e) => e.kind === 'text').map((e) => e.delta).join('');
    expect(text).toBe('word '.repeat(14));
    expect(events.at(-1)).toMatchObject({ kind: 'done', status: 'cancelled' });
  });

  it('MCP server down surfaces as done error', () => {
    const { events } = replay('mcp-down');
    expect(events.at(-1)).toMatchObject({ kind: 'done', status: 'error' });
    expect(loose(events.at(-1)).message).toMatch(/^\[MCP Error\]/);
  });
});

describe('TurnRunner: details', () => {
  const base = (extra: RawEvent[]) => [
    { type: 'turn.created', id: 'a', turnId: 'T' },
    { type: 'model.message', id: 'm1', threadId: 'main' },
    ...extra,
  ];

  it('unwraps call_tool deferred calls for toolCall and approval', () => {
    const { events, push } = collect();
    const r = new TurnRunner('r', push);
    for (const ev of base([
      { type: 'model.message.delta', id: 'm1', toolCalls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'call_tool', arguments: '' }, toolInfo: { type: 'mcp', name: 'call_tool' } }] },
      { type: 'model.message.delta', id: 'm1', toolCalls: [{ index: 0, function: { arguments: '{"tool_name":"submit_changeset","input":{"summary":"x"}}' } }] },
      { type: 'model.message.delta', id: 'm1', finishReason: 'tool_calls' },
      { type: 'tool.approval_required', id: 'ap', threadId: 'main', toolCalls: [{ id: 'c1', sourceEventId: 'm1' }] },
    ])) r.feed(ev);
    expect(events.find((e) => e.kind === 'toolCall')).toMatchObject({ name: 'submit_changeset', args: { summary: 'x' } });
    expect(events.find((e) => e.kind === 'approval')).toMatchObject({ name: 'submit_changeset', args: { summary: 'x' }, toolCallId: 'c1' });
  });

  it('emits toolCall at next event when finish_reason never arrives, and dedupes duplicate approvals', () => {
    const { events, push } = collect();
    const r = new TurnRunner('r', push);
    for (const ev of base([
      { type: 'model.message.delta', id: 'm1', toolCalls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' }, toolInfo: { type: 'mcp', name: 'read_file' } }] },
      { type: 'tool.approval_required', id: 'ap1', toolCalls: [{ id: 'c1', sourceEventId: 'm1' }] },
      { type: 'tool.approval_required', id: 'ap2', toolCalls: [{ id: 'c1', sourceEventId: 'm1' }] },
    ])) r.feed(ev);
    expect(events.filter((e) => e.kind === 'toolCall')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'approval')).toHaveLength(1);
  });

  it('maps subagent and compaction events', () => {
    const { events, push } = collect();
    const r = new TurnRunner('r', push);
    for (const ev of [
      { type: 'turn.created', id: 'a', turnId: 'T' },
      { type: 'thread.created', id: 'b', threadId: 'sub1', title: 'scout' },
      { type: 'thread.context_compaction_started', id: 'c', threadId: 'main' },
      { type: 'thread.context_compaction_finished', id: 'd', threadId: 'main' },
      { type: 'thread.done', id: 'e', threadId: 'sub1', state: { status: 'done' } },
    ]) r.feed(ev);
    expect(events.slice(1)).toEqual([
      { kind: 'subagent', runId: 'r', threadId: 'sub1', title: 'scout', phase: 'start' },
      { kind: 'compaction', runId: 'r', threadId: 'main', phase: 'start' },
      { kind: 'compaction', runId: 'r', threadId: 'main', phase: 'done' },
      { kind: 'subagent', runId: 'r', threadId: 'sub1', title: 'scout', phase: 'done', status: 'done' },
    ]);
  });

  it('unwrapToolContent leaves normal content alone', () => {
    expect(unwrapToolContent('{"a":1}')).toEqual({ content: '{"a":1}', isError: false });
    expect(unwrapToolContent('plain')).toEqual({ content: 'plain', isError: false });
  });
});

describe('consumeTurn: resubscribe', () => {
  it('resumes after a dropped stream without duplicating text or calls', async () => {
    const full = fixture('tool-allow');
    // Drop after the first delta of the first model message (events 0..3).
    const firstPart = full.slice(0, 4);
    const shellId = full[2]!.id;
    const client = new FakeClient();
    client.subscribe = async function* (_s: string, turnId: string, after?: string) {
      expect(turnId).toBeTruthy();
      expect(after).toBe(shellId); // last non-delta event = the model.message shell
      for (const ev of full.slice(3)) yield ev; // server replays that message's deltas from the start
    } as unknown as FakeClient['subscribe'];
    client.script('m', firstPart);
    const { events, push } = collect();
    const runner = new TurnRunner('r', push);
    const { id } = await client.createSession({ model: { name: 'm' } });
    await consumeTurn({ client, sessionId: id, text: 'go', runner, resumeDelayMs: 0 });
    expect(runner.finished).toBe(true);
    expect(events.filter((e) => e.kind === 'toolCall')).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'approval')).toHaveLength(1);
    expect(loose(events.find((e) => e.kind === 'toolCall')).args).toEqual({ path: 'src/app.py' });
  });

  it('gives up after 3 resumes with a done error', async () => {
    const client = new FakeClient();
    let subs = 0;
    client.subscribe = async function* () {
      subs++;
      yield* [] as RawEvent[];
    } as unknown as FakeClient['subscribe'];
    client.script('m', okTurn().slice(0, 1));
    const { events, push } = collect();
    const runner = new TurnRunner('r', push);
    const { id } = await client.createSession({ model: { name: 'm' } });
    await consumeTurn({ client, sessionId: id, text: 'go', runner, resumeDelayMs: 0 });
    expect(subs).toBe(3);
    expect(events.at(-1)).toMatchObject({ kind: 'done', status: 'error' });
  });
});
