import { describe, expect, it } from 'vitest';
import { hunkAtLine, layoutHunk, layoutHunks } from '../../src/inline/hunkLayout';
import { buildLenses, flagText, summarize } from '../../src/inline/lensModel';
import { formatTitle, pushHistory, selectionToLines, stripItemPrefix } from '../../src/inline/instructionModel';
import type { Hunk } from '../../src/shared/types';

const hunk = (over: Partial<Hunk>): Hunk => ({
  id: 'a.ts#0', path: 'a.ts', oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, header: '', lines: [], flags: [], decision: 'pending', ...over,
});

const replace = hunk({
  oldStart: 3, oldLines: 4, newStart: 3, newLines: 5,
  lines: [' ctx', '-old1', '-old2', '+new1', '+new2', '+new3', ' tail'],
});

describe('layoutHunk', () => {
  it('maps removed and added lines to 0-based document lines', () => {
    const l = layoutHunk(replace);
    expect(l.blocks).toHaveLength(1);
    expect(l.blocks[0]).toMatchObject({ removed: [3, 4], added: ['new1', 'new2', 'new3'], anchorLine: 3, hostLine: 4 });
    expect(l.firstLine).toBe(3);
    expect(l.lastLine).toBe(4);
  });
  it('handles pure insertion (oldLines 0 => insert after oldStart)', () => {
    const l = layoutHunk(hunk({ oldStart: 5, oldLines: 0, lines: ['+x', '+y'] }));
    expect(l.blocks[0]).toMatchObject({ removed: [], added: ['x', 'y'], anchorLine: 5, hostLine: 4 });
  });
  it('splits blocks at context lines and applies lineOffset', () => {
    const l = layoutHunk(hunk({ oldStart: 1, oldLines: 4, lines: ['-a', ' b', '-c', '+C', ' d'] }), 10);
    expect(l.blocks.map((b) => b.removed)).toEqual([[10], [12]]);
  });
  it('ignores "no newline" markers', () => {
    const l = layoutHunk(hunk({ oldStart: 1, oldLines: 1, lines: ['-a', '\\ No newline at end of file', '+b'] }));
    expect(l.blocks[0]?.added).toEqual(['b']);
  });
  it('hunkAtLine picks containing or nearest hunk', () => {
    const ls = layoutHunks([replace, hunk({ id: 'a.ts#1', oldStart: 20, oldLines: 1, lines: ['-z'] })]);
    expect(hunkAtLine(ls, 4)).toBe('a.ts#0');
    expect(hunkAtLine(ls, 18)).toBe('a.ts#1');
    expect(hunkAtLine([], 1)).toBeUndefined();
  });
});

describe('buildLenses', () => {
  const flagged = hunk({ ...replace, flags: [{ kind: 'outsideSelection', detail: '' }], rationale: 'because' });
  const layouts = layoutHunks([flagged]);
  it('top lens, per-hunk lenses, flag and rationale', () => {
    const ls = buildLenses('u', [flagged], layouts, { 'a.ts#0': 'pending' }, 100);
    const titles = ls.map((l) => l.title);
    expect(titles).toContain('✓ Accept All');
    expect(titles).toContain('✗ Reject All');
    expect(titles).toContain('✓ Accept (Ctrl+Alt+Y)');
    expect(titles).toContain('✗ Reject (Ctrl+Alt+N)');
    expect(titles.some((t) => t.includes('outside selection — rejected by default'))).toBe(true);
    expect(titles).toContain('Why: because');
    expect(ls.find((l) => l.title.startsWith('✓ Accept ('))?.args).toEqual(['u', 'a.ts#0']);
  });
  it('decided hunks show state + undo instead of accept/reject', () => {
    const titles = buildLenses('u', [flagged], layouts, { 'a.ts#0': 'accept' }, 100).map((l) => l.title);
    expect(titles).toContain('✓ Accepted');
    expect(titles).toContain('↺ Undo decision');
    expect(titles).not.toContain('✓ Accept (Ctrl+Alt+Y)');
  });
  it('clamps lens lines to document and is empty without hunks', () => {
    expect(buildLenses('u', [], [], {}, 5)).toEqual([]);
    expect(Math.max(...buildLenses('u', [flagged], layouts, {}, 2).map((l) => l.line))).toBe(1);
  });
  it('summarize / flagText', () => {
    expect(summarize({ a: 'accept', b: 'reject', c: 'pending' })).toEqual({ pending: 1, accepted: 1, rejected: 1 });
    expect(flagText({ kind: 'unknownSymbol', symbols: ['foo'], suggestions: {} })).toContain('foo');
  });
});

describe('instruction model', () => {
  it('title uses en dash for ranges', () => {
    expect(formatTitle('helpers.py', 42, 58, 'qwen')).toBe('Temper · Edit helpers.py · lines 42–58 · qwen');
    expect(formatTitle('a.ts', 4, 4)).toBe('Temper · Edit a.ts · line 4');
  });
  it('strips picker prefixes', () => {
    expect(stripItemPrefix('$(sparkle) do it')).toBe('do it');
    expect(stripItemPrefix('$(history) old')).toBe('old');
    expect(stripItemPrefix('plain')).toBe('plain');
  });
  it('maps selections to 1-based inclusive lines', () => {
    expect(selectionToLines({ startLine: 2, startChar: 1, endLine: 4, endChar: 3 })).toEqual({ startLine: 3, endLine: 5 });
    expect(selectionToLines({ startLine: 2, startChar: 0, endLine: 4, endChar: 0 })).toEqual({ startLine: 3, endLine: 4 });
    expect(selectionToLines({ startLine: 2, startChar: 1, endLine: 2, endChar: 1 })).toBeUndefined();
    expect(selectionToLines({ startLine: 2, startChar: 0, endLine: 2, endChar: 0 })).toBeUndefined();
  });
  it('history dedupes, trims, caps', () => {
    expect(pushHistory(['a', 'b'], ' b ')).toEqual(['b', 'a']);
    expect(pushHistory(['a'], '  ')).toEqual(['a']);
    expect(pushHistory(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });
});
