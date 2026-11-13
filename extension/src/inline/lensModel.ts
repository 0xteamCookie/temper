// Pure CodeLens model for inline diffs: what lenses exist, where, and which command each runs.
import type { Hunk, HunkDecision, ScopeFlag } from '../shared/types';
import type { HunkLayout } from './hunkLayout';

export const INLINE_COMMANDS = {
  acceptHunk: 'temper.inline.acceptHunk',
  rejectHunk: 'temper.inline.rejectHunk',
  resetHunk: 'temper.inline.resetHunk',
  acceptAll: 'temper.inline.acceptAll',
  rejectAll: 'temper.inline.rejectAll',
  acceptAtCursor: 'temper.inline.acceptAtCursor',
  rejectAtCursor: 'temper.inline.rejectAtCursor',
  cancel: 'temper.inline.cancel',
  openSideBySide: 'temper.inline.openSideBySide',
} as const;

export interface LensSpec {
  line: number;
  title: string;
  /** '' = informational text only. */
  command: string;
  args: unknown[];
  tooltip?: string;
}

export function flagText(flag: ScopeFlag): string {
  switch (flag.kind) {
    case 'outsideSelection':
      return `⚠ outside selection — rejected by default${flag.detail ? ` (${flag.detail})` : ''}`;
    case 'outsidePlan':
      return `⚠ outside plan${flag.detail ? `: ${flag.detail}` : ''}`;
    case 'unknownSymbol':
      return `⚠ unknown symbol: ${flag.symbols.join(', ')}`;
  }
}

export function summarize(decisions: Record<string, HunkDecision>): { pending: number; accepted: number; rejected: number } {
  const s = { pending: 0, accepted: 0, rejected: 0 };
  for (const d of Object.values(decisions)) {
    if (d === 'accept') s.accepted++;
    else if (d === 'reject') s.rejected++;
    else s.pending++;
  }
  return s;
}

export function buildLenses(
  uri: string,
  hunks: Hunk[],
  layouts: HunkLayout[],
  decisions: Record<string, HunkDecision>,
  lineCount: number,
): LensSpec[] {
  const clamp = (n: number) => Math.min(Math.max(0, n), Math.max(0, lineCount - 1));
  const out: LensSpec[] = [];
  if (layouts.length === 0) return out;
  const top = clamp(Math.min(...layouts.map((l) => l.firstLine)));
  const s = summarize(decisions);
  out.push(
    { line: top, title: '✓ Accept All', command: INLINE_COMMANDS.acceptAll, args: [uri] },
    { line: top, title: '✗ Reject All', command: INLINE_COMMANDS.rejectAll, args: [uri] },
    { line: top, title: '⇄ Side-by-side', command: INLINE_COMMANDS.openSideBySide, args: [uri] },
    {
      line: top,
      title: `${layouts.length} change${layouts.length === 1 ? '' : 's'}: ${s.accepted} accepted, ${s.rejected} rejected, ${s.pending} pending`,
      command: '',
      args: [],
    },
  );
  const byId = new Map(hunks.map((h) => [h.id, h]));
  for (const l of layouts) {
    const h = byId.get(l.hunkId);
    if (!h) continue;
    const line = clamp(l.firstLine);
    const d = decisions[h.id] ?? 'pending';
    if (d === 'pending') {
      out.push(
        { line, title: '✓ Accept (Ctrl+Alt+Y)', command: INLINE_COMMANDS.acceptHunk, args: [uri, h.id] },
        { line, title: '✗ Reject (Ctrl+Alt+N)', command: INLINE_COMMANDS.rejectHunk, args: [uri, h.id] },
      );
    } else {
      out.push(
        { line, title: d === 'accept' ? '✓ Accepted' : '✗ Rejected', command: '', args: [] },
        { line, title: '↺ Undo decision', command: INLINE_COMMANDS.resetHunk, args: [uri, h.id] },
      );
    }
    for (const f of h.flags) out.push({ line, title: flagText(f), command: '', args: [] });
    if (h.rationale) out.push({ line, title: `Why: ${h.rationale}`, command: '', args: [], tooltip: h.rationale });
  }
  return out;
}
