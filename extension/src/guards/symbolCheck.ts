// Symbol Check: finds identifiers that an edit newly introduces as calls / attribute bases /
// relative imports and that exist neither in the project symbol index, the language builtins,
// nor the edit itself. Heuristic and tuned for LOW false positives (Python first, generic fallback).

export interface SymbolIndex {
  has(name: string): boolean
  suggest(name: string): string[]
}

export type SymbolCheckMode = 'bounceThenWarn' | 'bounce' | 'warn' | 'off'
export type SymbolCheckAction = 'none' | 'bounce' | 'warn'
export type SymbolLanguage = 'python' | 'generic'

export interface SymbolCheckInput {
  oldText: string
  newText: string
  index: SymbolIndex
  language?: SymbolLanguage
  /** Whole original file (optional): names defined/imported anywhere in it count as known. */
  fileText?: string
  /** Extra names to treat as known (e.g. project-specific globals). */
  extraKnown?: Iterable<string>
  mode?: SymbolCheckMode
  /** How many times this edit was already bounced (for bounceThenWarn). */
  priorBounces?: number
}

export interface SymbolCheckResult {
  unknown: string[]
  suggestions: Record<string, string[]>
  action: SymbolCheckAction
}

/* ------------------------------------------------------------------ */

const PY_KEYWORDS = new Set(
  ('False None True and as assert async await break class continue def del elif else except finally for from ' +
    'global if import in is lambda nonlocal not or pass raise return try while with yield match case print exec').split(' '),
)

const PY_BUILTINS = new Set(
  ('abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex ' +
    'copyright credits delattr dict dir divmod enumerate eval exec exit filter float format frozenset getattr ' +
    'globals hasattr hash help hex id input int isinstance issubclass iter len license list locals map max ' +
    'memoryview min next object oct open ord pow print property quit range repr reversed round set setattr slice ' +
    'sorted staticmethod str sum super tuple type vars zip __import__ __name__ __file__ __doc__ __all__ ' +
    'self cls NotImplemented Ellipsis BaseException Exception ArithmeticError AssertionError AttributeError ' +
    'BlockingIOError BrokenPipeError BufferError ChildProcessError ConnectionError EOFError EnvironmentError ' +
    'FileExistsError FileNotFoundError FloatingPointError GeneratorExit IOError ImportError IndentationError ' +
    'IndexError InterruptedError KeyError KeyboardInterrupt LookupError MemoryError ModuleNotFoundError NameError ' +
    'NotImplementedError OSError OverflowError PermissionError RecursionError ReferenceError RuntimeError ' +
    'StopAsyncIteration StopIteration SyntaxError SystemError SystemExit TabError TimeoutError TypeError ' +
    'UnboundLocalError UnicodeError ValueError Warning UserWarning DeprecationWarning ZeroDivisionError').split(' '),
)

const PY_STDLIB = new Set(
  ('abc argparse ast asyncio base64 collections contextlib copy csv dataclasses datetime decimal enum errno ' +
    'functools glob hashlib heapq html http importlib inspect io itertools json logging math mimetypes operator os ' +
    'pathlib pickle platform queue random re shutil signal socket sqlite3 ssl string struct subprocess sys tempfile ' +
    'textwrap threading time traceback types typing unittest urllib uuid warnings weakref xml zipfile').split(' '),
)

const GENERIC_KEYWORDS = new Set(
  ('if else for while do switch case default break continue return function def fn func class struct interface type ' +
    'enum new delete typeof instanceof void this super import export from as const let var async await yield try catch ' +
    'finally throw throws in of is not and or null undefined true false nil None True False self cls with match ' +
    'public private protected static final abstract extends implements package namespace using include require sizeof').split(' '),
)

const GENERIC_GLOBALS = new Set(
  ('console Math JSON Object Array String Number Boolean Date RegExp Error Promise Map Set WeakMap Symbol parseInt ' +
    'parseFloat isNaN setTimeout setInterval clearTimeout clearInterval fetch require module exports process window ' +
    'document globalThis Buffer URL Intl BigInt TypeError RangeError printf malloc free fmt len cap make append panic').split(' '),
)

/* ------------------------------------------------------------------ */
/* Lexing helpers                                                      */
/* ------------------------------------------------------------------ */

