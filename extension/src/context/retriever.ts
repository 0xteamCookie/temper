// Hybrid retriever: symbol table + BM25 + import/reference graph + test<->source and code<->docs
// pairing. No embeddings. Every candidate carries human-readable reasons.
//
// Signal weights (additive per candidate; documented here so the ranking is explainable):
//   mention (@file / @symbol)        100   mandatory, always first
//   selection                         90   mandatory
//   pinned                            80   mandatory
//   exact symbol definition           10   task contains an identifier-like word (snake_case, camelCase,
//                                          `backticked`, Capitalized class) that equals a defined name
//                                      4   plain word that equals a defined name (case-sensitive)
//                                    2.5   plain word equal to a defined name ignoring case (len >= 5)
//   symbol-name overlap              1.5-3 symbol name fully covered by task terms, or >= 2 shared terms
//   BM25 over chunks                 0-8   8 * score / best score (top chunks, >= 25% of the best), damped
//                                          x1,.85,.7,.55,.4 for the k-th hit of the same file
//   file name equals a task term     2.5   cli -> cli.py / test_cli.py / docs/cli.rst (their best chunks)
//   test pairing (name / import)     5 / 2 x origin scale
//   docs pairing (name/module/syms)  5 x strength x origin scale
//   import graph: imported by O       2.5 x origin scale;  imports O: 2 x origin scale
//   reference: file uses a queried identifier   3 (tests 2)
// "origin scale" = 0.4 + 0.6 * min(1, originFileScore / 15): graph/pair expansion goes one hop from
// the 5 best-scoring files only, and is damped when the origin itself is a weak hit.
import { isStopword, normalizeTerm, splitIdentifier, tokenize } from './bm25';
import type { FileInfo, WorkspaceIndex } from './indexer';
import { stemOf } from './symbols';
import type { Candidate, Chunk, Reason, RetrieveContext, RetrieveResult, SymbolDef } from './types';

export const WEIGHTS = {
  mention: 100,
  selection: 90,
  pinned: 80,
  symbolIdent: 10,
  symbolPlain: 4,
  symbolLoose: 2.5,
  fileName: 2.5,
  bm25: 8,
  testName: 5,
  testImport: 2,
  docs: 5,
  imported: 2.5,
  importer: 2,
  reference: 3,
  referenceTest: 2,
} as const;

const DIVERSITY = [1, 0.85, 0.7, 0.55, 0.4];
const DOC_NOISE = /(^|[/])(changes|changelog|history|news|license)[^/]*$/i;

export interface RetrieveOptions {
  maxCandidates?: number;
  originFiles?: number;
}

/** Ledger id of a chunk: `path#symbol` (continuation windows of a symbol get `:L<start>`). */
export function chunkLedgerId(index: WorkspaceIndex, c: Chunk): string {
  if (!c.symbol) return `${c.path}#L${c.startLine}-${c.endLine}`;
  const first = index.file(c.path)?.chunks.find((x) => x.symbol === c.symbol);
  return first && first.id !== c.id ? `${c.path}#${c.symbol}:L${c.startLine}` : `${c.path}#${c.symbol}`;
}

function fmtScore(n: number): string {
  return n.toFixed(1);
}

export class Retriever {
  constructor(private readonly index: WorkspaceIndex) {}

