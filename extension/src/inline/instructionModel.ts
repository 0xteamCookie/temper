// Pure helpers for the Ctrl+Alt+K prompt.
const MAX_HISTORY = 20;

export function pushHistory(history: string[], entry: string, max = MAX_HISTORY): string[] {
  const t = entry.trim();
  if (!t) return history;
  return [t, ...history.filter((h) => h !== t)].slice(0, max);
}

export function formatTitle(startLine1: number, endLine1: number): string {
  return startLine1 === endLine1
    ? `Temper: edit selection (Line ${startLine1})`
    : `Temper: edit selection (Lines ${startLine1}–${endLine1})`;
}
