import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/shared/types';
import { ModelRouter, ModelUnavailableError } from '../../src/trueforge';
import { FakeClient, collect, errorTurn, loose, okTurn } from './helpers';

const spec = (model: string) => ({ model: { name: model } });
const E401 = '[Model Error] Request failed (401): mock 401';
const E429 = '[Model Error] Request failed (429): mock 429';
const E500 = '[Model Error] Request failed (500): mock 500';
const sleeps: number[] = [];
const sleep = async (ms: number) => void sleeps.push(ms);

function make(client: FakeClient, chain: string[], over: Partial<ConstructorParameters<typeof ModelRouter>[0]> = {}) {
  sleeps.length = 0;
  return new ModelRouter({ client, chain, retries: 1, fallbackEnabled: true, sleep, ...over });
}
const run = (router: ModelRouter, over: Partial<Parameters<ModelRouter['run']>[0]> = {}) => {
  const { events, push } = collect();
  const p = router.run({ mode: 'agent', buildSpec: spec, prompt: 'hi', hasSideEffects: () => false, onEvent: push, ...over });
  return { events, p };
};
const kinds = (e: RunEvent[]) => e.map((x) => x.kind);

describe('ModelRouter', () => {
  it('succeeds on the first model', async () => {
    const c = new FakeClient().script('a', okTurn());
    const r = make(c, ['a', 'b']);
    const { events, p } = run(r);
    expect((await p).status).toBe('done');
    expect(kinds(events)).toEqual(['runStart', 'status', 'text', 'done']);
    expect(r.getHealth().a?.health).toBe('ok');
  });

  it('falls back on auth failure and emits fallback event', async () => {
    const c = new FakeClient().script('a', errorTurn(E401)).script('b', okTurn());
    const r = make(c, ['a', 'b']);
    const { events, p } = run(r);
    expect(await p).toMatchObject({ status: 'done', model: 'b' });
    const fb = loose(events.find((e) => e.kind === 'fallback'));
    expect(fb).toMatchObject({ from: 'a', to: 'b' });
    expect(fb.reason).toContain('401');
    expect(r.getHealth().a).toMatchObject({ health: 'failing' });
    expect(r.getHealth().b).toMatchObject({ health: 'ok' });
    expect(events.filter((e) => e.kind === 'done')).toHaveLength(1);
  });

  it('falls back on unknown model (422 at create)', async () => {
    const c = new FakeClient()
      .script('a', { createError: new ModelUnavailableError('Unknown model "a" - provider not configured') })
      .script('b', okTurn());
    const { events, p } = run(make(c, ['a', 'b']));
    expect((await p).model).toBe('b');
    expect(events.find((e) => e.kind === 'fallback')).toBeTruthy();
  });

  it('retries rateLimit with exponential backoff, then succeeds', async () => {
    const c = new FakeClient().script('a', errorTurn(E429), errorTurn(E429), okTurn());
    const r = make(c, ['a', 'b'], { retries: 2, baseDelayMs: 100 });
    const { events, p } = run(r);
    expect(await p).toMatchObject({ status: 'done', model: 'a' });
    expect(events.filter((e) => e.kind === 'retry').map((e) => [e.attempt, e.delayMs])).toEqual([[1, 100], [2, 200]]);
    expect(sleeps).toEqual([100, 200]);
    expect(events.find((e) => e.kind === 'fallback')).toBeUndefined();
  });

  it('retries server errors once then falls back', async () => {
    const c = new FakeClient().script('a', errorTurn(E500), errorTurn(E500)).script('b', okTurn());
    const { events, p } = run(make(c, ['a', 'b']));
    expect((await p).model).toBe('b');
    expect(kinds(events).filter((k) => k === 'retry')).toHaveLength(1);
    expect(kinds(events)).toContain('fallback');
  });

  it('does not retry auth failures', async () => {
    const c = new FakeClient().script('a', errorTurn(E401)).script('b', okTurn());
    const { events, p } = run(make(c, ['a', 'b'], { retries: 3 }));
    await p;
    expect(kinds(events)).not.toContain('retry');
  });

  it('never falls back after side effects', async () => {
    const c = new FakeClient().script('a', errorTurn(E401)).script('b', okTurn());
    const { events, p } = run(make(c, ['a', 'b']), { hasSideEffects: () => true });
    expect((await p).status).toBe('error');
    expect(kinds(events)).not.toContain('fallback');
    const done = loose(events.at(-1));
    expect(done.status).toBe('error');
    expect(done.message).toContain('already staged');
    expect(c.sessions).toHaveLength(1);
  });

  it('never falls back on MCP errors', async () => {
    const c = new FakeClient().script('a', errorTurn('[MCP Error] Failed to connect to remote MCP server')).script('b', okTurn());
    const { events, p } = run(make(c, ['a', 'b']));
    expect((await p).status).toBe('error');
    expect(kinds(events)).not.toContain('fallback');
    expect(loose(events.at(-1)).message).toContain('[MCP Error]');
  });

  it('does not fall back when disabled', async () => {
    const c = new FakeClient().script('a', errorTurn(E401)).script('b', okTurn());
    const { events, p } = run(make(c, ['a', 'b'], { fallbackEnabled: false }));
    expect((await p).status).toBe('error');
    expect(loose(events.at(-1)).message).toContain('fallback is turned off');
  });

  it('reports every model tried when the chain is exhausted', async () => {
    const c = new FakeClient().script('a', errorTurn(E401)).script('b', errorTurn('[Model Error] Cannot connect to API: ECONNREFUSED'));
    const { events, p } = run(make(c, ['a', 'b']));
    expect((await p).status).toBe('error');
    const msg = loose(events.at(-1)).message as string;
    expect(msg).toContain('a (authentication failed');
    expect(msg).toContain('b (provider unreachable');
    expect(msg).toContain('401');
  });

  it('starts from the per-mode pick', async () => {
    const c = new FakeClient().script('b', okTurn());
    const { p } = run(make(c, ['a', 'b']), { pick: 'b' });
    expect((await p).model).toBe('b');
    expect(c.sessions.map((s) => s.model)).toEqual(['b']);
  });

  it('abort cancels the session immediately and reports cancelled', async () => {
    const c = new FakeClient().script('a', { hang: true, before: okTurn().slice(0, 2) }).script('b', okTurn());
    const ac = new AbortController();
    const { events, p } = run(make(c, ['a', 'b']), { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    expect((await p).status).toBe('cancelled');
    expect(c.cancelled).toEqual(['s1']);
    expect(events.at(-1)).toMatchObject({ kind: 'done', status: 'cancelled' });
    expect(kinds(events)).not.toContain('fallback');
    expect(c.sessions).toHaveLength(1);
  });

  it('abort during backoff stops without another attempt', async () => {
    const c = new FakeClient().script('a', errorTurn(E429), okTurn());
    const ac = new AbortController();
    const r = new ModelRouter({ client: c, chain: ['a'], retries: 2, fallbackEnabled: true, sleep: async () => ac.abort() });
    const { events, p } = run(r, { signal: ac.signal });
    expect((await p).status).toBe('cancelled');
    expect(c.sessions).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'done', status: 'cancelled' });
  });

  it('errors clearly with an empty chain', async () => {
    const { events, p } = run(make(new FakeClient(), []));
    expect((await p).status).toBe('error');
    expect(loose(events.at(-1)).message).toMatch(/No model is configured/);
  });
});
