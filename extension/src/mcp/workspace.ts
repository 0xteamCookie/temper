import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { globToRegExp, matchesGlob } from './util';

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface WalkOptions {
  /** Glob (relative, posix) a file path must match, e.g. "**\/*.py" or "src/**". */
  glob?: string;
  maxFiles?: number;
}

/**
 * Editor-independent view of the workspace. All paths are workspace-relative, posix-separated.
 * Implementations must honor the changeset overlay (staged content wins over disk, staged new
 * files appear in walk/listDir/exists).
 */
export interface Workspace {
  /** Absolute workspace root. */
  readonly root: string;
  /** Contents, or undefined when the file does not exist (or is a directory). */
  readFile(relPath: string): Promise<string | undefined>;
  /** Directory entries (unfiltered), or undefined when not a directory. */
  listDir(relPath: string): Promise<DirEntry[] | undefined>;
  exists(relPath: string): Promise<boolean>;
  /** All files (relative paths, sorted), skipping excluded directories (see isExcludedName). */
  walk(opts?: WalkOptions): Promise<string[]>;
  /** Paths whose overlay content differs from disk; lets ripgrep results be corrected. */
  dirtyPaths?(): string[];
}

const EXCLUDED = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.tox',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.idea', '.next', 'coverage', '.eggs',
]);

export function isExcludedName(name: string): boolean {
  return EXCLUDED.has(name) || name.endsWith('.egg-info');
}

/** Node-fs workspace with an optional in-memory overlay (null value = deleted). */
export class NodeWorkspace implements Workspace {
  readonly root: string;
  readonly overlay: Map<string, string | null>;

  constructor(root: string, overlay: Map<string, string | null> = new Map()) {
    this.root = path.resolve(root);
    this.overlay = overlay;
  }

  private abs(rel: string): string {
    return path.join(this.root, rel);
  }

  async readFile(rel: string): Promise<string | undefined> {
    if (this.overlay.has(rel)) return this.overlay.get(rel) ?? undefined;
    try {
      const st = await fs.stat(this.abs(rel));
      if (!st.isFile()) return undefined;
      return await fs.readFile(this.abs(rel), 'utf8');
    } catch {
      return undefined;
    }
  }

  async listDir(rel: string): Promise<DirEntry[] | undefined> {
    const prefix = rel === '' ? '' : rel.replace(/\/$/, '') + '/';
    const out = new Map<string, DirEntry>();
    let found = false;
    try {
      for (const d of await fs.readdir(this.abs(rel), { withFileTypes: true })) {
        out.set(d.name, { name: d.name, isDir: d.isDirectory() });
      }
      found = true;
    } catch {
      /* may still exist in overlay */
    }
    for (const [p, content] of this.overlay) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const first = rest.split('/')[0]!;
      const isDir = rest.includes('/');
      if (content === null) {
        if (!isDir) out.delete(first);
      } else {
        out.set(first, { name: first, isDir });
        found = true;
      }
    }
    return found ? [...out.values()] : undefined;
  }

  async exists(rel: string): Promise<boolean> {
    if (this.overlay.has(rel)) return this.overlay.get(rel) !== null;
    try {
      await fs.stat(this.abs(rel));
      return true;
    } catch {
      return false;
    }
  }

  async walk(opts: WalkOptions = {}): Promise<string[]> {
    const max = opts.maxFiles ?? 100_000;
    const files = new Set<string>();
    const visit = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!isExcludedName(e.name)) await visit(p);
        } else if (e.isFile()) files.add(p);
      }
    };
    await visit('');
    for (const [p, c] of this.overlay) {
      if (c === null) files.delete(p);
      else if (!p.split('/').some(isExcludedName)) files.add(p);
    }
    let all = [...files].sort();
    if (opts.glob) {
      const re = globToRegExp(opts.glob);
      all = all.filter((p) => matchesGlob(re, opts.glob!, p));
    }
    return all.slice(0, max);
  }

  dirtyPaths(): string[] {
    return [...this.overlay.keys()];
  }
}
