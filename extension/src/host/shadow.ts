// Shadow worktree: a throwaway copy of the workspace (tracked + untracked, minus ignored files)
// with the changeset's proposed files written over it, so allowlisted commands see pending edits
// without touching the user's tree.
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const COPY_CONCURRENCY = 32;

export interface OverlayFile {
  path: string; // workspace-relative, forward slashes
  content: string;
}

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

/** Files that belong to the project: `git ls-files -co --exclude-standard`, or a fallback walk when not a git repo. */
export async function listProjectFiles(root: string, fallbackWalk?: () => Promise<string[]>): Promise<string[]> {
  try {
    const out = await git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
    const files = out.split('\0').filter(Boolean);
    return [...new Set(files)];
  } catch {
    return fallbackWalk ? fallbackWalk() : [];
  }
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export class ShadowWorktree {
  readonly dir: string;
  private ready: Promise<void> | undefined;
  private copied = 0;

  constructor(
    private readonly root: string,
    runId: string,
    private readonly fallbackWalk?: () => Promise<string[]>,
    baseDir: string = os.tmpdir(),
  ) {
    this.dir = path.join(baseDir, `temper-shadow-${runId}`);
  }

  get fileCount(): number {
    return this.copied;
  }

  /** Copy the base tree once. */
  ensure(): Promise<void> {
    this.ready ??= this.copyBase();
    return this.ready;
  }

  private async copyBase(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const files = await listProjectFiles(this.root, this.fallbackWalk);
    const dirs = new Set<string>();
    for (const f of files) dirs.add(path.dirname(f));
    for (const d of [...dirs].sort()) await fsp.mkdir(path.join(this.dir, d), { recursive: true });
    await pool(files, COPY_CONCURRENCY, async (rel) => {
      const src = path.join(this.root, rel);
      try {
        const st = await fsp.stat(src);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
        await fsp.copyFile(src, path.join(this.dir, rel));
        this.copied++;
      } catch {
        /* deleted since listing, unreadable, or a submodule directory: skip */
      }
    });
  }

  /** Write the changeset's proposed files over the copy (call before every command). */
  async sync(overlay: OverlayFile[]): Promise<void> {
    await this.ensure();
    for (const f of overlay) {
      const dest = path.join(this.dir, ...f.path.split('/'));
      if (path.relative(this.dir, dest).startsWith('..')) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, f.content, 'utf8');
    }
  }

  async dispose(): Promise<void> {
    try {
      await fsp.rm(this.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* best effort; the OS temp dir is cleaned eventually */
    }
  }
}

/** Environment for a command that should use the workspace's virtualenv against the shadow copy. */
export function shadowEnv(base: NodeJS.ProcessEnv, workspaceRoot: string, shadowDir: string | undefined, platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PYTHONDONTWRITEBYTECODE: '1' };
  const sep = platform === 'win32' ? ';' : ':';
  const venv = path.join(workspaceRoot, '.venv');
  const bin = path.join(venv, platform === 'win32' ? 'Scripts' : 'bin');
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${bin}${sep}${env[pathKey] ?? ''}`;
  env.VIRTUAL_ENV = venv;
  if (shadowDir) {
    const parts = [path.join(shadowDir, 'src'), shadowDir];
    if (env.PYTHONPATH) parts.push(env.PYTHONPATH);
    env.PYTHONPATH = parts.join(sep);
  }
  return env;
}