/** Blank out string contents and comments, preserving length and newlines. */
export function stripStringsAndComments(src: string, language: SymbolLanguage): string {
  const out: string[] = []
  const n = src.length
  let i = 0
  const blank = (c: string) => (c === '\n' ? '\n' : ' ')
  while (i < n) {
    const c = src[i]!
    const c2 = src.slice(i, i + 3)
    if (language === 'python' && c === '#') {
      while (i < n && src[i] !== '\n') (out.push(' '), i++)
      continue
    }
    if (language !== 'python' && c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') (out.push(' '), i++)
      continue
    }
    if (language !== 'python' && c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      for (; i < stop; i++) out.push(blank(src[i]!))
      continue
    }
    if (c === '"' || c === "'" || (language !== 'python' && c === '`')) {
      const triple = language === 'python' && (c2 === c.repeat(3))
      const q = triple ? c.repeat(3) : c
      out.push(q)
      i += q.length
      while (i < n && !src.startsWith(q, i)) {
        if (src[i] === '\\' && i + 1 < n) {
          out.push(' ', blank(src[i + 1]!))
          i += 2
          continue
        }
        if (!triple && src[i] === '\n' && c !== '`') break // unterminated single-line string
        out.push(blank(src[i]!))
        i++
      }
      if (src.startsWith(q, i)) {
        out.push(q)
        i += q.length
      }
      continue
    }
    out.push(c)
    i++
  }
  return out.join('')
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g

function identsIn(text: string): string[] {
  return text.match(IDENT) ?? []
}

/** Matching close paren index for the open paren at `open`, or -1. */
function matchParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

/* ------------------------------------------------------------------ */
/* Defined names                                                       */
/* ------------------------------------------------------------------ */

/** Names bound inside `code` (already stripped): defs, classes, params, assignments, loops, imports, as-names. */
export function definedNames(code: string, language: SymbolLanguage): Set<string> {
  const names = new Set<string>()
  const add = (s: string | undefined) => {
    if (s) names.add(s)
  }
  const addAll = (text: string) => {
    for (const m of text.matchAll(/(?<![.\w])[A-Za-z_]\w*/g)) add(m[0])
  }

  // Declarations: def/class/function/fn/func/const/let/var/type/interface/struct/enum NAME
  for (const m of code.matchAll(/\b(?:def|class|function|fn|func|const|let|var|type|interface|struct|enum|trait)\s+\*?([A-Za-z_]\w*)/g)) add(m[1])

  // Parameter lists of function-like headers.
  const headerRe =
    language === 'python'
      ? /\bdef\s+\w+\s*\(/g
      : /\b(?:function|fn|func)\s*\*?\s*[A-Za-z_]?\w*\s*\(|\b(?:def)\s+\w+\s*\(/g
  for (const m of code.matchAll(headerRe)) {
    const open = (m.index ?? 0) + m[0].length - 1
    const close = matchParen(code, open)
    if (close === -1) continue
    for (const part of splitTopLevel(code.slice(open + 1, close))) {
      // `*args`, `**kw`, `name: T = default`, `T name`, `name`
      const head = part.split('=')[0]!.split(':')[0]!
      const ids = identsIn(head)
      if (language === 'python') add(ids[0])
      else for (const id of ids) add(id) // generic: be generous (typed params in either order)
    }
  }
  // Arrow functions / lambdas.
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) for (const id of identsIn(m[1]!)) add(id)
  for (const m of code.matchAll(/\b([A-Za-z_]\w*)\s*=>/g)) add(m[1])
  for (const m of code.matchAll(/\blambda\b([^:]*):/g)) for (const part of splitTopLevel(m[1]!)) add(identsIn(part.split('=')[0]!)[0])

  // Loop targets and with/except aliases.
  for (const m of code.matchAll(/\bfor\s+\(?\s*(?:(?:const|let|var)\s+)?([\w\s,()*\[\]]+?)\s+(?:in|of)\b/g)) addAll(m[1]!)
  for (const m of code.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) add(m[1])
  for (const m of code.matchAll(/\b(?:global|nonlocal)\s+([\w\s,]+)/g)) addAll(m[1]!)
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_]\w*)/g)) add(m[1])

  // Assignments (incl. augmented, annotated, walrus, keyword args — harmless over-approximation).
  for (const m of code.matchAll(/(?<![.\w])([A-Za-z_]\w*)\s*(?::[^=\n]+)?(?::=|[-+*\/%@&|^]=|\/\/=|\*\*=|>>=|<<=|=(?!=))/g)) add(m[1])
  // Tuple unpacking at statement start: a, b = ...
  for (const m of code.matchAll(/^[ \t]*\(?([A-Za-z_*][\w\s,*()\[\]]*?)\)?\s*=(?!=)/gm)) addAll(m[1]!)

  // Imports.
  for (const m of code.matchAll(/^[ \t]*import\s+([^\n]+)/gm)) {
    for (const part of splitTopLevel(m[1]!)) {
      const [mod, alias] = part.trim().split(/\s+as\s+/)
      add(alias?.trim() ?? mod?.trim().split('.')[0])
    }
  }
  for (const m of code.matchAll(/^[ \t]*from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
    if (m[1]!.startsWith('.')) continue // relative imports are verified against the index
    const body = m[2]!.replace(/[()]/g, '')
    for (const part of splitTopLevel(body)) {
      const [name, alias] = part.trim().split(/\s+as\s+/)
      add(alias?.trim() ?? name?.trim())
    }
  }
  // JS-style imports: import { a, b as c } from '...' ; import x from '...'
  for (const m of code.matchAll(/\bimport\s+([\w$]+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\b/g)) {
    add(m[1])
    for (const part of splitTopLevel(m[2] ?? '')) {
      const [name, alias] = part.trim().split(/\s+as\s+/)
      add(alias?.trim() ?? name?.trim())
    }
  }
  return names
}

/* ------------------------------------------------------------------ */
/* References                                                          */
/* ------------------------------------------------------------------ */

interface Ref {
  name: string
}

function referencedNames(code: string, language: SymbolLanguage, original: string): Ref[] {
  const refs: Ref[] = []
  const seen = new Set<string>()
  const push = (name: string | undefined) => {
    if (name && !seen.has(name)) {
      seen.add(name)
      refs.push({ name })
    }
  }
  // Bare call: name(   (not preceded by '.', and not a def/class header)
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_]\w*)\s*\(/g)) {
    const before = code.slice(0, m.index).replace(/[ \t]+$/, '')
    if (/\b(?:def|class|function|fn|func)$/.test(before)) continue
    push(m[1])
  }
  // Attribute base: name.attr  (checks only the base; attributes on locals are ignored)
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_]\w*)\s*\.\s*[A-Za-z_]/g)) push(m[1])
  // Decorators.
  if (language === 'python') for (const m of code.matchAll(/^[ \t]*@([A-Za-z_]\w*)/gm)) push(m[1])
  // Relative imports: from .mod import name
  if (language === 'python') {
    for (const m of original.matchAll(/^[ \t]*from\s+\.[\w.]*\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
      for (const part of splitTopLevel(m[1]!.replace(/[()]/g, ''))) push(part.trim().split(/\s+as\s+/)[0]?.trim())
    }
  }
  return refs
}

