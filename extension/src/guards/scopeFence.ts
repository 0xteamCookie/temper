// Scope Fence: flags (and optionally rejects/drops) hunks that fall outside the
// scope the user asked for. Core logic is pure; applyScopeFenceToStore adapts a ChangesetStore.
import type { Hunk } from '../shared/types'

export type Scope =
  | { kind: 'selection'; path: string; startLine: number; endLine: number } // 1-based, inclusive
  | { kind: 'plan'; paths: string[] }

export type ScopeFenceMode = 'flagAndReject' | 'block' | 'warn' | 'off'

export interface ScopeFenceResult {
  /** Hunks to keep in review (block mode removes the dropped ones). */
  kept: Hunk[]
  flagged: Hunk[]
  dropped: Hunk[]
}

/** Change groups (maximal runs of +/- lines) as old-file line ranges. Pure insertions have del=false. */
export function changeGroups(h: Hunk): { from: number; to: number; del: boolean }[] {
  const groups: { from: number; to: number; del: boolean }[] = []
  let oldNo = h.oldStart
  let cur: { from: number; to: number; del: boolean } | null = null
  for (const l of h.lines) {
    const tag = l[0]
    if (tag === '\\') continue
    if (tag === ' ') {
      if (cur) groups.push(cur)
      cur = null
      oldNo++
      continue
    }
    cur ??= { from: oldNo, to: oldNo, del: false }
    if (tag === '-') {
      cur.del = true
      cur.to = oldNo
      oldNo++
    }
  }
  if (cur) groups.push(cur)
  return groups
}

const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')

function outsideReason(h: Hunk, scope: Scope): { kind: 'outsideSelection' | 'outsidePlan'; detail: string } | null {
  if (scope.kind === 'plan') {
    const ok = scope.paths.some((p) => normPath(p) === normPath(h.path))
    return ok ? null : { kind: 'outsidePlan', detail: `${h.path} is not in the plan` }
  }
  if (normPath(h.path) !== normPath(scope.path)) {
    return { kind: 'outsideSelection', detail: `${h.path} is not the selected file (${scope.path})` }
  }
  for (const g of changeGroups(h)) {
    // A pure insertion before line n is inside when start <= n <= end + 1.
    const inside = g.del
      ? g.from >= scope.startLine && g.to <= scope.endLine
      : g.from >= scope.startLine && g.from <= scope.endLine + 1
    if (!inside) {
      const where = g.del ? `lines ${g.from}-${g.to}` : `line ${g.from}`
      return { kind: 'outsideSelection', detail: `change at ${where} is outside the selection ${scope.startLine}-${scope.endLine}` }
    }
  }
  return null
}

/** Mutates hunk flags/decisions in place according to `mode`. */
export function applyScopeFence(hunks: Hunk[], scope: Scope, mode: ScopeFenceMode): ScopeFenceResult {
  if (mode === 'off') return { kept: hunks, flagged: [], dropped: [] }
  const flagged: Hunk[] = []
  const dropped: Hunk[] = []
  const kept: Hunk[] = []
  for (const h of hunks) {
    const why = outsideReason(h, scope)
    if (!why) {
      kept.push(h)
      continue
    }
    h.flags.push({ kind: why.kind, detail: why.detail })
    flagged.push(h)
    if (mode === 'block') {
      h.decision = 'reject'
      dropped.push(h)
      continue
    }
    if (mode === 'flagAndReject') h.decision = 'reject'
    kept.push(h)
  }
  return { kept, flagged, dropped }
}

interface FenceableStore {
  files(): { hunks: Hunk[] }[]
  dropHunks(ids: string[]): void
}

/** Run the fence over every hunk currently in a ChangesetStore (block mode drops hunks from it). */
export function applyScopeFenceToStore(store: FenceableStore, scope: Scope, mode: ScopeFenceMode): ScopeFenceResult {
  const all = store.files().flatMap((f) => f.hunks)
  const res = applyScopeFence(all, scope, mode)
  if (res.dropped.length) store.dropHunks(res.dropped.map((h) => h.id))
  return res
}
