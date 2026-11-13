// Runs an allowlisted command (no shell) with a timeout, abort support and tail-truncated output.
import { spawn, execFile } from 'node:child_process';
import { tailTruncate } from './commandPolicy';

export interface RunCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutput?: number;
}

export interface RunCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  output: string;
  spawnError?: string;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

export function runArgv(argv: string[], opts: RunCommandOptions): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const maxOutput = opts.maxOutput ?? 8000;
    let buf = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const cap = maxOutput * 8;

    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (d: Buffer) => {
      buf += d.toString('utf8');
      if (buf.length > cap) buf = buf.slice(buf.length - cap);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const finish = (r: Omit<RunCommandResult, 'output' | 'timedOut' | 'aborted'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ ...r, timedOut, aborted, output: tailTruncate(buf.trim(), maxOutput) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => finish({ exitCode: null, spawnError: e.message }));
    child.on('close', (code) => finish({ exitCode: code }));
  });
}
