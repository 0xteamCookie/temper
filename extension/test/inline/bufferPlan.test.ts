import { describe, expect, it } from 'vitest';
import {
  bufferDecorations,
  chooseDisplayMode,
  displayLayouts,
  planBuffer,
  proposedSideLayouts,
  restoreRanges,
  shiftBlocks,
  toRanges,
} from '../../src/inline/bufferPlan';
import type { BufferBlock, LineRange } from '../../src/inline/bufferPlan';
import { layoutHunks } from '../../src/inline/hunkLayout';
import type { Hunk } from '../../src/shared/types';

const hunk = (over: Partial<Hunk>): Hunk => ({
  id: 'a.ts#0', path: 'a.ts', oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, header: '', lines: [], flags: [], decision: 'pending', ...over,
});

/** Apply delete ranges to text (mimics the WorkspaceEdit restore). */
function applyDeletes(text: string, ranges: LineRange[]): string {
  const lines = text.split('\n');
  const off = (l: number, c: number) => lines.slice(0, l).reduce((n, x) => n + x.length + 1, 0) + c;
  let out = text;
  for (const r of [...ranges].sort((a, b) => off(b.startLine, b.startCharacter) - off(a.startLine, a.startCharacter))) {
    out = out.slice(0, off(r.startLine, r.startCharacter)) + out.slice(off(r.endLine, r.endCharacter));
  }
  return out;
}

const ORIGINAL = 'l0\nl1\nl2\nl3\nl4\nl5\n';
const replace = hunk({ oldStart: 2, oldLines: 2, newStart: 2, newLines: 3, lines: ['-l1', '-l2', '+N1', '+N2', '+N3'] });

describe('planBuffer', () => {
  it('inserts added lines directly below removed lines and records ranges', () => {
    const plan = planBuffer(ORIGINAL, layoutHunks([replace]));
    expect(plan.text).toBe('l0\nl1\nl2\nN1\nN2\nN3\nl3\nl4\nl5\n');
    expect(plan.edits).toEqual([{ line: 3, character: 0, text: 'N1\nN2\nN3\n' }]);
    expect(plan.blocks).toEqual([{ hunkId: 'a.ts#0', insertKind: 'lines', removed: [1, 2], added: [3, 5] }]);
  });
  it('shifts later hunks by earlier insertions and restores exactly', () => {
    const second = hunk({ id: 'a.ts#1', oldStart: 5, oldLines: 1, lines: ['-l4', '+X'] });
    const plan = planBuffer(ORIGINAL, layoutHunks([replace, second]));
    expect(plan.blocks[1]).toMatchObject({ removed: [7, 7], added: [8, 8] });
    expect(plan.text).toBe('l0\nl1\nl2\nN1\nN2\nN3\nl3\nl4\nX\nl5\n');
    const ranges = restoreRanges(plan.blocks, () => 0);
    expect(applyDeletes(plan.text, ranges)).toBe(ORIGINAL);
  });
  it('handles pure insertion and pure deletion', () => {
    const ins = hunk({ oldStart: 3, oldLines: 0, lines: ['+a', '+b'] });
    const p1 = planBuffer(ORIGINAL, layoutHunks([ins]));
    expect(p1.text).toBe('l0\nl1\nl2\na\nb\nl3\nl4\nl5\n');
    expect(p1.blocks[0]).toMatchObject({ added: [3, 4] });
    expect(p1.blocks[0]?.removed).toBeUndefined();
    const del = hunk({ oldStart: 2, oldLines: 1, lines: ['-l1'] });
    const p2 = planBuffer(ORIGINAL, layoutHunks([del]));
    expect(p2.edits).toEqual([]);
    expect(p2.blocks[0]).toMatchObject({ removed: [1, 1] });
    expect(restoreRanges(p2.blocks, () => 0)).toEqual([]);
  });
  it('appends after a last line with no trailing newline and restores exactly', () => {
    const orig = 'a\nb';
    const h = hunk({ oldStart: 2, oldLines: 1, lines: ['-b', '+c', '+d'] });
    const plan = planBuffer(orig, layoutHunks([h]));
    expect(plan.edits).toEqual([{ line: 1, character: 'end', text: '\nc\nd' }]);
    expect(plan.text).toBe('a\nb\nc\nd');
    const lens = plan.text.split('\n').map((l) => l.length);
    const ranges = restoreRanges(plan.blocks, (l) => lens[l] ?? 0);
    expect(applyDeletes(plan.text, ranges)).toBe(orig);
  });
  it('uses CRLF when asked', () => {
    const plan = planBuffer('a\r\nb\r\n', layoutHunks([hunk({ oldStart: 1, oldLines: 1, lines: ['-a', '+z'] })]), '\r\n');
    expect(plan.text).toBe('a\r\nz\r\nb\r\n');
    expect(plan.edits[0]?.text).toBe('z\r\n');
  });
});

