import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChangesetStore, MemoryFileSystem, NodeFileSystem, type FileSystemPort } from '../../src/changeset'

const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)
const text = (arr: string[]) => arr.join('\n') + '\n'

describe('ChangesetStore', () => {
  it('stages without touching the filesystem and accumulates edits', async () => {
    const fs = new MemoryFileSystem({ 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'x\n' })
    const store = new ChangesetStore(fs)
    const r1 = await store.stage('a.txt', 'one', 'ONE', 'first')
    const r2 = await store.stage('./a.txt', 'three', 'THREE', 'second')
    const r3 = await store.stage('b.txt', 'x', 'y')
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, true, true])
    expect(r1.message).toContain('-one')
    expect(r1.message).toContain('+ONE')
    expect(fs.files.get('a.txt')).toBe('one\ntwo\nthree\n')
    expect(await store.read('a.txt')).toBe('ONE\ntwo\nTHREE\n')
    expect(await store.read('missing.txt')).toBeNull()
    const files = store.files()
    expect(files.map((f) => f.path)).toEqual(['a.txt', 'b.txt'])
    expect(files[0]!.hunks[0]!.id).toBe('a.txt#0')
    expect(files[0]!.hunks[0]!.rationale).toBe('first\nsecond')
    expect(store.isEmpty()).toBe(false)
  })

  it('returns actionable errors', async () => {
    const store = new ChangesetStore(new MemoryFileSystem({ 'a.txt': 'hello\n' }))
    const r = await store.stage('a.txt', 'nothere', 'x')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not found/)
    const r2 = await store.stage('nofile.txt', 'a', 'b')
    expect(r2.ok).toBe(false)
    expect(r2.message).toMatch(/does not exist/)
    expect(store.isEmpty()).toBe(true)
  })

  it('per-hunk accept/reject yields exact content', async () => {
    const original = text(lines(30))
    const fs = new MemoryFileSystem({ 'f.txt': original })
    const store = new ChangesetStore(fs)
    await store.stage('f.txt', 'line2\n', 'line2\ninserted-early\n')
    await store.stage('f.txt', 'line15\nline16', 'CHANGED15\nCHANGED16')
    await store.stage('f.txt', 'line29\n', '')
    const hunks = store.files()[0]!.hunks
    expect(hunks).toHaveLength(3)
    store.setDecision(hunks[0]!.id, 'accept')
    store.setDecision(hunks[1]!.id, 'reject')
    store.setDecision(hunks[2]!.id, 'accept')
    const cp = await store.applyAccepted('test')
    const expected = text(lines(30)).replace('line2\n', 'line2\ninserted-early\n').replace('line29\n', '')
    expect(fs.files.get('f.txt')).toBe(expected)
    expect(cp.appliedHunks).toBe(2)
    expect(cp.rejectedHunks).toBe(1)
    expect(store.isEmpty()).toBe(true)
  })

  it('pending hunks are not applied; accept-all equals proposed', async () => {
    const fs = new MemoryFileSystem({ 'f.txt': 'a\nb\nc\n' })
    const store = new ChangesetStore(fs)
    await store.stage('f.txt', 'b', 'B')
    const cp0 = await store.applyAccepted('nothing')
    expect(cp0.appliedHunks).toBe(0)
    expect(fs.files.get('f.txt')).toBe('a\nb\nc\n')
    await store.stage('f.txt', 'b', 'B')
    store.setAll('accept')
    await store.applyAccepted('all')
    expect(fs.files.get('f.txt')).toBe('a\nB\nc\n')
  })

  it('handles files without trailing newline and CRLF partial accepts', async () => {
    const orig = text(lines(20)).replace(/\n/g, '\r\n').replace(/\r\n$/, '')
    const fs = new MemoryFileSystem({ 'w.txt': orig })
    const store = new ChangesetStore(fs)
    await store.stage('w.txt', 'line1\n', 'FIRST\n')
    await store.stage('w.txt', 'line20', 'LAST')
    const hunks = store.files()[0]!.hunks
    expect(hunks).toHaveLength(2)
    store.setDecision(hunks[1]!.id, 'accept')
    await store.applyAccepted('crlf')
    expect(fs.files.get('w.txt')).toBe(orig.replace('line20', 'LAST'))
  })

  it('creates files; undo deletes them', async () => {
    const fs = new MemoryFileSystem()
    const store = new ChangesetStore(fs)
    const r = await store.createFile('pkg/new.py', 'print(1)\n', 'why')
    expect(r.ok).toBe(true)
    expect(store.files()[0]!.kind).toBe('create')
    expect(await store.read('pkg/new.py')).toBe('print(1)\n')
    store.setAll('accept')
    const cp = await store.applyAccepted('create')
    expect(fs.files.get('pkg/new.py')).toBe('print(1)\n')
    expect(cp.originals['pkg/new.py']).toBeNull()
    expect(await store.undo(cp.id)).toBe(true)
    expect(fs.files.has('pkg/new.py')).toBe(false)
    expect(await store.undo(cp.id)).toBe(false)
  })

  it('stage with empty oldString creates a missing file and rejects existing ones', async () => {
    const store = new ChangesetStore(new MemoryFileSystem({ 'e.txt': 'x' }))
    expect((await store.stage('n.txt', '', 'hi\n')).ok).toBe(true)
    expect((await store.stage('e.txt', '', 'hi\n')).ok).toBe(false)
    expect((await store.createFile('e.txt', 'z')).ok).toBe(false)
  })

  it('undo restores byte-identical originals (real fs, CRLF, multi-file)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'temper-cs-'))
    try {
      mkdirSync(join(root, 'src'))
      const a = Buffer.from('alpha\r\nbeta\r\n\u00e9\r\n', 'utf8')
      writeFileSync(join(root, 'src', 'a.txt'), a)
      writeFileSync(join(root, 'b.txt'), 'b1\nb2')
      const store = new ChangesetStore(new NodeFileSystem(root))
      await store.stage('src/a.txt', 'beta', 'BETA')
      await store.stage('b.txt', 'b2', 'b2\nb3')
      await store.createFile('src/c.txt', 'new')
      store.setAll('accept')
      const cp = await store.applyAccepted('real')
      expect(readFileSync(join(root, 'src', 'a.txt'), 'utf8')).toBe('alpha\r\nBETA\r\n\u00e9\r\n')
      expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b1\nb2\nb3')
      expect(readFileSync(join(root, 'src', 'c.txt'), 'utf8')).toBe('new')
      await store.undo(cp.id)
      expect(readFileSync(join(root, 'src', 'a.txt')).equals(a)).toBe(true)
      expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b1\nb2')
      expect(existsSync(join(root, 'src', 'c.txt'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rolls back already-written files when a write fails', async () => {
    const mem = new MemoryFileSystem({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
    let writes = 0
    const flaky: FileSystemPort = {
      read: (p) => mem.read(p),
      delete: (p) => mem.delete(p),
      write: async (p, c) => {
        writes++
        if (p === 'b.txt') throw new Error('disk full')
        await mem.write(p, c)
      },
    }
    const store = new ChangesetStore(flaky)
    await store.stage('a.txt', 'a', 'A')
    await store.stage('b.txt', 'b', 'B')
    await store.createFile('c.txt', 'c')
    store.setAll('accept')
    await expect(store.applyAccepted('x')).rejects.toThrow(/rolled back/)
    expect(mem.files.get('a.txt')).toBe('a\n')
    expect(mem.files.get('b.txt')).toBe('b\n')
    expect(mem.files.has('c.txt')).toBe(false)
    expect(writes).toBeGreaterThanOrEqual(3 - 1)
    // the overlay is retained so the user can retry
    expect(store.isEmpty()).toBe(false)
  })

  it('rejects paths that escape the workspace', async () => {
    const store = new ChangesetStore(new MemoryFileSystem())
    for (const p of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:\\Windows\\x', '..\\x']) {
      const r = await store.createFile(p, 'x')
      expect(r.ok, p).toBe(false)
      expect(r.message).toMatch(/workspace/)
    }
    expect((await store.stage('../x', 'a', 'b')).ok).toBe(false)
    expect((await store.createFile('a/../b.txt', 'ok')).path).toBe('b.txt')
  })

  it('discard clears and emits change events', async () => {
    const store = new ChangesetStore(new MemoryFileSystem({ 'a': 'x' }))
    let n = 0
    const d = store.onDidChange(() => n++)
    await store.stage('a', 'x', 'y')
    store.discard()
    expect(store.isEmpty()).toBe(true)
    expect(n).toBe(2)
    d.dispose()
    store.discard()
    expect(n).toBe(2)
  })
})
