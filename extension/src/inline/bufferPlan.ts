// Pure (vscode-free) planning for the in-buffer inline diff.
//
// Pattern after Continue's vertical diff (Apache-2.0, continuedev/continue @ 5522c6f), written from
// scratch for Temper: each hunk's added lines are inserted into the editor BUFFER directly below its
// removed lines, so both versions are real, stacked, legible lines. The insert is temporary: the
// session removes it again (restoreRanges) before anything is applied, and never saves it.
import type { Hunk, HunkDecision } from '../shared/types';
import type { HunkLayout } from './hunkLayout';

/** A pending insert, in ORIGINAL document coordinates. */
export interface BufferEdit {
  line: number;
  /** 0 = column 0; 'end' = end of `line` (appending after a last line that has no EOL). */
  character: 0 | 'end';
  text: string;
}

/** One change block located in the buffer AS MODIFIED (inserted lines present). Line ranges inclusive. */
export interface BufferBlock {
  hunkId: string;
  removed?: [number, number];
  added?: [number, number];
  /** How the added lines were inserted; decides the exact range to delete on restore. */
  insertKind: 'lines' | 'eof';
}

export interface BufferPlan {
  edits: BufferEdit[];
  /** The document text after applying `edits` (for tests / sanity checks). */
  text: string;
  blocks: BufferBlock[];
}

export function detectEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Plan the temporary insert of every hunk's added lines directly below its removed lines. */
export function planBuffer(original: string, layouts: HunkLayout[], eol: '\n' | '\r\n' = detectEol(original)): BufferPlan {
  const lines = original.split(/\r?\n/);
  interface Item {
    hunkId: string;
    anchor: number;
    removedCount: number;
    added: string[];
    insertLine: number;
  }
  const items: Item[] = [];
  for (const l of layouts) {
    for (const b of l.blocks) {
      items.push({
        hunkId: l.hunkId,
        anchor: b.anchorLine,
        removedCount: b.removed.length,
        added: b.added,
        insertLine: Math.min(lines.length, b.anchorLine + b.removed.length),
      });
    }
  }
  items.sort((a, b) => a.insertLine - b.insertLine || a.anchor - b.anchor);

  const edits: BufferEdit[] = [];
  const blocks: BufferBlock[] = [];
  let shift = 0;
  for (const it of items) {
    const block: BufferBlock = { hunkId: it.hunkId, insertKind: 'lines' };
    if (it.removedCount > 0) block.removed = [it.anchor + shift, it.anchor + shift + it.removedCount - 1];
    if (it.added.length > 0) {
      const start = it.insertLine + shift;
      block.added = [start, start + it.added.length - 1];
      if (it.insertLine >= lines.length) {
        block.insertKind = 'eof';
        edits.push({ line: lines.length - 1, character: 'end', text: eol + it.added.join(eol) });
      } else {
        edits.push({ line: it.insertLine, character: 0, text: it.added.join(eol) + eol });
      }
      shift += it.added.length;
    }
    blocks.push(block);
  }
  const out = [...lines];
  for (const it of [...items].reverse()) {
    if (it.added.length > 0) out.splice(it.insertLine, 0, ...it.added);
  }
  return { edits, text: out.join(eol), blocks };
}

export interface LineRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/** Ranges to delete, in the current (modified) buffer, to remove exactly the inserted lines. */
export function restoreRanges(blocks: BufferBlock[], lineLength: (line: number) => number): LineRange[] {
  const out: LineRange[] = [];
  for (const b of blocks) {
    if (!b.added) continue;
    const [a0, a1] = b.added;
    if (b.insertKind === 'eof') {
      out.push({ startLine: a0 - 1, startCharacter: lineLength(a0 - 1), endLine: a1, endCharacter: lineLength(a1) });
    } else {
      out.push({ startLine: a0, startCharacter: 0, endLine: a1 + 1, endCharacter: 0 });
    }
  }
  return out;
}

/** First/last buffer line a block occupies (including the line before an eof insert). */
function span(b: BufferBlock): [number, number] {
  const starts = [b.removed?.[0], b.added?.[0]].filter((n): n is number => n !== undefined);
  const ends = [b.removed?.[1], b.added?.[1]].filter((n): n is number => n !== undefined);
  const s = Math.min(...starts);
  return [b.insertKind === 'eof' && !b.removed ? s - 1 : s, Math.max(...ends)];
}

