// Pure helpers for the Ctrl+Alt+K prompt.
const MAX_HISTORY = 20;

export function pushHistory(history: string[], entry: string, max = MAX_HISTORY): string[] {
  const t = entry.trim();
  if (!t) return history;
  return [t, ...history.filter((h) => h !== t)].slice(0, max);
}

export function formatTitle(basename: string, startLine1: number, endLine1: number, model?: string): string {
  const lines = startLine1 === endLine1 ? `line ${startLine1}` : `lines ${startLine1}–${endLine1}`;
  return ['Temper', `Edit ${basename}`, lines, model].filter(Boolean).join(' · ');
}

export const TYPED_PREFIX = '$(sparkle) ';
export const HISTORY_PREFIX = '$(history) ';

/** Removes the codicon prefix the picker adds to typed/history item labels. */
export function stripItemPrefix(label: string): string {
  for (const p of [TYPED_PREFIX, HISTORY_PREFIX]) if (label.startsWith(p)) return label.slice(p.length);
  return label;
}

export interface SelectionPos {
  startLine: number; // 0-based
  startChar: number;
  endLine: number; // 0-based
  endChar: number;
}

/**
 * 1-based inclusive line span of a selection, or undefined when it is empty. A selection ending at
 * column 0 of a later line does not include that line.
 */
export function selectionToLines(s: SelectionPos): { startLine: number; endLine: number } | undefined {
  if (s.startLine === s.endLine && s.startChar === s.endChar) return undefined;
  const end = s.endChar === 0 && s.endLine > s.startLine ? s.endLine - 1 : s.endLine;
  return { startLine: s.startLine + 1, endLine: end + 1 };
}
