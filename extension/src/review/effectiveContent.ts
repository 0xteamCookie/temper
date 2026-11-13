// Pure: compute file content from the original plus a per-hunk decision map.
// 'accept' and 'pending' hunks are applied (so the right side of a diff previews the proposal);
// 'reject' hunks leave the original text. Pass `pendingAs: 'reject'` to get what would hit disk.
import type { FileChange, Hunk, HunkDecision } from '../shared/types';

export interface ApplyOptions {
  pendingAs?: 'accept' | 'reject';
}

export function applyHunks(
  original: string,
  hunks: Hunk[],
  decisionOf: (h: Hunk) => HunkDecision,
  opts: ApplyOptions = {},
): string {
  const pendingAs = opts.pendingAs ?? 'accept';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const old = original.split(/\r?\n/);
  const out: string[] = [];
  let cursor = 0; // index into old
  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
  for (const h of sorted) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    if (start < cursor) continue; // overlapping hunk: ignore defensively
    while (cursor < start && cursor < old.length) out.push(old[cursor++] ?? '');
    const d = decisionOf(h);
    const take = d === 'accept' || (d === 'pending' && pendingAs === 'accept');
    for (const raw of h.lines) {
      const tag = raw[0];
      const text = raw.slice(1);
      if (tag === ' ') {
        out.push(text);
        cursor++;
      } else if (tag === '-') {
        if (!take) out.push(old[cursor] ?? text);
        cursor++;
      } else if (tag === '+') {
        if (take) out.push(text);
      }
    }
  }
  while (cursor < old.length) out.push(old[cursor++] ?? '');
  return out.join(eol);
}

/** Content of `change` reflecting the hunks' own `decision` fields. */
export function effectiveContent(change: FileChange, opts?: ApplyOptions): string {
  if (change.hunks.length === 0) return change.proposed;
  return applyHunks(change.original, change.hunks, (h) => h.decision, opts);
}

/** Content of `change` for an explicit decision map. */
export function contentForDecisions(
  change: FileChange,
  decisions: Record<string, HunkDecision>,
  opts?: ApplyOptions,
): string {
  if (change.hunks.length === 0) return change.proposed;
  return applyHunks(change.original, change.hunks, (h) => decisions[h.id] ?? h.decision, opts);
}
