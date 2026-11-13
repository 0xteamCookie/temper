// Pure decoration plan: which lines get which look, and the text of the green ghost blocks.
import type { HunkDecision } from '../shared/types';
import type { HunkLayout } from './hunkLayout';

export interface GhostBlock {
  hostLine: number;
  /** Lines of added text (raw, unescaped). */
  lines: string[];
  state: HunkDecision;
}

export interface DecorationPlan {
  removedPending: number[];
  removedAccepted: number[];
  /** Original lines kept because the hunk was rejected: only a faint marker. */
  keptRejected: number[];
  ghosts: GhostBlock[];
}

export function planDecorations(layouts: HunkLayout[], decisions: Record<string, HunkDecision>): DecorationPlan {
  const plan: DecorationPlan = { removedPending: [], removedAccepted: [], keptRejected: [], ghosts: [] };
  for (const l of layouts) {
    const d = decisions[l.hunkId] ?? 'pending';
    for (const b of l.blocks) {
      const target = d === 'accept' ? plan.removedAccepted : d === 'reject' ? plan.keptRejected : plan.removedPending;
      target.push(...b.removed);
      if (b.added.length) plan.ghosts.push({ hostLine: b.hostLine, lines: b.added, state: d });
    }
  }
  return plan;
}

const NBSP = String.fromCharCode(0xa0);

/** Make ghost text safe for a CSS `content: "..."` string that uses `\A` newlines and `white-space: pre`. */
export function cssGhostContent(lines: string[], marker: string): string {
  const esc = (s: string) =>
    s
      .replace(/\t/g, NBSP.repeat(4))
      .replace(/ /g, NBSP)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/[\r\n]/g, '');
  return lines.map((ln) => `${marker}${NBSP}${esc(ln)}`).join('\\A ');
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
