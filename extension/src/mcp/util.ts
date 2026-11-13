import { ToolError } from './tool';

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
}

/** Glob to RegExp. Supports **, *, ?, {a,b}. Matches posix relative paths. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) {
        re += '(?:' + g.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')';
        i = end;
      } else re += '\\{';
    } else re += escapeRe(c);
  }
  // A glob naming a directory-ish prefix without a trailing wildcard also matches beneath it.
  return new RegExp('^' + re + (/[*?}]$/.test(g) ? '' : '(?:/.*)?') + '$');
}

/** True when a path matches a glob; globs without "/" match the basename at any depth. */
export function matchesGlob(re: RegExp, glob: string, p: string): boolean {
  if (re.test(p)) return true;
  return !glob.includes('/') && re.test(p.split('/').pop()!);
}

/** Normalize a user/model path to a safe workspace-relative posix path. */
export function normalizeRelPath(input: string, root: string): string {
  let p = input.trim().replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (p.toLowerCase().startsWith(r.toLowerCase() + '/')) p = p.slice(r.length + 1);
  else if (p.toLowerCase() === r.toLowerCase()) p = '';
  p = p.replace(/^\/+/, '');
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) {
        throw new ToolError(`Path "${input}" escapes the workspace. Use a workspace-relative path like "src/app.py".`);
      }
      parts.pop();
    } else parts.push(seg);
  }
  if (/^[a-zA-Z]:/.test(parts[0] ?? '')) {
    throw new ToolError(`Path "${input}" is outside the workspace root. Use a workspace-relative path.`);
  }
  return parts.join('/');
}

export function looksBinary(s: string): boolean {
  return s.slice(0, 4096).includes('\u0000');
}

/** Cheap "did you mean" suggestions by basename similarity. */
export async function suggestPaths(walk: () => Promise<string[]>, rel: string, n = 5): Promise<string[]> {
  const base = (rel.split('/').pop() ?? rel).toLowerCase();
  const stem = base.replace(/\.[^.]+$/, '');
  const files = await walk();
  const scored: Array<[number, string]> = [];
  for (const f of files) {
    const fb = (f.split('/').pop() ?? f).toLowerCase();
    const fstem = fb.replace(/\.[^.]+$/, '');
    let s = 0;
    if (fb === base) s = 100;
    else if (stem && fstem && (fb.includes(stem) || stem.includes(fstem))) s = 50;
    else if (base && f.toLowerCase().includes(base)) s = 30;
    if (s) scored.push([s - f.length / 1000, f]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, n).map((x) => x[1]);
}

export function truncateChars(s: string, max: number, hint: string): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [output truncated at ${max} chars. ${hint}]`;
}
