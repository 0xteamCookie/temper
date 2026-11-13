// In-memory workspace index: files, chunks, symbol table, import graph, reference map, test<->source
// and code<->docs pairing, plus a BM25 index over chunks. Vscode-free; all IO goes through an
// injectable WorkspaceReader. Supports incremental update(path).
import * as posix from 'node:path/posix';
import { Bm25Index, tokenize } from './bm25';
import { BINARY_EXT, DEFAULT_EXCLUDES, isExcluded } from './fsReader';
import { CHUNKABLE, extOf, extractSymbols, langOf, roleOf, stemOf } from './symbols';
import type { Chunk, FileRole, Lang, SymbolDef, SymbolSource, WorkspaceReader } from './types';

export interface IndexOptions {
  excludes?: string[];
  /** Files larger than this are skipped. Default 300 KB. */
  maxFileBytes?: number;
  /** Optional richer symbol providers (e.g. LSP), tried in order before the built-in extractor. */
  symbolSources?: SymbolSource[];
}

type RawImport = { kind: 'py'; level: number; module: string; names: string[] } | { kind: 'js'; spec: string };

export interface FileInfo {
  path: string;
  lang: Lang;
  role: FileRole;
  lines: string[];
  bytes: number;
  symbols: SymbolDef[];
  chunks: Chunk[];
  /** Identifiers (code) / words (docs) appearing in the file: the reference map is derived from it. */
  idents: Set<string>;
  rawImports: RawImport[];
  /** Whole text, kept for docs only (module-mention pairing). */
  text?: string;
}

export interface PairInfo {
  path: string;
  via: 'name' | 'import' | 'module' | 'symbols';
  strength: number;
  detail: string;
}

export interface IndexStats {
  files: number;
  chunks: number;
  symbols: number;
  lines: number;
  skipped: number;
  ms: { list: number; read: number; parse: number; graph: number; total: number };
}

const WINDOW = 60;
const MAX_CHUNK = 120;
const DOC_NOISE = new Set(['changes', 'changelog', 'history', 'license', 'contributing', 'news']);

function now(): number {
  return performance.now();
}

/* ---------------------------- chunking ---------------------------- */

interface Range {
  s: number;
  e: number;
  symbol?: string;
  kind: Chunk['kind'];
}

function buildChunks(path: string, lang: Lang, lines: string[], symbols: SymbolDef[]): Chunk[] {
  const n = lines.length;
  const ranges: Range[] = [];
  if (lang === 'doc') {
    for (const h of symbols) if (h.kind === 'heading') ranges.push({ s: h.startLine, e: h.endLine, symbol: h.name, kind: 'section' });
  } else {
    const chunkable = symbols.filter((s) => CHUNKABLE.has(s.kind));
    const methods = chunkable.filter((s) => s.parent);
    for (const s of chunkable) {
      if (s.parent) continue;
      if (s.kind === 'class') {
        const members = methods.filter((m) => m.parent === s.name && m.startLine >= s.startLine && m.endLine <= s.endLine);
        if (members.length) {
          const first = Math.min(...members.map((m) => m.startLine));
          ranges.push({ s: s.startLine, e: Math.max(s.startLine, first - 1), symbol: s.name, kind: 'class' });
          for (const m of members) ranges.push({ s: m.startLine, e: m.endLine, symbol: `${s.name}.${m.name}`, kind: 'method' });
          continue;
        }
        ranges.push({ s: s.startLine, e: s.endLine, symbol: s.name, kind: 'class' });
      } else {
        ranges.push({ s: s.startLine, e: s.endLine, symbol: s.name, kind: 'function' });
      }
    }
  }
  ranges.sort((a, b) => a.s - b.s || b.e - a.e);

  const out: Chunk[] = [];
  const emit = (s: number, e: number, symbol: string | undefined, kind: Chunk['kind']): void => {
    for (let a = s; a <= e; ) {
      let b = e;
      if (e - a + 1 > MAX_CHUNK) b = a + WINDOW - 1;
      if (e - b < WINDOW / 3) b = e;
      out.push({ id: `${path}#${a}`, path, startLine: a, endLine: b, ...(symbol ? { symbol } : {}), kind });
      a = b + 1;
    }
  };
  const gap = (s: number, e: number): void => {
    if (e < s) return;
    let any = false;
    for (let i = s; i <= e; i++) if ((lines[i - 1] ?? '').trim()) any = true;
    if (any) emit(s, e, undefined, 'window');
  };
  let cursor = 1;
  for (const r of ranges) {
    if (r.e < cursor) continue;
    const s = Math.max(r.s, cursor);
    gap(cursor, s - 1);
    emit(s, Math.min(r.e, n), r.symbol, r.kind);
    cursor = r.e + 1;
  }
  gap(cursor, n);
  return out;
}

