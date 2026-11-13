import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
import { defineTool, ToolError } from '../tool';
import type { ToolContext } from '../tool';
import { looksBinary, normalizeRelPath } from '../util';
import type { Workspace } from '../workspace';

const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_CHARS = 240;

export interface Match {
  path: string;
  line: number;
  text: string;
}

let rgAvailable: boolean | undefined;
function hasRipgrep(): boolean {
  if (rgAvailable === undefined) {
    try {
      rgAvailable = spawnSync('rg', ['--version'], { timeout: 3000, windowsHide: true }).status === 0;
    } catch {
      rgAvailable = false;
    }
  }
  return rgAvailable;
}

function buildMatcher(query: string, regex: boolean): RegExp {
  const smartInsensitive = query === query.toLowerCase();
  const flags = smartInsensitive ? 'i' : '';
  if (!regex) return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  try {
    return new RegExp(query, flags);
  } catch (e) {
    throw new ToolError(`Invalid regex "${query}": ${(e as Error).message}. Escape special characters or set regex=false for a literal search.`);
  }
}

export async function searchWithNode(
  ws: Workspace,
  files: string[],
  re: RegExp,
  limit: number,
  signal?: AbortSignal,
): Promise<{ matches: Match[]; capped: boolean }> {
  const matches: Match[] = [];
  let capped = false;
  const BATCH = 32;
  for (let i = 0; i < files.length && !capped; i += BATCH) {
    if (signal?.aborted) throw new ToolError('Search cancelled.');
    const batch = files.slice(i, i + BATCH);
    const texts = await Promise.all(batch.map((f) => ws.readFile(f)));
    for (let j = 0; j < batch.length && !capped; j++) {
      const text = texts[j];
      if (text === undefined || text.length > MAX_FILE_BYTES || looksBinary(text)) continue;
      const lines = text.split('\n');
      for (let k = 0; k < lines.length; k++) {
        const l = lines[k]!;
        if (re.test(l)) {
          if (matches.length >= limit) {
            capped = true;
            break;
          }
          matches.push({ path: batch[j]!, line: k + 1, text: l.replace(/\r$/, '') });
        }
      }
    }
  }
  return { matches, capped };
}

function searchWithRg(root: string, query: string, regex: boolean, glob: string | undefined, signal?: AbortSignal): Promise<Match[] | undefined> {
  return new Promise((resolve) => {
    const args = ['--no-heading', '--line-number', '--with-filename', '--color', 'never', '--smart-case', '--max-filesize', '1M', '--max-columns', '400'];
    if (!regex) args.push('--fixed-strings');
    for (const d of ['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build']) args.push('--glob', `!${d}/`);
    if (glob) args.push('--glob', glob.includes('/') || glob.includes('*') ? glob : `**/${glob}`);
    args.push('-e', query, '--', '.');
    const child = spawn('rg', args, { cwd: root, windowsHide: true, signal });
    const out: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => {
      if (code !== 0 && code !== 1) return resolve(undefined);
      const res: Match[] = [];
      for (const raw of Buffer.concat(out).toString('utf8').split('\n')) {
        const m = /^(?:\.[\\/])?(.+?):(\d+):(.*)$/.exec(raw.replace(/\r$/, ''));
        if (m) res.push({ path: m[1]!.replace(/\\/g, '/'), line: Number(m[2]), text: m[3]! });
      }
      resolve(res);
    });
  });
}

function format(matches: Match[], capped: boolean, limit: number, query: string): string {
  if (!matches.length) {
    return `No matches for "${query}". Try a shorter or different term, set regex=true for patterns, or drop the glob filter. find_symbol searches definitions by name.`;
  }
  const byFile = new Map<string, Match[]>();
  for (const m of matches) {
    const a = byFile.get(m.path);
    if (a) a.push(m);
    else byFile.set(m.path, [m]);
  }
  const out: string[] = [`${matches.length}${capped ? '+' : ''} matches in ${byFile.size} files`];
  for (const [p, ms] of byFile) {
    out.push('', p);
    for (const m of ms) {
      const t = m.text.trim();
      out.push(`${p}:${m.line}: ${t.length > MAX_LINE_CHARS ? t.slice(0, MAX_LINE_CHARS) + '...' : t}`);
    }
  }
  if (capped) out.push('', `[Results capped at ${limit}. Narrow with glob (e.g. "src/**/*.py") or a more specific query, or raise max_results.]`);
  return out.join('\n');
}

export async function runSearch(
  ctx: ToolContext,
  args: { query: string; glob?: string; regex?: boolean; max_results?: number },
  opts: { useRipgrep?: boolean } = {},
): Promise<string> {
  const { workspace, signal } = ctx;
  const limit = args.max_results ?? 50;
  if (!args.query) throw new ToolError('query must not be empty.');
  const re = buildMatcher(args.query, args.regex ?? false);
  const glob = args.glob?.trim() ? args.glob.trim() : undefined;

  const useRg = (opts.useRipgrep ?? ctx.services['ripgrep'] !== false) && hasRipgrep();
  if (useRg) {
    const rg = await searchWithRg(workspace.root, args.query, args.regex ?? false, glob, signal);
    if (rg) {
      // The overlay (staged edits) is invisible to rg: drop stale hits and re-search dirty files in Node.
      const dirty = new Set(workspace.dirtyPaths?.() ?? []);
      let all = rg.filter((m) => !dirty.has(m.path));
      if (dirty.size) {
        const files = await workspace.walk({ glob });
        const extra = await searchWithNode(workspace, files.filter((f) => dirty.has(f)), re, limit, signal);
        all = all.concat(extra.matches);
      }
      all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
      return format(all.slice(0, limit), all.length > limit, limit, args.query);
    }
  }
  const files = await workspace.walk({ glob });
  const { matches, capped } = await searchWithNode(workspace, files, re, limit, signal);
  return format(matches, capped, limit, args.query);
}

export const searchCodeTool = defineTool({
  name: 'search_code',
  description:
    'Search file contents across the workspace (like grep/ripgrep). Returns "path:line: text" grouped by file. ' +
    'Default is a literal, smart-case match (case-insensitive unless the query has capitals); set regex=true for regular expressions ' +
    '(e.g. "def \\w+_handler"). Use glob to restrict files, e.g. "*.py" (any depth) or "src/**/*.ts". ' +
    'Best for strings, usages, error messages and config keys. For where a function/class is DEFINED prefer find_symbol. ' +
    'Results are capped (default 50): if capped, narrow the query or glob rather than raising max_results. ' +
    'Follow up with read_file around a hit to see context.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Text or regex to look for'),
    glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.py", "src/**/*.ts"'),
    regex: z.boolean().optional().describe('Treat query as a regular expression (default false = literal text)'),
    max_results: z.number().int().min(1).max(500).optional().describe('Maximum matching lines to return (default 50)'),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(args, ctx) {
    if (args.glob) normalizeRelPath(args.glob.replace(/\*/g, 'x'), ctx.workspace.root); // reject escapes
    return runSearch(ctx, args);
  },
});
