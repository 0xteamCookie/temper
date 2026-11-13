// LedgerStore: per-run context snapshots, user pin/evict state (applied to the *next* retrieval),
// and the files the agent itself reads through tools (reason 'agent'). Emits change events so the
// Ledger panel can re-render.
import type { LedgerEntry, LedgerSnapshot } from '../shared/types';
import { estimateTokens } from './packer';

export type LedgerEvent =
  | { type: 'snapshot'; runId: string; snapshot: LedgerSnapshot }
  | { type: 'agentRead'; runId: string; snapshot: LedgerSnapshot; entry: LedgerEntry }
  | { type: 'pins'; pinned: string[]; evicted: string[] };

export interface Disposable {
  dispose(): void;
}

export interface AgentRead {
  path: string;
  startLine?: number;
  endLine?: number;
  /** Tool that did the read, e.g. 'read_file'. */
  tool?: string;
  /** Content size is used to estimate tokens when `tokens` is not given. */
  content?: string;
  tokens?: number;
}

export class LedgerStore {
  private readonly snaps = new Map<string, LedgerSnapshot>();
  private order: string[] = [];
  private latestId: string | undefined;
  private readonly pinnedIds = new Set<string>();
  private readonly evictedIds = new Set<string>();
  private readonly listeners = new Set<(e: LedgerEvent) => void>();

  constructor(private readonly maxRuns = 20) {}

  onDidChange(fn: (e: LedgerEvent) => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => void this.listeners.delete(fn) };
  }

  private emit(e: LedgerEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* listener errors must not break retrieval */
      }
    }
  }

  /** Store the pre-retrieval snapshot of a run (replaces any earlier one, keeping agent reads). */
  record(snapshot: LedgerSnapshot): LedgerSnapshot {
    const prev = this.snaps.get(snapshot.runId);
    const agent = prev ? prev.entries.filter((e) => e.reasons.some((r) => r.reason === 'agent') && !snapshot.entries.some((x) => x.id === e.id)) : [];
    const merged: LedgerSnapshot = { ...snapshot, entries: [...snapshot.entries.map((e) => this.flag(e)), ...agent] };
    this.put(merged);
    this.emit({ type: 'snapshot', runId: merged.runId, snapshot: merged });
    return merged;
  }

  /** Record a file the agent read itself; shows next to the pre-retrieved items. */
  recordAgentRead(runId: string, read: AgentRead): LedgerEntry {
    let snap = this.snaps.get(runId);
    if (!snap) {
      snap = { runId, task: '', budgetTokens: 0, usedTokens: 0, candidates: 0, entries: [] };
      this.put(snap);
    }
    const partial = read.startLine !== undefined || read.endLine !== undefined;
    const detail = `agent read${read.tool ? ` via ${read.tool}` : ''}${partial ? ` (lines ${read.startLine ?? 1}-${read.endLine ?? 'end'})` : ''}`;
    const tokens = read.tokens ?? (read.content !== undefined ? estimateTokens(read.content) : 0);
    const existing = snap.entries.find((e) => e.path === read.path && !e.evicted && (!partial || e.representation !== 'outline'));
    let entry: LedgerEntry;
    if (existing) {
      if (!existing.reasons.some((r) => r.reason === 'agent')) existing.reasons.push({ reason: 'agent', detail });
      entry = existing;
    } else {
      entry = {
        id: partial ? `${read.path}#L${read.startLine ?? 1}-${read.endLine ?? 'end'}` : read.path,
        path: read.path,
        ...(read.startLine !== undefined ? { startLine: read.startLine } : {}),
        ...(read.endLine !== undefined ? { endLine: read.endLine } : {}),
        score: 0,
        reasons: [{ reason: 'agent', detail }],
        tokens,
        representation: partial ? 'snippet' : 'full',
        included: true,
      };
      snap.entries.push(this.flag(entry));
      snap.usedTokens += tokens;
    }
    this.emit({ type: 'agentRead', runId, snapshot: snap, entry });
    return entry;
  }

  latest(): LedgerSnapshot | undefined {
    return this.latestId ? this.snaps.get(this.latestId) : undefined;
  }
  get(runId: string): LedgerSnapshot | undefined {
    return this.snaps.get(runId);
  }
  list(): LedgerSnapshot[] {
    return this.order.map((id) => this.snaps.get(id)).filter((s): s is LedgerSnapshot => !!s);
  }

  /* ----------------------- pin / evict (next retrieval) ----------------------- */

  pin(id: string): void {
    this.evictedIds.delete(id);
    this.pinnedIds.add(id);
    this.refreshFlags();
  }
  unpin(id: string): void {
    this.pinnedIds.delete(id);
    this.refreshFlags();
  }
  evict(id: string): void {
    this.pinnedIds.delete(id);
    this.evictedIds.add(id);
    this.refreshFlags();
  }
  restore(id: string): void {
    this.evictedIds.delete(id);
    this.refreshFlags();
  }
  clearPins(): void {
    this.pinnedIds.clear();
    this.evictedIds.clear();
    this.refreshFlags();
  }

  /** State handed to the retriever. */
  retrievalState(): { pinned: string[]; evicted: string[] } {
    return { pinned: [...this.pinnedIds], evicted: [...this.evictedIds] };
  }

  /* ------------------------------ internals ------------------------------ */

  private flag(e: LedgerEntry): LedgerEntry {
    const pinned = this.pinnedIds.has(e.id) || this.pinnedIds.has(e.path);
    const evicted = this.evictedIds.has(e.id) || this.evictedIds.has(e.path);
    if (pinned) e.pinned = true;
    else delete e.pinned;
    if (evicted) e.evicted = true;
    else delete e.evicted;
    return e;
  }

  private refreshFlags(): void {
    for (const s of this.snaps.values()) for (const e of s.entries) this.flag(e);
    this.emit({ type: 'pins', ...this.retrievalState() });
    const l = this.latest();
    if (l) this.emit({ type: 'snapshot', runId: l.runId, snapshot: l });
  }

  private put(snap: LedgerSnapshot): void {
    if (!this.snaps.has(snap.runId)) this.order.push(snap.runId);
    this.snaps.set(snap.runId, snap);
    this.latestId = snap.runId;
    while (this.order.length > this.maxRuns) {
      const old = this.order.shift();
      if (old) this.snaps.delete(old);
    }
  }
}
