import { describe, expect, it } from 'vitest'
import { SimpleSymbolIndex, checkSymbols } from '../../src/guards'

const index = new SimpleSymbolIndex(['get_debug_flag', 'get_env', 'Flask', 'current_app', 'jsonify', 'request'])

const oldText = `def create_app():
    app = Flask(__name__)
    return app
`

describe('symbol check (python)', () => {
  it('accepts a call to an indexed symbol', () => {
    const newText = `def create_app():
    app = Flask(__name__)
    app.debug = get_debug_flag()
    return app
`
    const r = checkSymbols({ oldText, newText, index })
    expect(r.unknown).toEqual([])
    expect(r.action).toBe('none')
  })

  it('flags a misspelled symbol with a suggestion', () => {
    const newText = `def create_app():
    app = Flask(__name__)
    app.debug = get_debugflag()
    return app
`
    const r = checkSymbols({ oldText, newText, index })
    expect(r.unknown).toEqual(['get_debugflag'])
    expect(r.suggestions['get_debugflag']).toContain('get_debug_flag')
    expect(r.action).toBe('bounce')
  })

  it('bounceThenWarn downgrades after a bounce; other modes', () => {
    const newText = 'x = nope()\n'
    expect(checkSymbols({ oldText: '', newText, index, mode: 'bounceThenWarn', priorBounces: 1 }).action).toBe('warn')
    expect(checkSymbols({ oldText: '', newText, index, mode: 'bounce', priorBounces: 3 }).action).toBe('bounce')
    expect(checkSymbols({ oldText: '', newText, index, mode: 'warn' }).action).toBe('warn')
    expect(checkSymbols({ oldText: '', newText, index, mode: 'off' }).unknown).toEqual([])
  })

  it('ignores builtins, stdlib, locals, params, strings, comments and attributes on locals', () => {
    const newText = `import os
from collections import OrderedDict

def helper(a, b=2, *rest, **kw):
    # call undefined_in_comment() here
    msg = "also undefined_in_string() and fake.attr"
    total = len(rest) + sum([1, 2])
    d = OrderedDict()
    d.update(kw)
    path = os.path.join("a", msg)
    result = [inner(x) for x in rest if x]
    with open(path) as fh:
        data = fh.read()
    items = sorted(data, key=lambda k: k.lower())
    try:
        pass
    except ValueError as err:
        print(err.args)
    return total, items, result, a.strip()

def inner(v):
    return v
`
    const r = checkSymbols({ oldText: '', newText, index })
    expect(r.unknown).toEqual([])
  })

  it('does not report names already present in the old text or file', () => {
    const r = checkSymbols({
      oldText: 'x = legacy_call()\n',
      newText: 'x = legacy_call()\ny = legacy_call()\n',
      index,
    })
    expect(r.unknown).toEqual([])
    const r2 = checkSymbols({
      oldText: 'a = 1\n',
      newText: 'a = helper_from_top()\n',
      index,
      fileText: 'from util import helper_from_top\n\na = 1\n',
    })
    expect(r2.unknown).toEqual([])
  })

  it('flags unknown attribute bases and relative imports', () => {
    const r = checkSymbols({
      oldText: '',
      newText: 'from .helpers import get_debugflag, get_env\nvalue = mystery.thing\n',
      index,
    })
    expect(r.unknown.sort()).toEqual(['get_debugflag', 'mystery'])
  })
})

describe('symbol check (generic)', () => {
  it('flags unknown calls and ignores declarations, params and globals', () => {
    const newText = `function go(a, b) {
  const local = a + b
  console.log(helper(local))
  return missing(a) // trailing undefinedCall()
}
`
    const r = checkSymbols({ oldText: '', newText, index: new SimpleSymbolIndex(['helper']), language: 'generic' })
    expect(r.unknown).toEqual(['missing'])
  })
})