/* ---------------------------- imports ---------------------------- */

const PY_IMPORT = /^\s*import\s+(.+?)\s*(?:#.*)?$/;
const PY_FROM = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+?)\s*$/;
const JS_IMPORT =
  /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function parseImports(lang: Lang, content: string, lines: string[]): RawImport[] {
  const out: RawImport[] = [];
  if (lang === 'python') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!line.includes('import')) continue;
      const f = PY_FROM.exec(line);
      if (f) {
        let names = f[3] ?? '';
        if (names.includes('(') && !names.includes(')')) {
          for (let j = i + 1; j < Math.min(lines.length, i + 80); j++) {
            names += ' ' + (lines[j] ?? '');
            if ((lines[j] ?? '').includes(')')) break;
          }
        }
        const list = names
          .replace(/#[^\n,)]*/g, '')
          .replace(/[()]/g, '')
          .split(',')
          .map((x) => x.trim().split(/\s+as\s+/)[0] ?? '')
          .filter((x) => /^\w+$/.test(x));
        out.push({ kind: 'py', level: (f[1] ?? '').length, module: f[2] ?? '', names: list });
        continue;
      }
      const m = PY_IMPORT.exec(line);
      if (m && /^[\w.,\s]+(\sas\s\w+)?/.test(m[1] ?? '') && !line.trimStart().startsWith('#')) {
        for (const part of (m[1] ?? '').split(',')) {
          const mod = part.trim().split(/\s+as\s+/)[0] ?? '';
          if (/^[\w.]+$/.test(mod)) out.push({ kind: 'py', level: 0, module: mod, names: [] });
        }
      }
    }
  } else if (lang === 'ts') {
    for (const m of content.matchAll(JS_IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (spec) out.push({ kind: 'js', spec });
    }
  }
  return out;
}

/* ------------------------------ index ------------------------------ */

export class WorkspaceIndex {
  readonly files = new Map<string, FileInfo>();
  readonly chunks = new Map<string, Chunk>();
  readonly bm25 = new Bm25Index();
  stats: IndexStats | undefined;

  private readonly excludes: string[];
  private readonly maxBytes: number;
  private readonly sources: SymbolSource[];
  private readonly byLower = new Map<string, SymbolDef[]>();
  private readonly importMap = new Map<string, Set<string>>();
  private importerMap: Map<string, Set<string>> | undefined;
  private moduleMap = new Map<string, string[]>();
  private modNames = new Map<string, string>();
  private readonly testsOfSource = new Map<string, PairInfo[]>();
  private readonly sourcesOfTest = new Map<string, PairInfo[]>();
  private readonly docsOfSource = new Map<string, PairInfo[]>();
  private readonly sourcesOfDoc = new Map<string, PairInfo[]>();

  constructor(
    readonly reader: WorkspaceReader,
    opts: IndexOptions = {},
  ) {
    this.excludes = opts.excludes ?? DEFAULT_EXCLUDES;
    this.maxBytes = opts.maxFileBytes ?? 300 * 1024;
    this.sources = opts.symbolSources ?? [];
  }

