import { describe, expect, it } from 'vitest'
import { replace } from '../../src/changeset/fuzzyEdit'

function ok(r: ReturnType<typeof replace>) {
  if (!r.ok) throw new Error(r.message)
  return r
}

describe('fuzzy replace', () => {
  it('exact match', () => {
    const r = ok(replace('a = 1\nb = 2\n', 'b = 2', 'b = 3'))
    expect(r.content).toBe('a = 1\nb = 3\n')
    expect(r.strategy).toBe('exact')
  })

  it('tolerates indentation drift', () => {
    const file = 'def f():\n    if x:\n        return 1\n    return 2\n'
    const r = ok(replace(file, 'if x:\n    return 1', '        if x:\n            return 10'))
    expect(r.strategy).not.toBe('exact')
    expect(r.content).toContain('return 10')
    expect(r.content.startsWith('def f():\n')).toBe(true)
  })

  it('tolerates trailing whitespace differences (line-trimmed)', () => {
    const file = 'x = 1   \ny = 2\nz = 3\n'
    const r = ok(replace(file, 'x = 1\ny = 2', 'x = 10\ny = 20'))
    expect(r.strategy).toBe('line-trimmed')
    expect(r.content).toBe('x = 10\ny = 20\nz = 3\n')
  })

  it('preserves CRLF line endings', () => {
    const file = 'one\r\ntwo\r\nthree\r\n'
    const r = ok(replace(file, 'two\nthree', 'TWO\nTHREE\nFOUR'))
    expect(r.content).toBe('one\r\nTWO\r\nTHREE\r\nFOUR\r\n')
  })

  it('matches CRLF file with LF oldString and CRLF oldString alike', () => {
    const file = 'a\r\nb\r\n'
    expect(ok(replace(file, 'a\r\nb', 'c')).content).toBe('c\r\n')
  })

  it('rejects ambiguous matches with an actionable message', () => {
    const r = replace('foo()\nbar()\nfoo()\n', 'foo()', 'baz()')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('ambiguous')
      expect(r.message).toMatch(/more surrounding lines/i)
    }
  })

  it('replaceAll replaces every occurrence', () => {
    expect(ok(replace('foo()\nbar()\nfoo()\n', 'foo()', 'baz()', true)).content).toBe('baz()\nbar()\nbaz()\n')
  })

  it('not found yields a hint with the nearest lines', () => {
    const r = replace('def get_debug_flag():\n    return 1\n', 'def get_debug_flagg():', 'x')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('notFound')
      expect(r.message).toContain('Closest lines')
      expect(r.message).toContain('1: def get_debug_flag():')
    }
  })

  it('empty oldString creates only on empty content', () => {
    expect(ok(replace('', '', 'hello\n')).content).toBe('hello\n')
    const r = replace('x', '', 'y')
    expect(r.ok).toBe(false)
  })

  it('rejects identical old/new', () => {
    const r = replace('a', 'a', 'a')
    expect(r.ok).toBe(false)
  })

  it('does not interpret $ patterns in replacement text', () => {
    expect(ok(replace('a b', 'a', "$&$'")).content).toBe("$&$' b")
    expect(ok(replace('a a', 'a', '$&', true)).content).toBe('$& $&')
  })
})
