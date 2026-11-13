// Tokenizer + BM25 over chunks. No dependencies.

const STOPWORDS = new Set(
  (
    'a an and are as at be but by for from has have if in into is it its of on or that the their then ' +
    'there these this to was were will with not no do does did can could should would may might must ' +
    'we you your our they them he she i me my so than too very just also any all each other such ' +
    'which who whom what when where why how about over under up down out off again more most some ' +
    'only own same both few being been am via per etc eg ie new add adds added make makes ' +
    // code noise
    'self cls def class return import from none true false elif else pass lambda yield async await ' +
    'var let const function export default string number boolean void null undefined this'
  ).split(/\s+/),
);

export function isStopword(t: string): boolean {
  return STOPWORDS.has(t);
}

/** Split an identifier on underscores, digit boundaries and camelCase humps. */
export function splitIdentifier(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** Lowercase + light plural stemming, applied identically to documents and queries. */
export function normalizeTerm(t: string): string {
  const s = t.toLowerCase();
  if (s.length > 4 && s.endsWith('ies')) return s.slice(0, -3) + 'y';
  if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us')) return s.slice(0, -1);
  return s;
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * Tokens of `text`: sub-words of every identifier (camelCase / snake_case split) plus the compound
 * identifier itself when it has several parts (so `get_debug_flag` matches exactly as well as by part).
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const matches = text.match(IDENT_RE);
  if (!matches) return out;
  for (const word of matches) {
    const parts = splitIdentifier(word);
    if (parts.length > 1) out.push(word.toLowerCase().replace(/^_+|_+$/g, ''));
    for (const p of parts) {
      if (p.length < 2) continue;
      const n = normalizeTerm(p);
      if (n.length < 2 || STOPWORDS.has(n) || STOPWORDS.has(p.toLowerCase())) continue;
      out.push(n);
    }
  }
  return out;
}

export interface Bm25Hit {
  id: string;
  score: number;
  /** Per-term contribution, for explanations. */
  terms: [string, number][];
}

interface DocEntry {
  len: number;
  tf: Map<string, number>;
}

export class Bm25Index {
  private readonly docs = new Map<string, DocEntry>();
  private readonly postings = new Map<string, Map<string, number>>();
  private totalLen = 0;
  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  get size(): number {
    return this.docs.size;
  }

  add(id: string, tokens: string[]): void {
    this.remove(id);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.set(id, { len: tokens.length, tf });
    this.totalLen += tokens.length;
    for (const [t, n] of tf) {
      let p = this.postings.get(t);
      if (!p) this.postings.set(t, (p = new Map()));
      p.set(id, n);
    }
  }

  remove(id: string): void {
    const d = this.docs.get(id);
    if (!d) return;
    this.totalLen -= d.len;
    for (const t of d.tf.keys()) {
      const p = this.postings.get(t);
      if (!p) continue;
      p.delete(id);
      if (p.size === 0) this.postings.delete(t);
    }
    this.docs.delete(id);
  }

  idf(term: string): number {
    const n = this.postings.get(term)?.size ?? 0;
    const N = this.docs.size;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  /** Score all documents matching at least one query term. Returns hits sorted by score desc. */
  search(queryTerms: string[], limit = 50): Bm25Hit[] {
    const N = this.docs.size;
    if (N === 0) return [];
    const avg = this.totalLen / N || 1;
    const scores = new Map<string, number>();
    const contrib = new Map<string, Map<string, number>>();
    for (const term of new Set(queryTerms)) {
      const p = this.postings.get(term);
      if (!p) continue;
      const idf = this.idf(term);
      for (const [id, f] of p) {
        const d = this.docs.get(id);
        if (!d) continue;
        const s = idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / avg)));
        scores.set(id, (scores.get(id) ?? 0) + s);
        let c = contrib.get(id);
        if (!c) contrib.set(id, (c = new Map()));
        c.set(term, s);
      }
    }
    const hits: Bm25Hit[] = [];
    for (const [id, score] of scores) {
      const c = contrib.get(id) ?? new Map<string, number>();
      hits.push({ id, score, terms: [...c.entries()].sort((a, b) => b[1] - a[1]) });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return hits.slice(0, limit);
  }
}
