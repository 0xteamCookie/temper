// Built-in regex / indentation based symbol extractors (Python, TS/JS, generic code, rst/md headings).
// Good enough to build a symbol table without a language server; a SymbolSource (e.g. LSP) can
// replace it per file.
import type { FileRole, Lang, SymbolDef, SymbolKind } from './types';

const EXT_LANG: Record<string, Lang> = {
  py: 'python',
  pyi: 'python',
  ts: 'ts',
  tsx: 'ts',
  js: 'ts',
  jsx: 'ts',
  mjs: 'ts',
  cjs: 'ts',
  mts: 'ts',
  cts: 'ts',
  rst: 'doc',
  md: 'doc',
  mdx: 'doc',
  go: 'generic',
  rs: 'generic',
  java: 'generic',
  kt: 'generic',
  c: 'generic',
  h: 'generic',
  cpp: 'generic',
  hpp: 'generic',
  cs: 'generic',
  rb: 'generic',
  php: 'generic',
  swift: 'generic',
  sh: 'generic',
};

export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
}

export function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i <= 0 ? base : base.slice(0, i);
}

export function langOf(path: string): Lang {
  return EXT_LANG[extOf(path)] ?? 'text';
}

const TEST_FILE_RE = /(^|\/)(test_[^/]*|[^/]*_test\.[a-z]+|[^/]*\.(test|spec)\.[a-z]+|conftest\.py)$/;
const TEST_DIR_RE = /(^|\/)(tests?|__tests__|spec)\//;