  retrieve(task: string, ctx: RetrieveContext, opts: RetrieveOptions = {}): RetrieveResult {
    const t0 = performance.now();
    const idx = this.index;
    const notes: string[] = [];
    const queryTerms = [...new Set(tokenize(task))];
    const cands = new Map<string, Candidate>();

    const upsert = (
      id: string,
      base: Pick<Candidate, 'path' | 'symbol' | 'startLine' | 'endLine' | 'wholeFile'>,
      score: number,
      reason: Reason,
      mandatory = false,
    ): Candidate => {
      let c = cands.get(id);
      if (!c) {
        c = { id, ...base, score: 0, reasons: [], mandatory: false };
        cands.set(id, c);
      }
      c.score += score;
      if (!c.reasons.some((r) => r.reason === reason.reason && r.detail === reason.detail)) c.reasons.push(reason);
      if (mandatory) c.mandatory = true;
      return c;
    };
    const addChunk = (ch: Chunk, score: number, reason: Reason, mandatory = false): Candidate =>
      upsert(
        chunkLedgerId(idx, ch),
        { path: ch.path, ...(ch.symbol ? { symbol: ch.symbol } : {}), startLine: ch.startLine, endLine: ch.endLine, wholeFile: false },
        score,
        reason,
        mandatory,
      );
    const addFile = (path: string, score: number, reason: Reason, mandatory = false): Candidate | undefined => {
      const f = idx.file(path);
      if (!f) return undefined;
      return upsert(path, { path, startLine: 1, endLine: Math.max(1, f.lines.length), wholeFile: true }, score, reason, mandatory);
    };

    /* 1. mentions */
    for (const m of ctx.mentions) {
      if (m.kind === 'file') {
        const r = idx.findFile(m.value);
        if (!r.path) {
          notes.push(`mention not found: @${m.value}`);
          continue;
        }
        if (r.ambiguous) notes.push(`@${m.value} is ambiguous (${r.ambiguous.slice(0, 3).join(', ')}); using ${r.path}`);
        addFile(r.path, WEIGHTS.mention, { reason: 'mention', detail: `you mentioned @${m.value}` }, true);
      } else {
        const defs = this.findDefs(m.value);
        if (!defs.length) {
          notes.push(`mention not found: @symbol:${m.value}`);
          continue;
        }
        for (const d of defs.slice(0, 5)) {
          const ch = idx.chunkAt(d.path, d.line);
          if (ch) addChunk(ch, WEIGHTS.mention, { reason: 'mention', detail: `you mentioned @symbol:${m.value} (${d.path}:${d.line})` }, true);
        }
      }
    }

    /* 2. selection */
    if (ctx.selection) {
      const f = idx.file(ctx.selection.path);
      if (f) {
        const s = Math.max(1, ctx.selection.startLine);
        const e = Math.min(f.lines.length, Math.max(s, ctx.selection.endLine));
        upsert(
          `${f.path}#L${s}-${e}`,
          { path: f.path, startLine: s, endLine: e, wholeFile: false },
          WEIGHTS.selection,
          { reason: 'selection', detail: `your selection (${f.path}:${s}-${e})` },
          true,
        );
      }
    }

    /* 3. pinned */
    for (const id of ctx.pinned) {
      const c = this.byLedgerId(id);
      if (!c) continue;
      const cand = c.wholeFile ? addFile(c.path, WEIGHTS.pinned, { reason: 'pinned', detail: 'pinned by you' }, true) : addChunk(c.chunk, WEIGHTS.pinned, { reason: 'pinned', detail: 'pinned by you' }, true);
      if (cand) cand.pinned = true;
    }

    /* 4. exact symbol definitions named in the task */
    const queried = new Map<string, number>(); // name -> weight
    const words = new Set<string>();
    for (const m of task.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) words.add(m[0]);
    for (const w of words) {
      if (isStopword(w.toLowerCase())) continue;
      let defs = idx.definitions(w, true);
      const identLike =
        /_/.test(w) || /[a-z][A-Z]/.test(w) || task.includes('`' + w) || task.includes(w + '(') || (/^[A-Z][a-z]/.test(w) && defs.some((d) => d.kind === 'class'));
      let weight = identLike ? WEIGHTS.symbolIdent : WEIGHTS.symbolPlain;
      if (!defs.length && w.length >= 5) {
        defs = idx.definitions(w, false);
        weight = WEIGHTS.symbolLoose;
      }
      if (!defs.length || (defs.length > 4 && !identLike)) continue;
      queried.set(w, Math.max(queried.get(w) ?? 0, weight));
      for (const d of defs.slice(0, 6)) {
        if (d.kind === 'variable' && !identLike) continue;
        const ch = idx.chunkAt(d.path, d.line);
        if (!ch) continue;
        const label = d.parent ? `${d.parent}.${d.name}` : d.name;
        addChunk(ch, weight, { reason: 'symbol', detail: `defines \`${label}\` (${d.kind}, line ${d.line})` });
      }
    }

    /* 5. symbol-name overlap with task terms */
    const qset = new Set(queryTerms);
    const overlaps: { d: SymbolDef; n: number; score: number; hit: string[] }[] = [];
    for (const f of idx.files.values()) {
      if (f.role === 'doc') continue;
      for (const d of f.symbols) {
        if (d.kind === 'heading' || d.kind === 'variable') continue;
        const parts = [...new Set(splitIdentifier(d.name).map(normalizeTerm))].filter((p) => p.length > 1 && p !== 'test' && !isStopword(p));
        if (parts.length < 2) continue;
        const hit = parts.filter((p) => qset.has(p));
        if (hit.length < 2 && hit.length !== parts.length) continue;
        overlaps.push({ d, n: hit.length, score: Math.min(3, 1.5 + hit.length * 0.5), hit });
      }
    }
    overlaps.sort((a, b) => b.score - a.score);
    for (const o of overlaps.slice(0, 12)) {
      if (queried.has(o.d.name)) continue;
      const ch = idx.chunkAt(o.d.path, o.d.line);
      if (ch) addChunk(ch, o.score, { reason: 'symbol', detail: `symbol \`${o.d.name}\` matches '${o.hit.join(' ')}'` });
    }

    /* 6. BM25 */
    const all = idx.bm25.search(queryTerms, 100000);
    const bm = new Map<string, number>();
    for (const h of all) bm.set(h.id, h.score);
    const best = all[0]?.score ?? 0;
    if (best > 0) {
      // Diversity: the k-th hit of one file is damped so a single file cannot monopolize the pack;
      // changelog-style docs are halved.
      const perFile = new Map<string, number>();
      all.slice(0, 60).forEach((h, rank) => {
        if (h.score < best * 0.25 && rank >= 10) return;
        const ch = idx.chunks.get(h.id);
        if (!ch) return;
        const k = perFile.get(ch.path) ?? 0;
        perFile.set(ch.path, k + 1);
        const noise = DOC_NOISE.test(ch.path) ? 0.5 : 1;
        const terms = h.terms.slice(0, 3).map(([t]) => t).join(' ');
        addChunk(ch, (WEIGHTS.bm25 * h.score * (DIVERSITY[Math.min(k, DIVERSITY.length - 1)] ?? 0.4) * noise) / best, {
          reason: 'keyword',
          detail: `BM25: '${terms}' (score ${fmtScore(h.score)})`,
        });
      });
      // File-name signal: a task term equal to a file stem (cli -> cli.py, test_cli.py, cli.rst).
      const qs = new Set(queryTerms);
      for (const f of idx.files.values()) {
        const stem = stemOf(f.path).toLowerCase().replace(/^test_?/, '').replace(/_?test$/, '');
        if (f.role === 'config' || f.role === 'other') continue;
        if (stem.length < 3 || stem === '__init__' || !qs.has(normalizeTerm(stem)) || idx.bm25.idf(normalizeTerm(stem)) < 1.5) continue;
        const top = f.chunks.filter((c) => (bm.get(c.id) ?? 0) > 0).sort((a, b) => (bm.get(b.id) ?? 0) - (bm.get(a.id) ?? 0)).slice(0, 2);
        for (const c of top) addChunk(c, WEIGHTS.fileName * (DOC_NOISE.test(f.path) ? 0.3 : 1), { reason: 'keyword', detail: `file name matches '${stem}'` });
      }
    }
    const fileBm = (path: string): number => {
      let m = 0;
      for (const c of idx.file(path)?.chunks ?? []) m = Math.max(m, bm.get(c.id) ?? 0);
      return m;
    };

    /* 7. one-hop expansion from the best files */
    const fileScore = new Map<string, number>();
    for (const c of cands.values()) fileScore.set(c.path, Math.max(fileScore.get(c.path) ?? 0, Math.min(c.score, 20)));
    const origins = [...fileScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.originFiles ?? 5);

    const expandFile = (path: string, base: number, reason: Reason): void => {
      const f = idx.file(path);
      if (!f || base <= 0) return;
      const scored = f.chunks.filter((c) => (bm.get(c.id) ?? 0) > 0).sort((a, b) => (bm.get(b.id) ?? 0) - (bm.get(a.id) ?? 0));
      if (f.lines.length <= 120 || !scored.length) {
        addFile(path, base, reason);
        return;
      }
      scored.slice(0, 2).forEach((c, i) => addChunk(c, base * (i === 0 ? 1 : 0.7), reason));
    };

    for (const [o, sc] of origins) {
      const of = idx.file(o);
      if (!of) continue;
      const scale = 0.4 + 0.6 * Math.min(1, sc / 15);
      if (of.role === 'test') {
        for (const p of idx.sourcesForTest(o).slice(0, 2)) {
          expandFile(p.path, (p.via === 'name' ? WEIGHTS.testName : WEIGHTS.testImport) * scale, { reason: 'testPair', detail: `source under test in ${o} (${p.detail})` });
        }
      } else if (of.role === 'doc') {
        for (const p of idx.codeForDoc(o).slice(0, 2)) {
          expandFile(p.path, WEIGHTS.docs * p.strength * scale, { reason: 'docsPair', detail: `code documented by ${o} (${p.detail})` });
        }
      } else {
        for (const p of idx.testsFor(o).slice(0, 2)) {
          expandFile(p.path, (p.via === 'name' ? WEIGHTS.testName : WEIGHTS.testImport) * scale, { reason: 'testPair', detail: `test for ${o} (${p.detail})` });
        }
        for (const p of idx.docsFor(o).slice(0, 2)) {
          expandFile(p.path, WEIGHTS.docs * p.strength * scale, { reason: 'docsPair', detail: `docs for ${o} (${p.detail})` });
        }
      }
      const rank = (paths: string[]): string[] =>
        paths
          .filter((p) => {
            const r = idx.file(p)?.role;
            return r === 'source' || r === 'config';
          })
          .map((p) => [p, fileBm(p)] as const)
          .filter(([, s]) => s > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([p]) => p);
      for (const p of rank(idx.importsOf(o))) expandFile(p, WEIGHTS.imported * scale, { reason: 'graph', detail: `imported by ${o}` });
      for (const p of rank(idx.importersOf(o))) expandFile(p, WEIGHTS.importer * scale, { reason: 'graph', detail: `imports ${o}` });
    }

    /* 8. reference graph: files that use a symbol the task names */
    for (const [name, weight] of queried) {
      if (weight < WEIGHTS.symbolIdent) continue;
      const defFiles = new Set(idx.definitions(name, true).map((d) => d.path));
      const refs = idx
        .referencesTo(name)
        .filter((p) => !defFiles.has(p))
        .sort((a, b) => Number(idx.file(a)?.role === 'test') - Number(idx.file(b)?.role === 'test') || (a < b ? -1 : 1))
        .slice(0, 4);
      for (const p of refs) {
        const f = idx.file(p);
        if (!f) continue;
        const ch = this.chunkUsing(f, name);
        if (ch) addChunk(ch, f.role === 'test' ? WEIGHTS.referenceTest : WEIGHTS.reference, { reason: 'graph', detail: `uses \`${name}\`` });
      }
    }

    /* 9. absorb chunk candidates into a whole-file candidate of the same file when it is small */
    for (const f of [...cands.values()].filter((c) => c.wholeFile)) {
      const info = idx.file(f.path);
      const limit = f.mandatory ? 250 : 120;
      if (!info || info.lines.length > limit) continue;
      for (const c of [...cands.values()]) {
        if (c.wholeFile || c.path !== f.path || c.reasons.some((r) => r.reason === 'selection')) continue;
        f.score += c.score;
        for (const r of c.reasons) if (!f.reasons.some((x) => x.detail === r.detail)) f.reasons.push(r);
        f.mandatory ||= c.mandatory;
        f.pinned ||= c.pinned;
        cands.delete(c.id);
      }
    }

    /* 10. evictions (a fresh mention overrides) */
    const evictedSet = new Set(ctx.evicted);
    for (const c of cands.values()) {
      const hit = evictedSet.has(c.id) || evictedSet.has(c.path);
      if (hit && !c.reasons.some((r) => r.reason === 'mention' || r.reason === 'selection')) {
        c.evicted = true;
        c.mandatory = false;
        c.pinned = false;
      }
    }

    const rankOf = (c: Candidate): number => (c.evicted ? -1 : c.mandatory ? 1 : 0);
    const list = [...cands.values()].sort((a, b) => rankOf(b) - rankOf(a) || b.score - a.score || (a.id < b.id ? -1 : 1));
    for (const c of list) c.score = Math.round(c.score * 100) / 100;
    const cap = opts.maxCandidates ?? 80;
    const kept = list.filter((c) => !c.evicted).slice(0, cap).concat(list.filter((c) => c.evicted));
    return { candidates: kept, queryTerms, notes, ms: performance.now() - t0 };
  }

