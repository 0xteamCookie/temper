import { describe, expect, it } from 'vitest';
import { applyHunks, contentForDecisions } from '../../src/review/effectiveContent';
import type { FileChange, Hunk } from '../../src/shared/types';

const orig = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'].join('\n');
const base = { path: 'f', header: '', flags: [], decision: 'pending' as const };
const h0: Hunk = { ...base, id: 'f#0', oldStart: 2, oldLines: 2, newStart: 2, newLines: 3, lines: [' l2', '-l3', '+L3a', '+L3b'] };
const h1: Hunk = { ...base, id: 'f#1', oldStart: 5, oldLines: 2, newStart: 6, newLines: 1, lines: ['-l5', ' l6'] };
const change: FileChange = { path: 'f', kind: 'modify', original: orig, proposed: '', hunks: [h0, h1] };

describe('applyHunks', () => {
  it('applies all when accepted', () => {
    expect(applyHunks(orig, [h0, h1], () => 'accept')).toBe('l1\nl2\nL3a\nL3b\nl4\nl6');
  });
  it('reject restores original text', () => {
    expect(applyHunks(orig, [h0, h1], () => 'reject')).toBe(orig);
  });
  it('mixes per hunk; pending follows pendingAs', () => {
    const dec = { 'f#0': 'accept', 'f#1': 'pending' } as const;
    expect(contentForDecisions(change, dec)).toBe('l1\nl2\nL3a\nL3b\nl4\nl6');
    expect(contentForDecisions(change, dec, { pendingAs: 'reject' })).toBe('l1\nl2\nL3a\nL3b\nl4\nl5\nl6');
  });
  it('preserves CRLF', () => {
    const crlf = orig.replace(/\n/g, '\r\n');
    expect(applyHunks(crlf, [h1], () => 'accept')).toBe('l1\r\nl2\r\nl3\r\nl4\r\nl6');
  });
  it('pure insertion and no-hunk fallback', () => {
    const ins: Hunk = { ...h0, id: 'x', oldStart: 1, oldLines: 0, lines: ['+top'] };
    expect(applyHunks('a\nb', [ins], () => 'accept')).toBe('a\ntop\nb');
    expect(contentForDecisions({ ...change, hunks: [], proposed: 'P' }, {})).toBe('P');
  });
});
