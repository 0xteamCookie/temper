import { describe, expect, it } from 'vitest';
import type { HostMessage } from '../../src/shared/messages';
import { SessionCoordinator } from '../../src/host/sessionCoordinator';
import type { SessionHistory } from '../../src/host/sessionHistory';

function setup(opts: { running?: boolean; stored?: string; loadError?: unknown } = {}) {
  const posts: HostMessage[] = [];
  const titles: [string, string][] = [];
  const state = {
    stored: opts.stored as string | undefined,
    session: undefined as { id: string; model?: string } | undefined,
    running: !!opts.running,
  };
  const history = {
    list: async (token?: string) => ({
      sessions: [{ id: 'x', title: 't', createdAt: '', updatedAt: '', turns: 1 }],
      nextPageToken: token ? undefined : 'n',
    }),
    load: async (id: string) => {
      if (opts.loadError) throw opts.loadError;
      return {
        turns: [{ turnId: 't1', user: 'hi', events: [] }],
        model: 'p/m',
        lastStatus: id === 'busy' ? 'paused' : 'done',
      };
    },
  } as unknown as SessionHistory;
  const c = new SessionCoordinator({
    history,
    controller: {
      get isRunning() {
        return state.running;
      },
      setSession: (s) => void (state.session = s),
      cancel: () => undefined,
    },
    store: { get: () => state.stored, set: (id) => void (state.stored = id) },
    post: (m) => posts.push(m),
    setTitle: async (id, title) => void titles.push([id, title]),
    log: () => undefined,
  });
  return { c, posts, titles, state };
}

describe('SessionCoordinator', () => {
  it('persists a joined session and titles only a new one', () => {
    const { c, titles, state, posts } = setup();
    c.onSession({ sessionId: 's1', isNew: true, label: 'Fix the   bug' });
    c.onSession({ sessionId: 's1', isNew: false, label: 'follow up' });
    expect(state.stored).toBe('s1');
    expect(titles).toEqual([['s1', 'Fix the bug']]);
    expect(posts.at(-1)).toEqual({ type: 'session.current', sessionId: 's1' });
  });

  it('pages the history', async () => {
    const { c, posts } = setup();
    await c.list();
    await c.list('n');
    expect(posts[0]).toMatchObject({ type: 'history.page', append: false, nextPageToken: 'n' });
    expect(posts[1]).toMatchObject({ type: 'history.page', append: true });
  });

  it('loads a session, makes it current and flags an unfinished last turn', async () => {
    const { c, posts, state } = setup();
    await c.load('busy');
    expect(state.session).toEqual({ id: 'busy', model: 'p/m' });
    expect(state.stored).toBe('busy');
    expect(posts[0]).toMatchObject({ type: 'session.loaded', sessionId: 'busy' });
    expect((posts[0] as { notice?: string }).notice).toMatch(/still running/);
    await c.load('ok');
    expect((posts[2] as { notice?: string }).notice).toBeUndefined();
  });

  it('refuses to switch sessions or start a new chat during a run', async () => {
    const { c, posts, state } = setup({ running: true });
    await c.load('s2');
    expect(posts[0]).toMatchObject({ type: 'session.loadFailed' });
    expect(c.newChat()).toBe(false);
    expect(state.session).toBeUndefined();
  });

  it('new chat forgets the session', () => {
    const { c, state } = setup({ stored: 's1' });
    expect(c.newChat()).toBe(true);
    expect(state.stored).toBeUndefined();
    expect(state.session).toBeUndefined();
  });

  it('restores the remembered session on reload', async () => {
    const { c, posts, state } = setup({ stored: 's1' });
    await c.restore();
    expect(state.session).toEqual({ id: 's1', model: 'p/m' });
    expect(posts.map((m) => m.type)).toEqual(['session.current', 'session.loaded']);
  });

  it('keeps continuing the session when the transcript cannot be fetched, but forgets a deleted one', async () => {
    const offline = setup({ stored: 's1', loadError: new Error('offline') });
    await offline.c.restore();
    expect(offline.state.session).toEqual({ id: 's1' });
    expect(offline.state.stored).toBe('s1');

    const gone = setup({
      stored: 's1',
      loadError: Object.assign(new Error('not found'), { status: 404 }),
    });
    await gone.c.restore();
    expect(gone.state.session).toBeUndefined();
    expect(gone.state.stored).toBeUndefined();
  });

  it('does nothing on restore without a remembered session', async () => {
    const { c, posts } = setup();
    await c.restore();
    expect(posts).toEqual([]);
  });
});
