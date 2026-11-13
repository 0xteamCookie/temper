// Budgeted, tiered packing of retrieval candidates into one markdown context pack + LedgerSnapshot.
//
// Strategy (stated in the pack header so the model and the user can see it):
//   1. Reserve <= 10% of the budget for a compact repo map (depth-2 tree + key symbols of top files).
//   2. Baseline pass in rank order: every candidate gets its cheapest useful tier ('outline' =
//      signatures + docstring first lines) while budget remains. Mandatory items (mentions,
//      selection, pinned) go first and are truncated rather than dropped.
//   3. Upgrade pass in rank order: top-ranked candidates become 'full' bodies while budget allows
//      (per-item cap: 30% of the budget, 45% for mandatory items).
//   4. Leftover budget upgrades still-outlined top items to 'snippet' (matching lines +-3).
//   Everything else is listed as "considered but not included" with its reasons.
import type { LedgerEntry, LedgerSnapshot, PickReason } from '../shared/types';
import type { WorkspaceIndex } from './indexer';
import type { Candidate, PackResult } from './types';

export type Tier = 'full' | 'outline' | 'snippet';

export function estimateTokens(s: string): number {
  // Words ~ one token per 4.5 chars, punctuation ~0.6 token each, newlines ~0.3.
  let words = 0;
  let punct = 0;
  let nl = 0;
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127;
    if (alnum) {
      run++;
      continue;
    }
    if (run) {
      words += Math.ceil(run / 4.5);
      run = 0;
    }
    if (c === 10) nl++;
    else if (c !== 32 && c !== 9 && c !== 13) punct++;
  }
  if (run) words += Math.ceil(run / 4.5);
  return Math.ceil(words + punct * 0.6 + nl * 0.3);
}

export interface BudgetSpec {
  /** Explicit token budget (user slider). */
  budgetTokens?: number;
  /** Model context window, for the adaptive default. */
  contextLength?: number;
  /** Percent of the context window used by the adaptive default (default 25). */
  budgetPercent?: number;
}

export const MIN_ADAPTIVE = 4000;
export const MAX_ADAPTIVE = 48000;

/** Explicit tokens win; otherwise contextLength * percent / 100 clamped to 4k..48k. */
export function resolveBudget(spec: BudgetSpec): number {
  if (spec.budgetTokens !== undefined && spec.budgetTokens > 0) return Math.floor(spec.budgetTokens);
  const ctx = spec.contextLength && spec.contextLength > 0 ? spec.contextLength : 128000;
  const pct = spec.budgetPercent ?? 25;
  return Math.min(MAX_ADAPTIVE, Math.max(MIN_ADAPTIVE, Math.floor((ctx * pct) / 100)));
}

export interface PackOptions extends BudgetSpec {
  runId: string;
  task: string;
  queryTerms?: string[];
  notes?: string[];
  /** Max number of candidates considered. */
  maxItems?: number;
}

const REASON_ORDER: PickReason[] = ['mention', 'selection', 'pinned', 'symbol', 'keyword', 'testPair', 'docsPair', 'graph', 'agent'];

function why(c: Candidate, max = 3): string {
  const rs = [...c.reasons].sort((a, b) => REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason));
  const text = rs.slice(0, max).map((r) => r.detail).join('; ');
  return text.length > 230 ? text.slice(0, 229) + '…' : text;
}