/* ------------------------------------------------------------------ */

export function checkSymbols(input: SymbolCheckInput): SymbolCheckResult {
  const language = input.language ?? 'python'
  const mode = input.mode ?? 'bounceThenWarn'
  if (mode === 'off') return { unknown: [], suggestions: {}, action: 'none' }

  const newCode = stripStringsAndComments(input.newText, language)
  const oldCode = stripStringsAndComments(input.oldText, language)
  const fileCode = input.fileText ? stripStringsAndComments(input.fileText, language) : ''

  const oldTokens = new Set(identsIn(oldCode))
  const defined = definedNames(newCode, language)
  for (const n of definedNames(fileCode, language)) defined.add(n)
  for (const n of definedNames(oldCode, language)) defined.add(n)
  const known = new Set(input.extraKnown ?? [])
  const keywords = language === 'python' ? PY_KEYWORDS : GENERIC_KEYWORDS
  const builtins = language === 'python' ? PY_BUILTINS : GENERIC_GLOBALS

  const unknown: string[] = []
  // Relative-import references come from the raw text (the stripped copy keeps them too).
  for (const { name } of referencedNames(newCode, language, newCode)) {
    if (oldTokens.has(name)) continue // not introduced by this edit
    if (keywords.has(name) || builtins.has(name) || known.has(name) || defined.has(name)) continue
    if (language === 'python' && PY_STDLIB.has(name)) continue
    if (name.startsWith('__') && name.endsWith('__')) continue
    if (input.index.has(name)) continue
    unknown.push(name)
  }

  const suggestions: Record<string, string[]> = {}
  for (const name of unknown) suggestions[name] = input.index.suggest(name)

  let action: SymbolCheckAction = 'none'
  if (unknown.length > 0) {
    if (mode === 'warn') action = 'warn'
    else if (mode === 'bounce') action = 'bounce'
    else action = (input.priorBounces ?? 0) > 0 ? 'warn' : 'bounce'
  }
  return { unknown, suggestions, action }
}

/* ------------------------------------------------------------------ */
/* A simple in-memory index (also handy for tests and as a fallback)   */
/* ------------------------------------------------------------------ */

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[a.length]![b.length]!
}

export class SimpleSymbolIndex implements SymbolIndex {
  private readonly names: Set<string>
  constructor(names: Iterable<string>) {
    this.names = new Set(names)
  }
  has(name: string): boolean {
    return this.names.has(name)
  }
  suggest(name: string, max = 3): string[] {
    const limit = Math.max(2, Math.floor(name.length / 3))
    return [...this.names]
      .map((n) => ({ n, d: editDistance(n.toLowerCase(), name.toLowerCase()), under: n.replace(/_/g, '') === name.replace(/_/g, '') }))
      .filter((x) => x.d <= limit || x.under)
      .sort((a, b) => a.d - b.d)
      .slice(0, max)
      .map((x) => x.n)
  }
}
