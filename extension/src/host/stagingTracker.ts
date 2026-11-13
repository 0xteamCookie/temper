// Tracks staging tool calls (propose_edit / create_file) that are still running for one run, so
// submit_changeset and the approval -> review step can wait for them. The model often emits
// propose_edit and submit_changeset in the SAME batch; without this, submit inspects an empty changeset.

/** How long submit_changeset / the review wait for in-flight staging calls before giving up. */
export const STAGING_WAIT_MS = 5000;

export const STAGING_TOOLS: ReadonlySet<string> = new Set(['propose_edit', 'create_file']);

export class StagingTracker {
  private readonly keys = new Set<string>();
  private waiters: Array<() => void> = [];
  private seq = 0;

  get pending(): number {
    return this.keys.size;
  }

  /** Mark a staging call as started (idempotent per key). Pair with end(). */
  begin(key: string): void {
    this.keys.add(key);
  }

  end(key: string): void {
    if (!this.keys.delete(key)) return;
    if (this.keys.size === 0) this.release();
  }

  /** Run `fn` as an in-flight staging call; registered synchronously, released when it settles. */
  track<T>(fn: () => Promise<T>): Promise<T> {
    const key = `h${++this.seq}`;
    this.begin(key);
    return fn().finally(() => this.end(key));
  }

  clear(): void {
    this.keys.clear();
    this.release();
  }

  /** Resolves true once nothing is in flight, false if `timeoutMs` elapses first. */
  settle(timeoutMs: number = STAGING_WAIT_MS): Promise<boolean> {
    if (this.keys.size === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => finish(this.keys.size === 0), timeoutMs);
      this.waiters.push(() => finish(true));
    });
  }

  private release(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
}

const trackers = new WeakMap<object, StagingTracker>();

/** The tracker of a run object (created on first use, so plain test runs work too). */
export function stagingOf(run: object): StagingTracker {
  let t = trackers.get(run);
  if (!t) {
    t = new StagingTracker();
    trackers.set(run, t);
  }
  return t;
}
