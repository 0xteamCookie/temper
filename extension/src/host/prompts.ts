// Prompt composition for agent and inline runs (pure).
import type { Mention } from '../shared/messages';

/** Mentions are prepended as @path / @symbol:name lines; the context engine's get_context resolves them. */
export function composeAgentPrompt(text: string, mentions: Mention[] = []): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const m of mentions) {
    const line = m.kind === 'file' ? `@${m.value}` : `@symbol:${m.value}`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  return lines.length ? `${lines.join('\n')}\n\n${text}` : text;
}

export interface InlinePromptInput {
  path: string;
  instruction: string;
  /** Whole document split into lines (no EOLs). */
  lines: string[];
  /** 1-based inclusive selection range, whole lines. */
  startLine: number;
  endLine: number;
  contextLines?: number;
}

function numbered(lines: string[], from: number, width: number): string {
  return lines.map((l, i) => `${String(from + i).padStart(width)}| ${l}`).join('\n');
}

export function buildInlinePrompt(i: InlinePromptInput): string {
  const ctx = i.contextLines ?? 20;
  const total = i.lines.length;
  const start = Math.max(1, Math.min(i.startLine, total || 1));
  const end = Math.max(start, Math.min(i.endLine, total || 1));
  const width = String(Math.min(total, end + ctx)).length;
  const beforeFrom = Math.max(1, start - ctx);
  const afterTo = Math.min(total, end + ctx);
  const parts = [
    `Instruction: ${i.instruction}`,
    `File: ${i.path}`,
    `Selection: lines ${start}-${end} (1-based, inclusive)`,
    '',
    `Selected text (line numbers are display only, do not include them in old_string):`,
    numbered(i.lines.slice(start - 1, end), start, width),
  ];
  if (beforeFrom < start) {
    parts.push('', `Context before (lines ${beforeFrom}-${start - 1}):`, numbered(i.lines.slice(beforeFrom - 1, start - 1), beforeFrom, width));
  }
  if (afterTo > end) {
    parts.push('', `Context after (lines ${end + 1}-${afterTo}):`, numbered(i.lines.slice(end, afterTo), end + 1, width));
  }
  return parts.join('\n');
}