export function roleOf(path: string, lang: Lang): FileRole {
  if (lang === 'doc' || /\.(txt|adoc)$/.test(path)) return 'doc';
  if (TEST_FILE_RE.test(path) || TEST_DIR_RE.test(path)) return lang === 'python' || lang === 'ts' || lang === 'generic' ? 'test' : 'other';
  if (lang === 'python' || lang === 'ts' || lang === 'generic') return 'source';
  if (/\.(toml|cfg|ini|ya?ml|json)$/.test(path)) return 'config';
  return 'other';
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

function count(s: string, ch: string): number {
  let n = 0;
  for (let i = s.indexOf(ch); i !== -1; i = s.indexOf(ch, i + 1)) n++;
  return n;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ------------------------------ Python ------------------------------ */

const PY_DEF = /^(\s*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/;
const PY_VAR = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/;

function pythonSymbols(path: string, lines: string[]): SymbolDef[] {
  const n = lines.length;
  // Mark lines that start a statement (non-blank, not inside a triple-quoted string continuation).
  const stmt: boolean[] = new Array<boolean>(n).fill(false);
  const indent: number[] = new Array<number>(n).fill(0);
  let delim: string | null = null;
  for (let i = 0; i < n; i++) {
    const line = lines[i] ?? '';
    indent[i] = indentOf(line);
    const blank = line.trim() === '';
    if (delim) {
      if (line.includes(delim)) {
        const rest = line.slice(line.indexOf(delim) + 3);
        delim = count(rest, delim) % 2 === 1 ? delim : null;
      }
      continue;
    }
    if (blank) continue;
    stmt[i] = !line.trimStart().startsWith('#');
    for (const d of ['"""', "'''"]) {
      if (count(line, d) % 2 === 1) {
        delim = d;
        break;
      }
    }
  }

  const out: SymbolDef[] = [];
  const stack: { indent: number; kind: SymbolKind; name: string }[] = [];
  for (let i = 0; i < n; i++) {
    if (!stmt[i]) continue;
    const line = lines[i] ?? '';
    const m = PY_DEF.exec(line);
    const ind = indent[i] ?? 0;
    while (stack.length && ind <= (stack[stack.length - 1]?.indent ?? 0)) stack.pop();
    if (!m) {
      if (ind === 0 && stack.length === 0) {
        const v = PY_VAR.exec(line);
        if (v && v[1] && v[1] !== '__all__') {
          out.push({ name: v[1], kind: 'variable', path, line: i + 1, startLine: i + 1, endLine: i + 1, signature: clip(line.trim(), 100) });
        }
      }
      continue;
    }
    const isClass = m[2] === 'class';
    const name = m[3] ?? '';
    const top = stack[stack.length - 1];
    const include = stack.length === 0 || top?.kind === 'class';
    stack.push({ indent: ind, kind: isClass ? 'class' : 'function', name });
    if (!include) continue;

    // Signature: until the paren-balanced line ending with ':'.
    let sig = '';
    let depth = 0;
    let sigEnd = i;
    for (let j = i; j < Math.min(n, i + 12); j++) {
      const t = (lines[j] ?? '').replace(/#.*$/, '').trim();
      sig += (sig ? ' ' : '') + t;
      depth += count(t, '(') + count(t, '[') - count(t, ')') - count(t, ']');
      sigEnd = j;
      if (depth <= 0 && t.endsWith(':')) break;
    }
    sig = sig.replace(/\s+/g, ' ').replace(/:$/, '');

    // Docstring first line.
    let doc: string | undefined;
    let k = sigEnd + 1;
    while (k < n && (lines[k] ?? '').trim() === '') k++;
    const dm = /^\s*[rRuUbB]{0,2}("""|''')(.*)$/.exec(lines[k] ?? '');
    if (dm) {
      let text = dm[2] ?? '';
      if (!text.trim()) text = lines[k + 1] ?? '';
      text = text.replace(/("""|''')[\s\S]*$/, '').trim();
      if (text) doc = clip(text, 110);
    }

    // End: before the next statement at indent <= definition indent.
    let end = sigEnd;
    for (let j = sigEnd + 1; j < n; j++) {
      if (!stmt[j]) {
        continue;
      }
      if ((indent[j] ?? 0) <= ind && !/^\s*[)\]}]/.test(lines[j] ?? '')) break;
      end = j;
    }
    // Include trailing lines of a multi-line string at the end of the body.
    while (end + 1 < n && !stmt[end + 1] && (lines[end + 1] ?? '').trim() !== '' && (indent[end + 1] ?? 0) > ind) end++;

    // Decorators (walk back, tolerating multi-line decorator calls).
    let start = i;
    let kk = i - 1;
    while (kk >= 0) {
      const t = (lines[kk] ?? '').trim();
      if (t.startsWith('@') && (indent[kk] ?? 0) === ind) {
        start = kk;
        kk--;
        continue;
      }
      if (t.endsWith(')') || t.endsWith(',')) {
        let d = 0;
        let found = -1;
        for (let m2 = kk; m2 >= 0 && m2 > kk - 20; m2--) {
          const tt = lines[m2] ?? '';
          d += count(tt, ')') - count(tt, '(');
          if (tt.trim().startsWith('@') && d <= 0 && (indent[m2] ?? 0) === ind) {
            found = m2;
            break;
          }
        }
        if (found >= 0) {
          start = found;
          kk = found - 1;
          continue;
        }
      }
      break;
    }
    let decorator: string | undefined;
    for (let d = start; d < i; d++) {
      const t = (lines[d] ?? '').trim();
      if (t.startsWith('@')) {
        decorator = clip(t, 70);
        break;
      }
    }

    const parent = top?.kind === 'class' ? top.name : undefined;
    out.push({
      name,
      kind: isClass ? 'class' : parent ? 'method' : 'function',
      path,
      line: i + 1,
      startLine: start + 1,
      endLine: end + 1,
      signature: clip(sig, 160),
      ...(doc ? { doc } : {}),
      ...(parent ? { parent } : {}),
      ...(decorator ? { decorator } : {}),
    });
  }
  return out;
}

/* ---------------------------- TypeScript / JS ---------------------------- */

const TS_DECL =
  /^(\s*)(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(async\s+function\*?|function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
const TS_CONST = /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/;
const TS_METHOD =
  /^(\s+)(?:(?:public|private|protected|static|async|override|readonly|abstract|get|set)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const TS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'constructor_', 'super', 'with', 'else']);

function stripStrings(s: string): string {
  return s
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '');
}

function braceEnd(lines: string[], from: number): number {
  let depth = 0;
  let seen = false;
  for (let j = from; j < Math.min(lines.length, from + 3000); j++) {
    const t = stripStrings(lines[j] ?? '');
    for (const ch of t) {
      if (ch === '{') {
        depth++;
        seen = true;
      } else if (ch === '}') depth--;
    }
    if (seen && depth <= 0) return j;
    if (!seen && (t.trimEnd().endsWith(';') || (j > from && t.trim() === ''))) return j;
  }
  return from;
}

function jsDocFirstLine(lines: string[], before: number): string | undefined {
  let k = before - 1;
  while (k >= 0 && (lines[k] ?? '').trim() === '') k--;
  if (k < 0 || !(lines[k] ?? '').trim().endsWith('*/')) return undefined;
  let s = k;
  while (s > 0 && !(lines[s] ?? '').includes('/**')) s--;
  for (let j = s; j <= k; j++) {
    const t = (lines[j] ?? '').replace(/^\s*\/?\*+\/?\s?/, '').replace(/\*\/\s*$/, '').trim();
    if (t && !t.startsWith('@')) return clip(t, 110);
  }
  return undefined;
}

function tsSymbols(path: string, lines: string[]): SymbolDef[] {
  const out: SymbolDef[] = [];
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    const line = lines[i] ?? '';
    const ind = indentOf(line);
    if (ind > 0) continue; // top-level only; class members are handled below
    const m = TS_DECL.exec(line);
    if (m && m[2] && m[3]) {
      const kw = m[2].replace(/^async\s+/, '').replace(/\*$/, '');
      const kind: SymbolKind = kw === 'function' ? 'function' : kw === 'class' ? 'class' : kw === 'interface' ? 'interface' : kw === 'enum' ? 'enum' : kw === 'type' ? 'type' : 'class';
      const end = braceEnd(lines, i);
      const doc = jsDocFirstLine(lines, i);
      out.push({
        name: m[3],
        kind,
        path,
        line: i + 1,
        startLine: i + 1,
        endLine: end + 1,
        signature: clip(line.trim().replace(/\s*\{\s*$/, ''), 160),
        ...(doc ? { doc } : {}),
      });
      if (kind === 'class') {
        let memberIndent = -1;
        for (let j = i + 1; j < end; j++) {
          const l = lines[j] ?? '';
          const mi = indentOf(l);
          if (mi === 0) continue;
          const mm = TS_METHOD.exec(l);
          if (!mm || !mm[2] || TS_KEYWORDS.has(mm[2])) continue;
          if (memberIndent === -1) memberIndent = mi;
          if (mi !== memberIndent) continue;
          if (!/[{]\s*$/.test(stripStrings(l)) && !/\)\s*(:[^=;]+)?\s*\{?\s*$/.test(stripStrings(l))) continue;
          const mend = braceEnd(lines, j);
          const mdoc = jsDocFirstLine(lines, j);
          out.push({
            name: mm[2],
            kind: 'method',
            path,
            line: j + 1,
            startLine: j + 1,
            endLine: mend + 1,
            signature: clip(l.trim().replace(/\s*\{\s*$/, ''), 160),
            parent: m[3],
            ...(mdoc ? { doc: mdoc } : {}),
          });
          j = Math.max(j, mend);
        }
      }
      continue;
    }
    const c = TS_CONST.exec(line);
    if (c && c[2]) {
      const rhs = c[3] ?? '';
      const arrow = /^(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*(:[^=]+)?=>/.test(rhs) || /^(async\s+)?function\b/.test(rhs);
      const end = arrow ? braceEnd(lines, i) : i;
      const doc = jsDocFirstLine(lines, i);
      out.push({
        name: c[2],
        kind: arrow ? 'function' : 'variable',
        path,
        line: i + 1,
        startLine: i + 1,
        endLine: end + 1,
        signature: clip(line.trim().replace(/\s*\{\s*$/, ''), 160),
        ...(doc ? { doc } : {}),
      });
    }
  }
  return out;
}

/* ------------------------------ Generic ------------------------------ */

const GENERIC_DEF = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|func|function|def|class|struct|interface|trait|enum|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/;

function genericSymbols(path: string, lines: string[]): SymbolDef[] {
  const found: { i: number; name: string; kw: string }[] = [];
  lines.forEach((l, i) => {
    const m = GENERIC_DEF.exec(l);
    if (m && m[1] && m[2]) found.push({ i, name: m[2], kw: m[1] });
  });
  return found.map((f, idx) => {
    const next = found[idx + 1]?.i ?? lines.length;
    const end = Math.min(next - 1, f.i + 150);
    const kind: SymbolKind = /class|struct|trait|interface/.test(f.kw) ? 'class' : f.kw === 'enum' ? 'enum' : f.kw === 'type' ? 'type' : 'function';
    return {
      name: f.name,
      kind,
      path,
      line: f.i + 1,
      startLine: f.i + 1,
      endLine: Math.max(f.i, end) + 1,
      signature: clip((lines[f.i] ?? '').trim(), 160),
    };
  });
}

/* ------------------------------- Docs ------------------------------- */

const RST_UNDERLINE = /^([=\-~^"#*+`.'_:])\1{2,}\s*$/;

/** rst / markdown headings as 'heading' symbols; endLine = line before the next heading. */
function docHeadings(path: string, lines: string[], ext: string): SymbolDef[] {
  const heads: { i: number; title: string }[] = [];
  if (ext === 'md' || ext === 'mdx') {
    let fence = false;
    lines.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      if (fence) return;
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
      if (m && m[2]) heads.push({ i, title: m[2] });
    });
  } else {
    for (let i = 0; i + 1 < lines.length; i++) {
      const l = lines[i] ?? '';
      const u = lines[i + 1] ?? '';
      if (!l.trim() || /^\s/.test(l) || RST_UNDERLINE.test(l) || l.startsWith('..')) continue;
      if (RST_UNDERLINE.test(u) && u.trim().length >= Math.min(l.trim().length, 3)) {
        heads.push({ i, title: l.trim() });
        i++;
      }
    }
  }
  return heads.map((h, idx) => ({
    name: h.title,
    kind: 'heading' as const,
    path,
    line: h.i + 1,
    startLine: h.i + 1,
    endLine: (heads[idx + 1] ? heads[idx + 1]!.i : lines.length) ,
    signature: h.title,
  }));
}

export function extractSymbols(path: string, content: string, lang?: Lang): SymbolDef[] {
  const l = lang ?? langOf(path);
  const lines = content.split(/\r?\n/);
  switch (l) {
    case 'python':
      return pythonSymbols(path, lines);
    case 'ts':
      return tsSymbols(path, lines);
    case 'doc':
      return docHeadings(path, lines, extOf(path));
    case 'generic':
      return genericSymbols(path, lines);
    default:
      return [];
  }
}

export const CHUNKABLE: ReadonlySet<SymbolKind> = new Set<SymbolKind>(['class', 'function', 'method', 'interface', 'type', 'enum']);