  /** Build the full index. */
  async build(): Promise<IndexStats> {
    const t0 = now();
    const all = await this.reader.listFiles(this.excludes);
    const t1 = now();
    const paths = all.filter((p) => !isExcluded(p, this.excludes) && !BINARY_EXT.has(extOf(p)));
    const contents = new Array<string | undefined>(paths.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < paths.length) {
        const i = next++;
        contents[i] = await this.reader.readFile(paths[i] ?? '');
      }
    };
    await Promise.all(Array.from({ length: 32 }, worker));
    const t2 = now();
    let skipped = all.length - paths.length;
    for (let i = 0; i < paths.length; i++) {
      const c = contents[i];
      if (c === undefined || c.length > this.maxBytes) {
        skipped++;
        continue;
      }
      await this.ingest(paths[i] ?? '', c);
    }
    const t3 = now();
    this.relink();
    const t4 = now();
    let lines = 0;
    let symbols = 0;
    for (const f of this.files.values()) {
      lines += f.lines.length;
      symbols += f.symbols.length;
    }
    this.stats = {
      files: this.files.size,
      chunks: this.chunks.size,
      symbols,
      lines,
      skipped,
      ms: { list: t1 - t0, read: t2 - t1, parse: t3 - t2, graph: t4 - t3, total: t4 - t0 },
    };
    return this.stats;
  }

  /** Re-read one file (changed, created or deleted) and refresh derived structures. */
  async update(rel: string): Promise<void> {
    rel = rel.replace(/\\/g, '/');
    const had = this.files.has(rel);
    const content =
      isExcluded(rel, this.excludes) || BINARY_EXT.has(extOf(rel)) ? undefined : await this.reader.readFile(rel);
    if (content === undefined || content.length > this.maxBytes) {
      if (had) this.drop(rel);
      else return;
    } else {
      await this.ingest(rel, content);
    }
    this.relink();
  }

  /* ---------------------------- queries ---------------------------- */

  file(path: string): FileInfo | undefined {
    return this.files.get(path);
  }

  /** Resolve a user-typed path ("cli.py", "flask/cli.py", "./src/flask/cli.py") to an indexed file. */
  findFile(value: string): { path?: string; ambiguous?: string[] } {
    const v = value.replace(/\\/g, '/').replace(/^@/, '').replace(/^\.?\//, '');
    if (this.files.has(v)) return { path: v };
    const hits = [...this.files.keys()].filter((p) => p.endsWith('/' + v) || p === v);
    if (hits.length === 1) return { path: hits[0] };
    if (hits.length > 1) {
      hits.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
      return { path: hits[0], ambiguous: hits };
    }
    return {};
  }

  definitions(name: string, exact = false): SymbolDef[] {
    const list = this.byLower.get(name.toLowerCase()) ?? [];
    return exact ? list.filter((s) => s.name === name) : list;
  }

  /** Files whose text mentions the identifier (reference map; derived from per-file identifier sets). */
  referencesTo(name: string): string[] {
    const out: string[] = [];
    for (const f of this.files.values()) if (f.role !== 'doc' && f.idents.has(name)) out.push(f.path);
    return out;
  }

  importsOf(path: string): string[] {
    return [...(this.importMap.get(path) ?? [])];
  }

  importersOf(path: string): string[] {
    if (!this.importerMap) {
      const m = new Map<string, Set<string>>();
      for (const [from, tos] of this.importMap) {
        for (const to of tos) {
          let s = m.get(to);
          if (!s) m.set(to, (s = new Set()));
          s.add(from);
        }
      }
      this.importerMap = m;
    }
    return [...(this.importerMap.get(path) ?? [])];
  }

  testsFor(path: string): PairInfo[] {
    return this.testsOfSource.get(path) ?? [];
  }
  sourcesForTest(path: string): PairInfo[] {
    return this.sourcesOfTest.get(path) ?? [];
  }
  docsFor(path: string): PairInfo[] {
    return this.docsOfSource.get(path) ?? [];
  }
  codeForDoc(path: string): PairInfo[] {
    return this.sourcesOfDoc.get(path) ?? [];
  }

  moduleName(path: string): string | undefined {
    return this.modNames.get(path);
  }

  slice(path: string, startLine: number, endLine: number): string {
    const f = this.files.get(path);
    if (!f) return '';
    return f.lines.slice(Math.max(0, startLine - 1), endLine).join('\n');
  }

  chunkAt(path: string, line: number): Chunk | undefined {
    const f = this.files.get(path);
    return f?.chunks.find((c) => c.startLine <= line && line <= c.endLine);
  }

  /* --------------------------- internals --------------------------- */

  private async ingest(path: string, content: string): Promise<void> {
    if (this.files.has(path)) this.drop(path, true);
    const lang = langOf(path);
    const lines = content.split(/\r?\n/);
    let symbols: SymbolDef[] | undefined;
    for (const src of this.sources) {
      try {
        symbols = await src.symbols(path, content);
      } catch {
        symbols = undefined;
      }
      if (symbols) break;
    }
    symbols ??= extractSymbols(path, content, lang);
    const role = roleOf(path, lang);
    const chunks = buildChunks(path, lang, lines, symbols);
    const idents = new Set<string>();
    for (const m of content.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) idents.add(m[0]);
    const info: FileInfo = {
      path,
      lang,
      role,
      lines,
      bytes: content.length,
      symbols,
      chunks,
      idents,
      rawImports: parseImports(lang, content, lines),
      ...(role === 'doc' ? { text: content } : {}),
    };
    this.files.set(path, info);
    const pathTokens = tokenize(path);
    for (const c of chunks) {
      this.chunks.set(c.id, c);
      const body = lines.slice(c.startLine - 1, c.endLine).join('\n');
      const symTokens = c.symbol ? tokenize(c.symbol) : [];
      this.bm25.add(c.id, [...tokenize(body), ...pathTokens, ...pathTokens, ...symTokens, ...symTokens, ...symTokens]);
    }
    for (const s of symbols) {
      if (s.kind === 'heading') continue;
      const key = s.name.toLowerCase();
      const list = this.byLower.get(key);
      if (list) list.push(s);
      else this.byLower.set(key, [s]);
    }
  }

  private drop(path: string, quiet = false): void {
    const f = this.files.get(path);
    if (!f) return;
    for (const c of f.chunks) {
      this.chunks.delete(c.id);
      this.bm25.remove(c.id);
    }
    for (const s of f.symbols) {
      if (s.kind === 'heading') continue;
      const key = s.name.toLowerCase();
      const list = this.byLower.get(key)?.filter((x) => x.path !== path);
      if (list && list.length) this.byLower.set(key, list);
      else this.byLower.delete(key);
    }
    this.files.delete(path);
    if (!quiet) this.importMap.delete(path);
  }

  /** Rebuild the module map, import graph and pairings from the current file set (cheap). */
  private relink(): void {
    this.importerMap = undefined;
    this.buildModuleMap();
    this.importMap.clear();
    for (const f of this.files.values()) {
      const set = new Set<string>();
      for (const imp of f.rawImports) for (const t of this.resolveImport(f, imp)) if (t !== f.path) set.add(t);
      if (set.size) this.importMap.set(f.path, set);
    }
    this.buildPairs();
  }

  private buildModuleMap(): void {
    const map = new Map<string, string[]>();
    const names = new Map<string, string>();
    const reg = (key: string, p: string): void => {
      if (!key) return;
      const l = map.get(key);
      if (l) {
        if (!l.includes(p)) l.push(p);
      } else map.set(key, [p]);
    };
    const initDirs = new Set<string>();
    for (const p of this.files.keys()) if (p.endsWith('/__init__.py') || p === '__init__.py') initDirs.add(posix.dirname(p));
    for (const f of this.files.values()) {
      if (f.lang !== 'python') continue;
      const p = f.path;
      const stem = stemOf(p);
      const isInit = stem === '__init__';
      const chain: string[] = [];
      let d = posix.dirname(p);
      while (initDirs.has(d) && d !== '.') {
        chain.unshift(posix.basename(d));
        d = posix.dirname(d);
      }
      const qualified = isInit ? chain : [...chain, stem];
      const q = qualified.join('.');
      reg(q, p);
      if (q) names.set(p, q);
      const rel = p.replace(/\.pyi?$/, '').split('/');
      if (isInit) rel.pop();
      reg(rel.join('.'), p);
    }
    this.moduleMap = map;
    this.modNames = names;
  }

  private pickModule(mod: string, from: string): string | undefined {
    const c = this.moduleMap.get(mod);
    if (!c?.length) return undefined;
    if (c.length === 1) return c[0];
    const fromDir = posix.dirname(from);
    let best = c[0];
    let bestScore = -1;
    for (const p of c) {
      let k = 0;
      const a = posix.dirname(p).split('/');
      const b = fromDir.split('/');
      while (k < a.length && k < b.length && a[k] === b[k]) k++;
      if (k > bestScore) {
        bestScore = k;
        best = p;
      }
    }
    return best;
  }

  private resolveImport(f: FileInfo, imp: RawImport): string[] {
    const out: string[] = [];
    if (imp.kind === 'py') {
      if (imp.level === 0) {
        const base = this.pickModule(imp.module, f.path);
        if (base) out.push(base);
        for (const nm of imp.names) {
          const sub = this.pickModule(`${imp.module}.${nm}`, f.path);
          if (sub) out.push(sub);
        }
      } else {
        let dir = posix.dirname(f.path);
        for (let i = 1; i < imp.level; i++) dir = posix.dirname(dir);
        const modPath = imp.module ? imp.module.split('.').join('/') : '';
        const join = (...parts: string[]): string => posix.normalize(parts.filter(Boolean).join('/'));
        const tryMod = (rel: string): string | undefined => {
          for (const c of [`${rel}.py`, `${rel}.pyi`, `${rel}/__init__.py`]) if (this.files.has(c)) return c;
          return undefined;
        };
        const base = modPath ? tryMod(join(dir, modPath)) : undefined;
        const baseInit = !modPath && this.files.has(join(dir, "__init__.py")) ? join(dir, "__init__.py") : undefined;
        if (base) out.push(base);
        if (baseInit) out.push(baseInit);
        for (const nm of imp.names) {
          const sub = tryMod(join(dir, modPath, nm));
          if (sub) out.push(sub);
        }
      }
    } else if (imp.spec.startsWith('.')) {
      const base = posix.normalize(posix.join(posix.dirname(f.path), imp.spec));
      const stripped = base.replace(/\.(m|c)?js$/, '');
      const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
      const cands = [base, ...exts.map((e) => base + e), ...exts.map((e) => stripped + e), ...exts.map((e) => `${base}/index${e}`)];
      for (const c of cands) {
        if (this.files.has(c) && this.files.get(c)?.lang === 'ts') {
          out.push(c);
          break;
        }
      }
    }
    return out;
  }

  private buildPairs(): void {
    this.testsOfSource.clear();
    this.sourcesOfTest.clear();
    this.docsOfSource.clear();
    this.sourcesOfDoc.clear();
    const add = (m: Map<string, PairInfo[]>, k: string, v: PairInfo): void => {
      const l = m.get(k);
      if (l) {
        if (!l.some((x) => x.path === v.path)) l.push(v);
      } else m.set(k, [v]);
    };

    const sources = [...this.files.values()].filter((f) => f.role === 'source');
    const byKey = new Map<string, string[]>();
    for (const s of sources) {
      const stem = stemOf(s.path);
      if (stem === '__init__' || stem === '__main__') continue;
      const parent = posix.basename(posix.dirname(s.path));
      for (const key of [stem.toLowerCase(), `${parent}_${stem}`.toLowerCase()]) {
        const l = byKey.get(key);
        if (l) l.push(s.path);
        else byKey.set(key, [s.path]);
      }
    }
    for (const t of this.files.values()) {
      if (t.role !== 'test') continue;
      const stem = stemOf(t.path)
        .replace(/^test_?/i, '')
        .replace(/_?test$/i, '')
        .replace(/\.(test|spec)$/i, '')
        .toLowerCase();
      if (!stem || stem === 'conftest') continue;
      const named = new Set<string>(byKey.get(stem) ?? []);
      for (const sp of named) {
        const info = (via: PairInfo['via'], p: string, detail: string): PairInfo => ({ path: p, via, strength: 1, detail });
        add(this.testsOfSource, sp, info('name', t.path, `name match (${posix.basename(t.path)})`));
        add(this.sourcesOfTest, t.path, info('name', sp, `name match (${posix.basename(t.path)})`));
      }
      for (const sp of this.importMap.get(t.path) ?? []) {
        const sf = this.files.get(sp);
        if (!sf || sf.role !== 'source' || named.has(sp) || stemOf(sp) === '__init__') continue;
        add(this.testsOfSource, sp, { path: t.path, via: 'import', strength: 0.4, detail: 'imports it' });
        add(this.sourcesOfTest, t.path, { path: sp, via: 'import', strength: 0.4, detail: 'imported by the test' });
      }
    }
    for (const l of this.testsOfSource.values()) l.sort((a, b) => b.strength - a.strength || (a.path < b.path ? -1 : 1));
    for (const l of this.sourcesOfTest.values()) l.sort((a, b) => b.strength - a.strength || (a.path < b.path ? -1 : 1));

    // Docs <-> code
    const publicDefs = new Map<string, string>(); // unique public symbol name -> path
    for (const s of sources) {
      for (const sym of s.symbols) {
        if (sym.parent || sym.kind === 'heading' || sym.name.startsWith('_') || sym.name.length < 5) continue;
        if ((this.byLower.get(sym.name.toLowerCase())?.length ?? 0) !== 1) continue;
        publicDefs.set(sym.name, s.path);
      }
    }
    for (const d of this.files.values()) {
      if (d.role !== 'doc') continue;
      const dstem = stemOf(d.path).toLowerCase();
      const noisy = DOC_NOISE.has(dstem);
      const found = new Map<string, PairInfo>();
      const bump = (p: string, via: PairInfo['via'], strength: number, detail: string): void => {
        const cur = found.get(p);
        if (!cur || cur.strength < strength) found.set(p, { path: p, via, strength, detail });
      };
      for (const s of sources) {
        const sstem = stemOf(s.path).toLowerCase();
        if (sstem === '__init__' || sstem === '__main__') continue;
        if (sstem === dstem) bump(s.path, 'name', 1, `name match (${posix.basename(d.path)})`);
        const mod = this.modNames.get(s.path);
        if (!noisy && mod && mod.includes('.') && d.text?.includes(mod)) bump(s.path, 'module', 0.9, `mentions module ${mod}`);
      }
      if (!noisy) {
        const hits = new Map<string, string[]>();
        for (const id of d.idents) {
          const p = publicDefs.get(id);
          if (p) {
            const l = hits.get(p);
            if (l) l.push(id);
            else hits.set(p, [id]);
          }
        }
        for (const [p, names] of hits) {
          if (names.length >= 3) bump(p, 'symbols', Math.min(0.8, 0.2 * names.length), `mentions ${names.length} symbols (${names.slice(0, 3).map((x) => '`' + x + '`').join(', ')})`);
        }
      }
      for (const info of found.values()) {
        if (info.strength < 0.4) continue;
        add(this.sourcesOfDoc, d.path, info);
        add(this.docsOfSource, info.path, { ...info, path: d.path });
      }
    }
    for (const l of this.docsOfSource.values()) l.sort((a, b) => b.strength - a.strength || (a.path < b.path ? -1 : 1));
    for (const l of this.sourcesOfDoc.values()) l.sort((a, b) => b.strength - a.strength || (a.path < b.path ? -1 : 1));
  }
}
