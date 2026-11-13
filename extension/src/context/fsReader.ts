// Node `fs` adapter for WorkspaceReader (the integrator adds a vscode.workspace.fs one).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkspaceReader } from './types';

export const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  'dist',
  'build',
  'out',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.idea',
  '.next',
  'coverage',
  '.eggs',
  '.trueforge',
  '*.egg-info',
  '*.min.js',
  '*.map',
  '*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
];

/** Matches a workspace-relative path against exclude patterns (segment names, `*.ext`, `*suffix`). */
export function isExcluded(rel: string, excludes: string[]): boolean {
  const segs = rel.split('/');
  for (const ex of excludes) {
    if (ex.startsWith('*')) {
      const suffix = ex.slice(1);
      if (segs.some((s) => s.endsWith(suffix))) return true;
    } else if (ex.includes('/')) {
      if (rel === ex || rel.startsWith(ex + '/')) return true;
    } else if (segs.includes(ex)) return true;
  }
  return false;
}

export const BINARY_EXT = new Set(
  (
    'png jpg jpeg gif bmp ico webp svgz pdf zip gz tgz bz2 xz 7z rar tar jar war class pyc pyo so dll dylib exe bin ' +
    'woff woff2 ttf otf eot mp3 mp4 mov avi wav ogg webm sqlite db pickle pkl npy npz whl vsix mo'
  ).split(' '),
);

export interface NodeReaderOptions {
  /** Files larger than this are reported as unreadable. */
  maxBytes?: number;
}

export function createNodeReader(root: string, opts: NodeReaderOptions = {}): WorkspaceReader {
  const maxBytes = opts.maxBytes ?? 300 * 1024;
  const abs = path.resolve(root);
  return {
    root: abs,
    async listFiles(excludes: string[]): Promise<string[]> {
      const out: string[] = [];
      async function walk(dir: string, rel: string): Promise<void> {
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        const subs: Promise<void>[] = [];
        for (const e of entries) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (isExcluded(r, excludes)) continue;
          if (e.isDirectory()) subs.push(walk(path.join(dir, e.name), r));
          else if (e.isFile()) out.push(r);
        }
        await Promise.all(subs);
      }
      await walk(abs, '');
      return out.sort();
    },
    async readFile(rel: string): Promise<string | undefined> {
      try {
        const buf = await fs.readFile(path.join(abs, rel));
        if (buf.length > maxBytes) return undefined;
        const probe = buf.subarray(0, 4096);
        if (probe.includes(0)) return undefined;
        return buf.toString('utf8');
      } catch {
        return undefined;
      }
    },
  };
}
