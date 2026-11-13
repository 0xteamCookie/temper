// Temper changeset: an in-memory staging overlay. Nothing is written to disk until
// applyAccepted() is called, and every apply is undoable via a Checkpoint.
import { createPatch, structuredPatch } from 'diff'
import type { Checkpoint, FileChange, Hunk, HunkDecision, ScopeFlag, StageResult } from '../shared/types'
import { detectEol, fromLf, replace, toLf } from './fuzzyEdit'
import type { FileSystemPort } from './fsPort'

interface Entry {
  path: string
  kind: 'modify' | 'create'
  original: string
  proposed: string
  rationale: string[]
  hunks: Hunk[]
}

export class PathError extends Error {}

/** Normalize to a forward-slash workspace-relative path; throws PathError if it escapes the workspace. */
export function normalizePath(p: string): string {
  const s = p.trim().replace(/\\/g, '/')
  if (!s) throw new PathError('Empty path.')
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) {
    throw new PathError(`Path must be workspace-relative, got "${p}".`)
  }
  const parts: string[] = []
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) throw new PathError(`Path "${p}" escapes the workspace.`)
      parts.pop()
    } else parts.push(seg)
  }
  if (parts.length === 0) throw new PathError('Empty path.')
  return parts.join('/')
}

function splitKeep(text: string): string[] {
  if (text === '') return []
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function computeHunks(p: string, original: string, proposed: string, rationale?: string): Hunk[] {
  const patch = structuredPatch(p, p, original, proposed, '', '', { context: 3 })
  return patch.hunks.map((h, i) => ({
    id: `${p}#${i}`,
    path: p,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
    lines: h.lines,
    rationale,
    flags: [],
    decision: 'pending' as HunkDecision,
  }))
}

/** Rebuild file text applying only hunks for which `accepted(h)` is true. Operates on LF text. */
export function applyHunks(original: string, hunks: Hunk[], accepted: (h: Hunk) => boolean): string {
  const orig = splitKeep(original)
  const out: string[] = []
  let ptr = 0
  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart)
  for (const h of sorted) {
    const start = Math.max(h.oldStart - 1, ptr)
    while (ptr < start && ptr < orig.length) out.push(orig[ptr++]!)
    const acc = accepted(h)
    for (let i = 0; i < h.lines.length; i++) {
      const line = h.lines[i]!
      const tag = line[0]
      if (tag === '\\') continue
      const noNl = h.lines[i + 1]?.startsWith('\\') ?? false
      const text = line.slice(1) + (noNl ? '' : '\n')
      if (tag === ' ') {
        out.push(orig[ptr++] ?? text)
      } else if (tag === '-') {
        const o = orig[ptr++]
        if (!acc && o !== undefined) out.push(o)
      } else if (tag === '+') {
        if (acc) out.push(text)
      }
    }
  }
  while (ptr < orig.length) out.push(orig[ptr++]!)
  return out.join('')
}

