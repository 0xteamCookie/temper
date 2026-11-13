// Pure (vscode-free) helpers: map a unified-diff Hunk onto document lines.
// Design after Continue's vertical diff (Apache-2.0, continuedev/continue @ 5522c6f); written
// from scratch for Temper, which renders without touching the document buffer.
import type { Hunk } from '../shared/types';

/** One contiguous run of removed/added lines inside a hunk (context lines split blocks). */
export interface ChangeBlock {
  /** 0-based document lines that the proposal removes. */
  removed: number[];
  /** Text of the lines the proposal adds (no prefix). */
  added: string[];
  /** Line the block starts at (first removed line, or the insertion point). */
  anchorLine: number;
  /** Line a ghost block of added text hangs off (last removed line, or the line above an insertion). */
  hostLine: number;
}

export interface HunkLayout {
  hunkId: string;
  blocks: ChangeBlock[];
  /** First / last 0-based document line touched by the hunk (changed lines only). */
  firstLine: number;
  lastLine: number;
}

/**
 * @param lineOffset added to every old line number; use it when `original` is a selection
 * slice rather than the whole file (offset = selection start line, 0-based).
 */
export function layoutHunk(hunk: Hunk, lineOffset = 0): HunkLayout {
  let cur = (hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1) + lineOffset;
  const blocks: ChangeBlock[] = [];
  let open: ChangeBlock | undefined;
  const flush = () => {
    if (open) {
      open.hostLine = open.removed.at(-1) ?? Math.max(0, open.anchorLine - 1);
      blocks.push(open);
      open = undefined;
    }
  };
  for (const raw of hunk.lines) {
    const tag = raw[0];
    if (tag === ' ') {
      flush();
      cur++;
    } else if (tag === '-') {
      open ??= { removed: [], added: [], anchorLine: cur, hostLine: cur };
      open.removed.push(cur++);
    } else if (tag === '+') {
      open ??= { removed: [], added: [], anchorLine: cur, hostLine: cur };
      open.added.push(raw.slice(1));
    }
    // '\ No newline at end of file' and anything else is ignored.
  }
  flush();
  const first = blocks.length ? Math.min(...blocks.map((b) => b.anchorLine)) : Math.max(0, hunk.oldStart - 1 + lineOffset);
  const last = blocks.length
    ? Math.max(...blocks.map((b) => b.removed.at(-1) ?? b.anchorLine))
    : first;
  return { hunkId: hunk.id, blocks, firstLine: first, lastLine: last };
}

export function layoutHunks(hunks: Hunk[], lineOffset = 0): HunkLayout[] {
  return hunks.map((h) => layoutHunk(h, lineOffset));
}

/** Id of the hunk whose line span contains `line` (nearest one if none does), else undefined. */
export function hunkAtLine(layouts: HunkLayout[], line: number): string | undefined {
  let best: { id: string; dist: number } | undefined;
  for (const l of layouts) {
    const dist = line < l.firstLine ? l.firstLine - line : line > l.lastLine ? line - l.lastLine : 0;
    if (dist === 0) return l.hunkId;
    if (!best || dist < best.dist) best = { id: l.hunkId, dist };
  }
  return best?.id;
}
