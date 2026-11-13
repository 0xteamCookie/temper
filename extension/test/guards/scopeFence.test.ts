import { describe, expect, it } from 'vitest'
import { ChangesetStore, MemoryFileSystem } from '../../src/changeset'
import { applyScopeFence, applyScopeFenceToStore } from '../../src/guards'

const content = Array.from({ length: 60 }, (_, i) => `line${i + 1}`).join('\n') + '\n'

async function setup() {
  const store = new ChangesetStore(new MemoryFileSystem({ 'a.py': content, 'b.py': 'x\n' }))
  await store.stage('a.py', 'line10', 'EDITED10')
  await store.stage('a.py', 'line50', 'EDITED50')
  await store.stage('b.py', 'x', 'y')
  return store
}

describe('scope fence', () => {
  it('flags and rejects hunks outside a selection', async () => {
    const store = await setup()
    const hunks = store.files().flatMap((f) => f.hunks)
    const res = applyScopeFence(hunks, { kind: 'selection', path: 'a.py', startLine: 8, endLine: 12 }, 'flagAndReject')
    expect(res.flagged.map((h) => h.id).sort()).toEqual(['a.py#1', 'b.py#0'])
    const byId = Object.fromEntries(hunks.map((h) => [h.id, h]))
    expect(byId['a.py#0']!.decision).toBe('pending')
    expect(byId['a.py#0']!.flags).toEqual([])
    expect(byId['a.py#1']!.decision).toBe('reject')
    expect(byId['a.py#1']!.flags[0]!.kind).toBe('outsideSelection')
    expect(byId['b.py#0']!.flags[0]!.kind).toBe('outsideSelection')
  })

  it('warn only flags; off does nothing; block drops from the store', async () => {
    const store = await setup()
    const sel = { kind: 'selection', path: 'a.py', startLine: 8, endLine: 12 } as const
    const hunks = store.files().flatMap((f) => f.hunks)
    applyScopeFence(hunks, sel, 'warn')
    expect(hunks.filter((h) => h.flags.length).length).toBe(2)
    expect(hunks.every((h) => h.decision === 'pending')).toBe(true)

    const store2 = await setup()
    const off = applyScopeFence(store2.files().flatMap((f) => f.hunks), sel, 'off')
    expect(off.flagged).toEqual([])

    const store3 = await setup()
    const res = applyScopeFenceToStore(store3, sel, 'block')
    expect(res.dropped).toHaveLength(2)
    expect(store3.files().flatMap((f) => f.hunks).map((h) => h.id)).toEqual(['a.py#0'])
    store3.setAll('accept')
    const mem = new MemoryFileSystem()
    expect(mem.files.size).toBe(0)
  })

  it('plan scope flags files outside the plan', async () => {
    const store = await setup()
    const hunks = store.files().flatMap((f) => f.hunks)
    applyScopeFence(hunks, { kind: 'plan', paths: ['a.py'] }, 'flagAndReject')
    const b = hunks.find((h) => h.path === 'b.py')!
    expect(b.flags[0]!.kind).toBe('outsidePlan')
    expect(b.decision).toBe('reject')
    expect(hunks.filter((h) => h.path === 'a.py').every((h) => h.flags.length === 0)).toBe(true)
  })

  it('allows pure insertions at selection edges', async () => {
    const store = new ChangesetStore(new MemoryFileSystem({ 'a.py': content }))
    await store.stage('a.py', 'line13\n', 'line13\nnew\n')
    const hunks = store.files().flatMap((f) => f.hunks)
    const res = applyScopeFence(hunks, { kind: 'selection', path: 'a.py', startLine: 10, endLine: 13 }, 'warn')
    expect(res.flagged).toHaveLength(0)
  })

  it('dropped hunks are never applied', async () => {
    const mem = new MemoryFileSystem({ 'a.py': content, 'b.py': 'x\n' })
    const store = new ChangesetStore(mem)
    await store.stage('a.py', 'line10', 'EDITED10')
    await store.stage('b.py', 'x', 'y')
    applyScopeFenceToStore(store, { kind: 'plan', paths: ['a.py'] }, 'block')
    store.setAll('accept')
    await store.applyAccepted('x')
    expect(mem.files.get('b.py')).toBe('x\n')
    expect(mem.files.get('a.py')).toContain('EDITED10')
  })
})