describe('shiftBlocks', () => {
  const blocks: BufferBlock[] = [
    { hunkId: 'h0', insertKind: 'lines', removed: [2, 3], added: [4, 5] },
    { hunkId: 'h1', insertKind: 'lines', removed: [10, 10], added: [11, 12] },
  ];
  it('shifts blocks below an edit above them', () => {
    const next = shiftBlocks(blocks, { startLine: 0, endLine: 0, newLineBreaks: 2 });
    expect(next?.[0]).toMatchObject({ removed: [4, 5], added: [6, 7] });
    expect(next?.[1]).toMatchObject({ removed: [12, 12], added: [13, 14] });
  });
  it('leaves blocks above an edit alone', () => {
    const next = shiftBlocks(blocks, { startLine: 7, endLine: 7, newLineBreaks: 1 });
    expect(next?.[0]).toEqual(blocks[0]);
    expect(next?.[1]).toMatchObject({ removed: [11, 11], added: [12, 13] });
  });
  it('returns undefined when an edit touches a block', () => {
    expect(shiftBlocks(blocks, { startLine: 4, endLine: 4, newLineBreaks: 0 })).toBeUndefined();
    expect(shiftBlocks(blocks, { startLine: 1, endLine: 2, newLineBreaks: 0 })).toBeUndefined();
  });
  it('treats the line before an eof insert as part of the block', () => {
    const eof: BufferBlock[] = [{ hunkId: 'h', insertKind: 'eof', removed: [5, 5], added: [6, 7] }];
    expect(shiftBlocks(eof, { startLine: 8, endLine: 8, newLineBreaks: 0 })).toBeDefined();
    expect(shiftBlocks(eof, { startLine: 4, endLine: 4, newLineBreaks: 0 })).toBeDefined();
    const bare: BufferBlock[] = [{ hunkId: 'h', insertKind: 'eof', added: [6, 7] }];
    expect(shiftBlocks(bare, { startLine: 5, endLine: 5, newLineBreaks: 0 })).toBeUndefined();
    expect(shiftBlocks(eof, { startLine: 5, endLine: 5, newLineBreaks: 0 })).toBeUndefined();
  });
});

describe('decorations and layouts', () => {
  const blocks: BufferBlock[] = [{ hunkId: 'h0', insertKind: 'lines', removed: [2, 3], added: [4, 5] }];
  it('buckets lines by decision', () => {
    expect(bufferDecorations(blocks, { h0: 'pending' })).toMatchObject({ removedPending: [2, 3], addedPending: [4, 5] });
    expect(bufferDecorations(blocks, { h0: 'accept' })).toMatchObject({ removedAccepted: [2, 3], addedAccepted: [4, 5], removedPending: [] });
    expect(bufferDecorations(blocks, { h0: 'reject' })).toMatchObject({ removedRejected: [2, 3], addedRejected: [4, 5] });
  });
  it('display layouts span removed+added; proposed-side layouts use new line numbers', () => {
    const h = hunk({ id: 'h0', oldStart: 3, oldLines: 2, newStart: 3, newLines: 2 });
    const dl = displayLayouts([h], blocks, layoutHunks([h]));
    expect([dl[0]?.firstLine, dl[0]?.lastLine]).toEqual([2, 5]);
    const ps = proposedSideLayouts([h], 1);
    expect([ps[0]?.firstLine, ps[0]?.lastLine]).toEqual([3, 4]);
  });
  it('toRanges merges contiguous lines', () => {
    expect(toRanges([5, 1, 2, 2, 3])).toEqual([[1, 3], [5, 5]]);
  });
});

describe('chooseDisplayMode', () => {
  it('uses the buffer only for clean, saved files with auto-save off', () => {
    expect(chooseDisplayMode({ autoSave: 'off', isDirty: false, scheme: 'file' }).mode).toBe('buffer');
    expect(chooseDisplayMode({ autoSave: undefined, isDirty: false, scheme: 'file' }).mode).toBe('buffer');
  });
  it('falls back to side-by-side with a reason', () => {
    for (const autoSave of ['afterDelay', 'onFocusChange', 'onWindowChange']) {
      const r = chooseDisplayMode({ autoSave, isDirty: false, scheme: 'file' });
      expect(r.mode).toBe('diff');
      expect(r.reason).toMatch(/auto-save/);
    }
    expect(chooseDisplayMode({ autoSave: 'off', isDirty: true, scheme: 'file' }).mode).toBe('diff');
    expect(chooseDisplayMode({ autoSave: 'off', isDirty: false, scheme: 'untitled' }).mode).toBe('diff');
  });
});