export interface DocChange {
  startLine: number;
  endLine: number;
  /** Number of line breaks in the replacement text. */
  newLineBreaks: number;
}

/**
 * Track blocks through a user edit made to the (modified) buffer. Returns the shifted blocks, or
 * undefined if the edit touches a block (the session must then be cancelled).
 */
export function shiftBlocks(blocks: BufferBlock[], c: DocChange): BufferBlock[] | undefined {
  const delta = c.newLineBreaks - (c.endLine - c.startLine);
  const out: BufferBlock[] = [];
  for (const b of blocks) {
    const [s, e] = span(b);
    if (c.startLine <= e && c.endLine >= s) return undefined;
    if (s > c.endLine && delta !== 0) {
      const nb: BufferBlock = { hunkId: b.hunkId, insertKind: b.insertKind };
      if (b.removed) nb.removed = [b.removed[0] + delta, b.removed[1] + delta];
      if (b.added) nb.added = [b.added[0] + delta, b.added[1] + delta];
      out.push(nb);
    } else out.push(b);
  }
  return out;
}

/** Per-hunk display layouts (line spans in the modified buffer) for CodeLens placement. */
export function displayLayouts(hunks: Hunk[], blocks: BufferBlock[], fallback: HunkLayout[]): HunkLayout[] {
  return hunks.map((h, i) => {
    const mine = blocks.filter((b) => b.hunkId === h.id);
    if (mine.length === 0) return fallback[i] ?? { hunkId: h.id, blocks: [], firstLine: 0, lastLine: 0 };
    const spans = mine.map(span);
    return {
      hunkId: h.id,
      blocks: [],
      firstLine: Math.min(...spans.map((s) => s[0])),
      lastLine: Math.max(...spans.map((s) => s[1])),
    };
  });
}

/** Layouts for the side-by-side fallback: line spans on the PROPOSED side of the diff. */
export function proposedSideLayouts(hunks: Hunk[], lineOffset = 0): HunkLayout[] {
  return hunks.map((h) => {
    const first = Math.max(0, (h.newLines === 0 ? h.newStart : h.newStart - 1) + lineOffset);
    return { hunkId: h.id, blocks: [], firstLine: first, lastLine: first + Math.max(0, h.newLines - 1) };
  });
}

export interface BufferDecorationPlan {
  removedPending: number[];
  removedAccepted: number[];
  removedRejected: number[];
  addedPending: number[];
  addedAccepted: number[];
  addedRejected: number[];
}

const range = (r?: [number, number]): number[] => {
  const out: number[] = [];
  if (r) for (let i = r[0]; i <= r[1]; i++) out.push(i);
  return out;
};

/** Which buffer lines get which look, given the per-hunk decisions. */
export function bufferDecorations(blocks: BufferBlock[], decisions: Record<string, HunkDecision>): BufferDecorationPlan {
  const p: BufferDecorationPlan = {
    removedPending: [],
    removedAccepted: [],
    removedRejected: [],
    addedPending: [],
    addedAccepted: [],
    addedRejected: [],
  };
  for (const b of blocks) {
    const d = decisions[b.hunkId] ?? 'pending';
    const rem = d === 'accept' ? p.removedAccepted : d === 'reject' ? p.removedRejected : p.removedPending;
    const add = d === 'accept' ? p.addedAccepted : d === 'reject' ? p.addedRejected : p.addedPending;
    rem.push(...range(b.removed));
    add.push(...range(b.added));
  }
  return p;
}

/** Whether the buffer may be touched for this document. Anything uncertain falls back to a diff editor. */
export function chooseDisplayMode(input: {
  autoSave: string | undefined;
  isDirty: boolean;
  scheme: string;
}): { mode: 'buffer' | 'diff'; reason?: string } {
  if (input.autoSave !== undefined && input.autoSave !== 'off') {
    return { mode: 'diff', reason: 'auto-save is on for this file, so the change opens side-by-side instead of being previewed in the editor' };
  }
  if (input.isDirty) return { mode: 'diff', reason: 'this file has unsaved changes, so the change opens side-by-side' };
  if (input.scheme !== 'file') return { mode: 'diff', reason: 'this document is not a saved file, so the change opens side-by-side' };
  return { mode: 'buffer' };
}

/** Line numbers -> inclusive [start, end] ranges of contiguous lines (input may be unsorted/duplicated). */
export function toRanges(lines: number[]): Array<[number, number]> {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}