function fenceLang(path: string): string {
  const e = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ({ py: 'python', ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', rst: 'rst', md: 'md', json: 'json', toml: 'toml' } as Record<string, string>)[e] ?? '';
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

interface Rendered {
  text: string;
  tokens: number;
}

class Item {
  tier: Tier = 'outline';
  included = false;
  private cache = new Map<string, Rendered>();
  constructor(
    readonly c: Candidate,
    private readonly index: WorkspaceIndex,
    private readonly terms: Set<string>,
  ) {}

  private header(tier: Tier, note = ''): string {
    const c = this.c;
    const range = c.wholeFile ? `lines 1-${c.endLine}` : `lines ${c.startLine}-${c.endLine}`;
    const sym = c.symbol ? ` \`${c.symbol}\`` : '';
    return `### ${c.path} (${range})${sym} — ${why(c)} [${tier}${note}]`;
  }

  private memo(key: string, fn: () => string): Rendered {
    let r = this.cache.get(key);
    if (!r) {
      const text = fn();
      r = { text, tokens: estimateTokens(text) };
      this.cache.set(key, r);
    }
    return r;
  }

  full(): Rendered {
    return this.memo('full', () => {
      const body = this.index.slice(this.c.path, this.c.startLine, this.c.endLine);
      return `${this.header('full')}\n\`\`\`${fenceLang(this.c.path)}\n${body}\n\`\`\`\n`;
    });
  }

  outline(): Rendered {
    return this.memo('outline', () => {
      const f = this.index.file(this.c.path);
      const lines: string[] = [];
      if (f) {
        const syms = f.symbols.filter(
          (s) => s.kind !== 'variable' && (this.c.wholeFile || (s.startLine >= this.c.startLine && s.startLine <= this.c.endLine)),
        );
        for (const s of syms.slice(0, 50)) {
          const dec = s.decorator ? `${s.decorator} ` : '';
          lines.push(clip(`- L${s.line} ${dec}${s.signature}${s.doc ? ` — ${s.doc}` : ''}`, 190));
        }
        if (syms.length > 50) lines.push(`- … ${syms.length - 50} more symbols`);
        if (!lines.length) {
          const first = f.lines.slice(this.c.startLine - 1, this.c.endLine).filter((l) => l.trim()).slice(0, 3);
          for (const l of first) lines.push(`- ${clip(l.trim(), 140)}`);
        }
      }
      return `${this.header('outline')}\n${lines.join('\n')}\n`;
    });
  }

  /** Matching lines +-3. `maxTokens` truncates (used for mandatory items that do not fit). */
  snippet(maxTokens?: number): Rendered {
    const key = `snippet:${maxTokens ?? ''}`;
    return this.memo(key, () => {
      const f = this.index.file(this.c.path);
      const out: string[] = [];
      if (f) {
        const s = this.c.startLine - 1;
        const e = Math.min(f.lines.length, this.c.endLine) - 1;
        const keep = new Set<number>();
        let matched = 0;
        for (let i = s; i <= e && matched < 40; i++) {
          const l = f.lines[i] ?? '';
          if (!l.trim()) continue;
          const toks = l.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
          if (toks.some((t) => this.terms.has(t) || this.terms.has(t.replace(/s$/, '')))) {
            matched++;
            for (let k = Math.max(s, i - 3); k <= Math.min(e, i + 3); k++) keep.add(k);
          }
        }
        if (!keep.size) for (let i = s; i <= Math.min(e, s + 11); i++) keep.add(i);
        let prev = -2;
        let n = 0;
        for (const i of [...keep].sort((a, b) => a - b)) {
          if (i !== prev + 1) out.push('…');
          out.push(f.lines[i] ?? '');
          prev = i;
          if (++n >= 60) break;
        }
        if (prev < e) out.push('…');
      }
      let body = out.join('\n');
      let note = '';
      if (maxTokens !== undefined) {
        const room = Math.max(0, maxTokens - estimateTokens(this.header('snippet', ', truncated')) - 8);
        while (body && estimateTokens(body) > room) body = body.slice(0, Math.floor(body.length * 0.85));
        note = ', truncated';
      }
      return `${this.header('snippet', note)}\n\`\`\`${fenceLang(this.c.path)}\n${body}\n\`\`\`\n`;
    });
  }

  render(): Rendered {
    return this.tier === 'full' ? this.full() : this.tier === 'snippet' ? this.snippet() : this.outline();
  }
}

/* ------------------------------ repo map ------------------------------ */

function repoMap(index: WorkspaceIndex, top: Candidate[], maxTokens: number): string {
  const dirs = new Map<string, number>();
  const rootFiles: string[] = [];
  let total = 0;
  let lines = 0;
  for (const f of index.files.values()) {
    total++;
    lines += f.lines.length;
    const segs = f.path.split('/');
    if (segs.length === 1) rootFiles.push(f.path);
    else {
      const d1 = segs[0] ?? '';
      dirs.set(d1, (dirs.get(d1) ?? 0) + 1);
      if (segs.length > 2) {
        const d2 = `${d1}/${segs[1]}`;
        dirs.set(d2, (dirs.get(d2) ?? 0) + 1);
      }
    }
  }
  const out: string[] = ['## Repo map', `${total} files, ${lines} lines indexed`];
  const tops = [...dirs.keys()].filter((d) => !d.includes('/')).sort();
  for (const d of tops) {
    out.push(`- ${d}/ (${dirs.get(d)} files)`);
    const subs = [...dirs.entries()]
      .filter(([k]) => k.startsWith(d + '/'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    for (const [k, n] of subs) out.push(`  - ${k}/ (${n})`);
  }
  if (rootFiles.length) out.push(`- root files: ${rootFiles.slice(0, 12).join(', ')}`);
  const seen = new Set<string>();
  const sym: string[] = [];
  for (const c of top) {
    if (seen.has(c.path) || c.evicted) continue;
    seen.add(c.path);
    const f = index.file(c.path);
    if (!f) continue;
    const names = f.symbols.filter((s) => (s.kind === 'class' || s.kind === 'function' || s.kind === 'interface') && !s.parent).slice(0, 10);
    if (!names.length) continue;
    sym.push(`- ${c.path}: ${names.map((s) => (s.kind === 'class' ? 'class ' : '') + s.name).join(', ')}`);
    if (sym.length >= 5) break;
  }
  if (sym.length) out.push('Key symbols of top files:', ...sym);
  // Trim from the bottom until it fits.
  while (out.length > 2 && estimateTokens(out.join('\n') + '\n') > maxTokens) out.pop();
  return estimateTokens(out.join('\n') + '\n') > maxTokens ? '' : out.join('\n') + '\n';
}

/* -------------------------------- pack -------------------------------- */

export function pack(index: WorkspaceIndex, candidates: Candidate[], opts: PackOptions): PackResult {
  const B = resolveBudget(opts);
  const terms = new Set<string>();
  for (const t of opts.queryTerms ?? []) {
    terms.add(t);
    for (const p of t.split('_')) if (p.length > 1) terms.add(p);
  }
  const maxItems = opts.maxItems ?? 60;
  const live = candidates.filter((c) => !c.evicted).slice(0, maxItems);
  const evicted = candidates.filter((c) => c.evicted);
  const items = live.map((c) => new Item(c, index, terms));

  const titleReserve = 90;
  const footerReserve = Math.min(Math.floor(B * 0.05), 220);
  const mapBudget = B >= 600 ? Math.floor(B * 0.1) - 40 : 0;
  const map = mapBudget > 60 ? repoMap(index, live, mapBudget) : '';
  const mapTokens = estimateTokens(map);
  let remaining = B - titleReserve - footerReserve - mapTokens - 10;

  // Pass 1: baseline, in rank order.
  for (const it of items) {
    const o = it.outline();
    if (o.tokens <= remaining) {
      it.tier = 'outline';
      it.included = true;
      remaining -= o.tokens;
    } else if (it.c.mandatory && remaining >= 60) {
      const s = it.snippet(remaining);
      it.tier = 'snippet';
      it.included = true;
      remaining -= Math.min(remaining, s.tokens);
    } else if (!it.c.mandatory) {
      const s = it.snippet();
      if (s.tokens <= remaining && s.tokens < o.tokens * 1.5) {
        it.tier = 'snippet';
        it.included = true;
        remaining -= s.tokens;
      }
    }
  }
  const cost = (it: Item): number => it.render().tokens;

  // Pass 2: full bodies for top-ranked (score gate: >= 40% of the best non-mandatory score).
  const bestScore = items.find((i) => !i.c.mandatory)?.c.score ?? 0;
  for (const it of items) {
    if (!it.included || it.tier === 'full') continue;
    if (!it.c.mandatory && it.c.score < bestScore * 0.4) continue;
    if (it.tier === 'snippet' && it.c.mandatory) continue; // already truncated to the max
    const f = it.full();
    const cap = it.c.mandatory ? Math.floor(B * 0.45) : Math.max(1500, Math.floor(B * 0.3));
    const delta = f.tokens - cost(it);
    if (f.tokens <= cap && delta <= remaining) {
      remaining -= delta;
      it.tier = 'full';
    }
  }
  // Pass 3: snippets for still-outlined top items.
  let upgraded = 0;
  for (const it of items) {
    if (upgraded >= 12) break;
    if (!it.included || it.tier !== 'outline') continue;
    const s = it.snippet();
    const delta = s.tokens - cost(it);
    if (delta > 0 && delta <= remaining && s.tokens <= Math.floor(B * 0.2)) {
      remaining -= delta;
      it.tier = 'snippet';
      upgraded++;
    }
  }

  const build = (): string => {
    const inc = items.filter((i) => i.included);
    const exc = [...items.filter((i) => !i.included), ...evicted.map((c) => new Item(c, index, terms))];
    const parts: string[] = [];
    parts.push('# Temper context pack');
    parts.push(`Task: ${clip(opts.task.replace(/\s+/g, ' '), 220)}`);
    const used = inc.reduce((n, i) => n + i.render().tokens, 0);
    parts.push(
      `Strategy: hybrid retrieval (symbol table + BM25 + import graph + test/docs pairing), ${candidates.length} candidates ranked; ` +
        `${inc.length} included within a ${B}-token budget (~${used} used by items). Tiers: [full] body, [outline] signatures, [snippet] matching lines. ` +
        `Each header says why the item was chosen. Use read_file/search_code for anything not shown.`,
    );
    for (const n of opts.notes ?? []) parts.push(`Note: ${n}`);
    parts.push('');
    if (map) parts.push(map);
    parts.push('## Selected context\n');
    for (const i of inc) parts.push(i.render().text);
    if (exc.length) {
      const lines = ['## Considered but not included'];
      for (const i of exc.slice(0, 8)) {
        lines.push(`- ${i.c.id}${i.c.evicted ? ' (evicted by you)' : ''} — ${clip(why(i.c, 2), 120)}`);
      }
      if (exc.length > 8) lines.push(`- … and ${exc.length - 8} more`);
      parts.push(lines.join('\n'));
    }
    return parts.join('\n');
  };

  let text = build();
  // Safety net: the estimate of the assembled text must never exceed the budget.
  while (estimateTokens(text) > B) {
    const droppable = [...items].reverse().find((i) => i.included && !i.c.mandatory);
    if (droppable) droppable.included = false;
    else {
      const m = [...items].reverse().find((i) => i.included && i.tier !== 'snippet');
      if (m) {
        m.tier = 'snippet';
      } else break;
    }
    text = build();
  }
  if (estimateTokens(text) > B) text = text.slice(0, Math.max(0, B * 3));

  const entries: LedgerEntry[] = [];
  for (const it of items) entries.push(entryOf(it, it.included));
  for (const c of evicted) entries.push(entryOf(new Item(c, index, terms), false));
  const usedTokens = estimateTokens(text);
  const snapshot: LedgerSnapshot = {
    runId: opts.runId,
    task: opts.task,
    budgetTokens: B,
    usedTokens,
    candidates: candidates.length,
    entries,
  };
  return { text, snapshot };
}

function entryOf(it: Item, included: boolean): LedgerEntry {
  const c = it.c;
  const tier: Tier = included ? it.tier : 'outline';
  const tokens = included ? it.render().tokens : it.outline().tokens;
  return {
    id: c.id,
    path: c.path,
    ...(c.symbol ? { symbol: c.symbol } : {}),
    startLine: c.startLine,
    endLine: c.endLine,
    score: c.score,
    reasons: c.reasons.map((r) => ({ reason: r.reason, detail: r.detail })),
    tokens,
    representation: tier,
    included,
    ...(c.pinned ? { pinned: true } : {}),
    ...(c.evicted ? { evicted: true } : {}),
  };
}
