// Runs the pinned TrueForge release as a child process of the extension, the way an extension
// manages its own language server: started on demand, logged to an output channel, stopped on exit.
// If a TrueForge is already listening on the configured URL, Temper uses it and starts nothing.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { OUTBOUND_HOSTS, TRUEFORGE_VERSION } from '../host/trueforgeStart';

export type ServerState = 'idle' | 'starting' | 'running' | 'external' | 'failed';

export interface TrueForgeServerOptions {
  /** Server root, e.g. http://127.0.0.1:8790. */
  baseUrl(): string;
  /** Directory for TrueForge's SQLite database (it holds provider keys, so keep it user-private). */
  storageDir: string;
  log(line: string): void;
  /** Overridable for tests. */
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  readyTimeoutMs?: number;
  pollMs?: number;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Only a local URL can be served by a process we start. */
export function localPort(baseUrl: string): number | undefined {
  try {
    const u = new URL(baseUrl);
    if (!LOCAL_HOSTS.has(u.hostname)) return undefined;
    return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  } catch {
    return undefined;
  }
}

export class TrueForgeServer {
  private proc: ChildProcess | undefined;
  private pending: Promise<ServerState> | undefined;
  private _state: ServerState = 'idle';
  private lastError: string | undefined;
  onState?: (state: ServerState, error?: string) => void;

  constructor(private readonly opts: TrueForgeServerOptions) {}

  get state(): ServerState {
    return this._state;
  }

  get error(): string | undefined {
    return this.lastError;
  }

  private set(state: ServerState, error?: string): void {
    this._state = state;
    this.lastError = error;
    this.onState?.(state, error);
  }

  async reachable(): Promise<boolean> {
    const f = this.opts.fetchFn ?? fetch;
    try {
      const res = await f(this.opts.baseUrl(), { signal: AbortSignal.timeout(2000) });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  /** Make sure a TrueForge is answering; start one if none is. Concurrent calls share one start. */
  ensure(): Promise<ServerState> {
    this.pending ??= this.doEnsure().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async doEnsure(): Promise<ServerState> {
    if (await this.reachable()) {
      this.set(this.proc ? 'running' : 'external');
      return this._state;
    }
    const port = localPort(this.opts.baseUrl());
    if (port === undefined) {
      this.set('failed', `TrueForge is not reachable at ${this.opts.baseUrl()}, and Temper only starts TrueForge for a local URL.`);
      return this._state;
    }
    if (!this.proc) this.launch(port);
    if (this._state === 'failed') return this._state;
    return this.waitReady();
  }

  private launch(port: number): void {
    const dir = this.opts.storageDir;
    mkdirSync(dir, { recursive: true });
    const win = process.platform === 'win32';
    const args = ['-y', `@truefoundry/trueforge@${TRUEFORGE_VERSION}`, '--port', String(port)];
    this.opts.log(`starting TrueForge ${TRUEFORGE_VERSION} on port ${port} (data: ${dir})`);
    this.set('starting');
    // npx is a .cmd shim on Windows, which Node only runs through a shell; pass one command
    // string there (every part is a constant or an integer port, so nothing needs escaping).
    const [file, argv] = win ? [['npx.cmd', ...args].join(' '), []] : ['npx', args];
    const proc = (this.opts.spawnFn ?? spawn)(file, argv, {
      cwd: dir,
      env: {
        ...process.env,
        OUTBOUND_URL_ALLOWED_HOSTS: OUTBOUND_HOSTS,
        SQLITE_PATH: path.join(dir, 'trueforge.db'),
      },
      shell: win,
      windowsHide: true,
      // Own process group on POSIX so stop() can end npx and the server it starts.
      detached: !win,
    });
    this.proc = proc;
    const pipe = (chunk: Buffer) =>
      chunk
        .toString()
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .forEach((l) => this.opts.log(`[trueforge] ${l}`));
    proc.stdout?.on('data', pipe);
    proc.stderr?.on('data', pipe);
    proc.on('error', (e) => {
      const msg = /ENOENT/.test(String(e))
        ? 'Could not run npx. Install Node.js 22 or newer and restart VS Code.'
        : `Could not start TrueForge: ${e.message}`;
      this.opts.log(msg);
      if (this.proc === proc) this.proc = undefined;
      this.set('failed', msg);
    });
    proc.on('exit', (code, signal) => {
      this.opts.log(`TrueForge exited (${signal ?? `code ${code}`})`);
      if (this.proc !== proc) return;
      this.proc = undefined;
      if (this._state !== 'idle')
        this.set('failed', `TrueForge exited (${signal ?? `code ${code}`}). See the Temper output for its log.`);
    });
  }

  private async waitReady(): Promise<ServerState> {
    const timeout = this.opts.readyTimeoutMs ?? 180_000;
    const poll = this.opts.pollMs ?? 1500;
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (this._state === 'failed') return this._state;
      if (await this.reachable()) {
        this.opts.log('TrueForge is ready');
        this.set('running');
        return this._state;
      }
      await new Promise((r) => setTimeout(r, poll));
    }
    this.set('failed', 'TrueForge did not become ready within 3 minutes. See the Temper output for its log.');
    return this._state;
  }

  /** Stop the TrueForge this extension started. An external one is left alone. */
  stop(): void {
    const proc = this.proc;
    this.proc = undefined;
    this.set('idle');
    if (!proc?.pid) return;
    try {
      if (process.platform === 'win32') {
        // npx -> node: end the whole tree.
        spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
      } else {
        process.kill(-proc.pid, 'SIGTERM');
      }
    } catch {
      proc.kill();
    }
  }
}