export class ChangesetStore {
  private entries = new Map<string, Entry>()
  private dropped = new Set<string>()
  private checkpointsById = new Map<string, Checkpoint>()
  private listeners = new Set<() => void>()
  private cpCounter = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly fs: FileSystemPort) {}

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener)
    return { dispose: () => void this.listeners.delete(listener) }
  }
  private fire(): void {
    for (const l of [...this.listeners]) l()
  }
  /** Serialize async mutations so concurrent stage() calls on one file accumulate correctly. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  isEmpty(): boolean {
    return this.entries.size === 0
  }

  async read(p: string): Promise<string | null> {
    const np = normalizePath(p)
    const e = this.entries.get(np)
    return e ? e.proposed : this.fs.read(np)
  }

  stage(p: string, oldString: string, newString: string, rationale?: string, replaceAll = false): Promise<StageResult> {
    return this.serial(() => this.stageInner(p, oldString, newString, rationale, replaceAll))
  }

  createFile(p: string, content: string, rationale?: string): Promise<StageResult> {
    return this.serial(async () => {
      let np: string
      try {
        np = normalizePath(p)
      } catch (e) {
        return { ok: false, path: p, message: (e as Error).message }
      }
      if (this.entries.has(np)) {
        return this.fail(np, 'File is already staged. Use an edit to change it.')
      }
      if ((await this.fs.read(np)) !== null) {
        return this.fail(np, 'File already exists. Use an edit (oldString/newString) to change it.')
      }
      return this.commitEntry(np, '', content, 'create', rationale, 'create')
    })
  }

  private fail(p: string, message: string): StageResult {
    return { ok: false, path: p, message }
  }

  private async stageInner(
    p: string,
    oldString: string,
    newString: string,
    rationale: string | undefined,
    replaceAll: boolean,
  ): Promise<StageResult> {
    let np: string
    try {
      np = normalizePath(p)
    } catch (e) {
      return { ok: false, path: p, message: (e as Error).message }
    }
    const entry = this.entries.get(np)
    const current = entry ? entry.proposed : await this.fs.read(np)
    if (current === null) {
      if (oldString === '') return this.commitEntry(np, '', newString, 'create', rationale, 'create')
      return this.fail(np, `File "${np}" does not exist. To create it, pass an empty oldString (or use createFile).`)
    }
    const r = replace(current, oldString, newString, replaceAll)
    if (!r.ok) return this.fail(np, r.message)
    if (r.content === current) return this.fail(np, 'The edit produces no change.')
    return this.commitEntry(np, entry ? entry.original : current, r.content, entry?.kind ?? 'modify', rationale, r.strategy, current)
  }

  private commitEntry(
    np: string,
    original: string,
    proposed: string,
    kind: 'modify' | 'create',
    rationale: string | undefined,
    strategy: string,
    before?: string,
  ): StageResult {
    const prev = this.entries.get(np)
    const e: Entry = {
      path: np,
      kind,
      original,
      proposed,
      rationale: [...(prev?.rationale ?? []), ...(rationale ? [rationale] : [])],
      hunks: prev?.hunks ?? [],
    }
    this.rebuildHunks(e)
    this.entries.set(np, e)
    this.fire()
    const message = createPatch(np, before ?? original, proposed, '', '', { context: 3 })
    return { ok: true, path: np, message, matchStrategy: strategy }
  }

  private rebuildHunks(e: Entry): void {
    const rationale = e.rationale.length ? e.rationale.join('\n') : undefined
    // Diffs are computed on LF-normalised text; CRLF is restored when applying.
    let hunks = computeHunks(e.path, toLf(e.original), toLf(e.proposed), rationale)
    if (hunks.length === 0 && e.kind === 'create') {
      hunks = [
        {
          id: `${e.path}#0`, path: e.path, oldStart: 0, oldLines: 0, newStart: 0, newLines: 0,
          header: '@@ -0,0 +0,0 @@', lines: [], rationale, flags: [], decision: 'pending',
        },
      ]
    }
    // Carry over review state for hunks whose content (old range + lines) is unchanged.
    const key = (h: Hunk) => `${h.oldStart},${h.oldLines}\n${h.lines.join('\n')}`
    const prev = new Map<string, Hunk>()
    const wasDropped = new Set<string>()
    for (const h of e.hunks) {
      prev.set(key(h), h)
      if (this.dropped.has(h.id)) wasDropped.add(key(h))
      this.dropped.delete(h.id)
    }
    e.hunks = hunks.map((h) => {
      const old = prev.get(key(h))
      if (!old) return h
      if (wasDropped.has(key(h))) this.dropped.add(h.id)
      return { ...h, flags: old.flags, decision: old.decision, rationale: old.rationale }
    })
  }

  /** Files with hunks (dropped hunks hidden). Hunk objects are live: guards may mutate flags/decision. */
  files(): FileChange[] {
    const out: FileChange[] = []
    for (const e of this.entries.values()) {
      out.push({
        path: e.path,
        kind: e.kind,
        original: e.original,
        proposed: e.proposed,
        hunks: e.hunks.filter((h) => !this.dropped.has(h.id)),
      })
    }
    return out
  }

  private findHunk(id: string): Hunk | undefined {
    for (const e of this.entries.values()) for (const h of e.hunks) if (h.id === id) return h
    return undefined
  }

  setDecision(hunkId: string, decision: HunkDecision): boolean {
    const h = this.findHunk(hunkId)
    if (!h) return false
    h.decision = decision
    this.fire()
    return true
  }

  setAll(decision: HunkDecision): void {
    for (const e of this.entries.values()) for (const h of e.hunks) h.decision = decision
    this.fire()
  }

  addFlag(hunkId: string, flag: ScopeFlag): void {
    this.findHunk(hunkId)?.flags.push(flag)
    this.fire()
  }

  /** Remove hunks from review entirely (scope fence 'block' mode). They are never applied. */
  dropHunks(ids: string[]): void {
    for (const id of ids) {
      const h = this.findHunk(id)
      if (h) {
        h.decision = 'reject'
        this.dropped.add(id)
      }
    }
    this.fire()
  }

  discard(): void {
    this.entries.clear()
    this.dropped.clear()
    this.fire()
  }

  checkpoint(id: string): Checkpoint | undefined {
    return this.checkpointsById.get(id)
  }
  checkpoints(): Checkpoint[] {
    return [...this.checkpointsById.values()]
  }

  /**
   * Write accepted hunks to disk. Computes everything first; rolls back on any write failure.
   * On success the whole overlay is cleared (rejected/pending hunks are discarded).
   */
  applyAccepted(label: string): Promise<Checkpoint> {
    return this.serial(async () => {
      const plan: { path: string; content: string; original: string | null }[] = []
      let applied = 0
      let rejected = 0
      for (const e of this.entries.values()) {
        const accepted = (h: Hunk) => h.decision === 'accept' && !this.dropped.has(h.id)
        const nAcc = e.hunks.filter(accepted).length
        applied += nAcc
        rejected += e.hunks.length - nAcc
        if (nAcc === 0) continue
        let content: string
        if (e.kind === 'create' || nAcc === e.hunks.length) {
          content = e.proposed
        } else {
          content = fromLf(applyHunks(toLf(e.original), e.hunks, accepted), detectEol(e.original))
        }
        plan.push({ path: e.path, content, original: e.kind === 'create' ? null : e.original })
      }

      const written: typeof plan = []
      try {
        for (const item of plan) {
          await this.fs.write(item.path, item.content)
          written.push(item)
        }
      } catch (err) {
        for (const w of written.reverse()) {
          try {
            if (w.original === null) await this.fs.delete(w.path)
            else await this.fs.write(w.path, w.original)
          } catch {
            /* best effort */
          }
        }
        throw new Error(`Failed to apply changes; rolled back. ${(err as Error).message}`, { cause: err })
      }

      const cp: Checkpoint = {
        id: `cp-${++this.cpCounter}-${Date.now().toString(36)}`,
        createdAt: Date.now(),
        label,
        originals: Object.fromEntries(plan.map((p) => [p.path, p.original])),
        appliedHunks: applied,
        rejectedHunks: rejected,
      }
      this.checkpointsById.set(cp.id, cp)
      this.entries.clear()
      this.dropped.clear()
      this.fire()
      return cp
    })
  }

  /** Restore every file in the checkpoint to its recorded original (created files are deleted). */
  async undo(checkpointId: string): Promise<boolean> {
    const cp = this.checkpointsById.get(checkpointId)
    if (!cp) return false
    for (const [p, original] of Object.entries(cp.originals)) {
      if (original === null) await this.fs.delete(p)
      else await this.fs.write(p, original)
    }
    this.checkpointsById.delete(checkpointId)
    this.fire()
    return true
  }
}