  private findDefs(value: string): SymbolDef[] {
    const v = value.replace(/^@?(symbol:)?/, '');
    const [head, tail] = v.includes('.') ? [v.slice(0, v.lastIndexOf('.')), v.slice(v.lastIndexOf('.') + 1)] : ['', v];
    let defs = this.index.definitions(tail, true);
    if (!defs.length) defs = this.index.definitions(tail, false);
    if (head) {
      const p = defs.filter((d) => d.parent === head.split('.').pop());
      if (p.length) defs = p;
    }
    return defs;
  }

  private byLedgerId(id: string): { path: string; wholeFile: true } | { path: string; wholeFile: false; chunk: Chunk } | undefined {
    const hash = id.indexOf('#');
    const path = hash === -1 ? id : id.slice(0, hash);
    const f = this.index.file(path);
    if (!f) return undefined;
    if (hash === -1) return { path, wholeFile: true };
    const chunk = f.chunks.find((c) => chunkLedgerId(this.index, c) === id);
    return chunk ? { path, wholeFile: false, chunk } : { path, wholeFile: true };
  }

  private chunkUsing(f: FileInfo, name: string): Chunk | undefined {
    const re = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`);
    let fallback: number | undefined;
    for (let i = 0; i < f.lines.length; i++) {
      const l = f.lines[i] ?? '';
      if (!re.test(l)) continue;
      if (/^\s*(from|import)\b/.test(l)) {
        fallback ??= i;
        continue;
      }
      return this.index.chunkAt(f.path, i + 1);
    }
    return fallback === undefined ? undefined : this.index.chunkAt(f.path, fallback + 1);
  }
}
