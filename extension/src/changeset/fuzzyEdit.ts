// Fuzzy search/replace edit application built on the replacer chain ported from opencode
// (see ./replacers.ts for origin and licence). Temper-authored: result objects, CRLF preservation,
// empty-oldString create, closest-lines miss hint (idea from opencode HEAD's missHint).
import {
  BlockAnchorReplacer,
  ContextAwareReplacer,
  EscapeNormalizedReplacer,
  IndentationFlexibleReplacer,
  LineTrimmedReplacer,
  MultiOccurrenceReplacer,
  SimpleReplacer,
  TrimmedBoundaryReplacer,
  WhitespaceNormalizedReplacer,
  levenshtein,
  type Replacer,
} from './replacers'

const REPLACERS: ReadonlyArray<readonly [string, Replacer]> = [
  ['exact', SimpleReplacer],
  ['line-trimmed', LineTrimmedReplacer],
  ['block-anchor', BlockAnchorReplacer],
  ['whitespace-normalized', WhitespaceNormalizedReplacer],
  ['indentation-flexible', IndentationFlexibleReplacer],
  ['escape-normalized', EscapeNormalizedReplacer],
  ['trimmed-boundary', TrimmedBoundaryReplacer],
  ['context-aware', ContextAwareReplacer],
  ['multi-occurrence', MultiOccurrenceReplacer],
]

export type ReplaceResult =
  | { ok: true; content: string; strategy: string }
  | { ok: false; reason: 'notFound' | 'ambiguous' | 'noop' | 'emptyOld'; message: string }

/** Dominant line ending of a text: CRLF when CRLF outnumbers bare LF. */
export function detectEol(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/\n/g) ?? []).length - crlf
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n'
}

export const toLf = (s: string): string => s.replace(/\r\n/g, '\n')
export const fromLf = (s: string, eol: '\r\n' | '\n'): string => (eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s)

/** Lines of `content` most similar to the first meaningful line of `find`, for a "did you mean" hint. */
export function missHint(content: string, find: string, max = 3): string {
  const probe = toLf(find)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!probe) return ''
  const lines = toLf(content).split('\n')
  const scored: { n: number; text: string; score: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim()
    if (!t) continue
    const maxLen = Math.max(t.length, probe.length)
    const score = 1 - levenshtein(t.slice(0, 200), probe.slice(0, 200)) / Math.min(maxLen, 200)
    scored.push({ n: i + 1, text: lines[i]!, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.filter((s) => s.score >= 0.4).slice(0, max)
  if (top.length === 0) return ''
  return 'Closest lines in the file:\n' + top.map((s) => `  ${s.n}: ${s.text}`).join('\n')
}

/**
 * Replace `oldString` with `newString` in `content` using the fuzzy replacer chain.
 * Line endings of `content` are preserved (CRLF files stay CRLF). An empty `oldString`
 * is only valid when `content` is empty (file creation) and yields `newString`.
 */
export function replace(content: string, oldString: string, newString: string, replaceAll = false): ReplaceResult {
  if (oldString === '') {
    if (content === '') return { ok: true, content: newString, strategy: 'create' }
    return {
      ok: false,
      reason: 'emptyOld',
      message: 'oldString is empty but the file already has content. Provide the exact text to replace.',
    }
  }
  if (oldString === newString) {
    return { ok: false, reason: 'noop', message: 'oldString and newString are identical; nothing to change.' }
  }

  const eol = detectEol(content)
  const src = toLf(content)
  const find = toLf(oldString)
  const repl = toLf(newString)
  let notFound = true

  for (const [strategy, replacer] of REPLACERS) {
    for (const search of replacer(src, find)) {
      const index = src.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (replaceAll) {
        return { ok: true, content: fromLf(src.replaceAll(search, () => repl), eol), strategy }
      }
      const lastIndex = src.lastIndexOf(search)
      if (index !== lastIndex) continue
      return {
        ok: true,
        content: fromLf(src.substring(0, index) + repl + src.substring(index + search.length), eol),
        strategy,
      }
    }
  }

  if (notFound) {
    const hint = missHint(content, oldString)
    return {
      ok: false,
      reason: 'notFound',
      message:
        'oldString was not found in the file. Re-read the file and copy the text exactly, including indentation.' +
        (hint ? '\n' + hint : ''),
    }
  }
  return {
    ok: false,
    reason: 'ambiguous',
    message:
      'Found multiple matches for oldString. Include more surrounding lines in oldString to identify the correct match, or set replaceAll to change every occurrence.',
  }
}
