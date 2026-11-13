// Ties the current TrueForge session to the panel: persists it, titles new sessions, serves the
// History view and rebuilds a chat from a stored session. No vscode imports (the store is injected).
import type { HostMessage } from '../shared/messages';
import type { SessionHistory } from './sessionHistory';
import { trimTitle, UNFINISHED_NOTICE } from './sessionHistory';

export interface SessionStore {
  get(): string | undefined;
  set(id: string | undefined): void;
}

/** The part of RunController the coordinator drives. */
export interface SessionTarget {
  readonly isRunning: boolean;
  setSession(session: { id: string; model?: string } | undefined): void;
  /** Discards any leftover partial review (and stops a run, which callers rule out first). */
  cancel(): void;
}

export interface CoordinatorDeps {
  history: SessionHistory;
  controller: SessionTarget;
  store: SessionStore;
  post(m: HostMessage): void;
  setTitle(sessionId: string, title: string): Promise<void>;
  log(line: string): void;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class SessionCoordinator {
  constructor(private readonly d: CoordinatorDeps) {}

  /** A run joined `sessionId`: remember it and, for a fresh session, title it from the first message. */
  onSession(info: { sessionId: string; isNew: boolean; label: string }): void {
    this.d.store.set(info.sessionId);
    this.d.post({ type: 'session.current', sessionId: info.sessionId });
    if (!info.isNew) return;
    const title = trimTitle(info.label);
    if (!title) return;
    this.d
      .setTitle(info.sessionId, title)
      .catch((e) => this.d.log(`could not title session ${info.sessionId}: ${msg(e)}`));
  }

  async list(pageToken?: string): Promise<void> {
    try {
      const page = await this.d.history.list(pageToken);
      this.d.post({
        type: 'history.page',
        sessions: page.sessions,
        nextPageToken: page.nextPageToken,
        append: !!pageToken,
      });
    } catch (e) {
      this.d.post({ type: 'history.page', sessions: [], append: !!pageToken, error: msg(e) });
    }
  }

  /** Make `id` the current session and replace the chat with its transcript. */
  async load(id: string): Promise<void> {
    if (this.d.controller.isRunning) {
      this.d.post({
        type: 'session.loadFailed',
        sessionId: id,
        message: 'Stop the current run before opening another session.',
      });
      return;
    }
    try {
      const t = await this.d.history.load(id);
      this.d.controller.cancel();
      this.d.controller.setSession({ id, model: t.model });
      this.d.store.set(id);
      const unfinished = t.lastStatus === 'running' || t.lastStatus === 'paused';
      this.d.post({
        type: 'session.loaded',
        sessionId: id,
        turns: t.turns,
        ...(unfinished ? { notice: UNFINISHED_NOTICE } : {}),
      });
      this.d.post({ type: 'session.current', sessionId: id });
    } catch (e) {
      this.d.post({ type: 'session.loadFailed', sessionId: id, message: msg(e) });
    }
  }

  /** Clear the chat; the next message starts a new session. Returns false while a run is active. */
  newChat(): boolean {
    if (this.d.controller.isRunning) return false;
    this.d.controller.cancel();
    this.d.controller.setSession(undefined);
    this.d.store.set(undefined);
    this.d.post({ type: 'session.current', sessionId: undefined });
    return true;
  }

  /**
   * The panel (re)opened: continue the remembered session and rebuild its transcript. The session is
   * continued even if the transcript cannot be fetched (offline); a session that no longer exists is forgotten.
   */
  async restore(): Promise<void> {
    const id = this.d.store.get();
    if (!id || this.d.controller.isRunning) return;
    this.d.controller.setSession({ id });
    this.d.post({ type: 'session.current', sessionId: id });
    try {
      const t = await this.d.history.load(id);
      if (this.d.controller.isRunning) return;
      this.d.controller.setSession({ id, model: t.model });
      const unfinished = t.lastStatus === 'running' || t.lastStatus === 'paused';
      this.d.post({
        type: 'session.loaded',
        sessionId: id,
        turns: t.turns,
        ...(unfinished ? { notice: UNFINISHED_NOTICE } : {}),
      });
    } catch (e) {
      this.d.log(`could not restore session ${id}: ${msg(e)}`);
      if ((e as { status?: number }).status === 404) {
        this.d.controller.setSession(undefined);
        this.d.store.set(undefined);
        this.d.post({ type: 'session.current', sessionId: undefined });
      }
    }
  }
}
