// File-system seam for the changeset. The extension host supplies a WorkspaceEdit-backed
// adapter; tests use NodeFileSystem / MemoryFileSystem. Paths are workspace-relative, forward-slash.
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'

export interface FileSystemPort {
  /** File text, or null when the file does not exist. */
  read(relPath: string): Promise<string | null>
  write(relPath: string, content: string): Promise<void>
  delete(relPath: string): Promise<void>
}

export class NodeFileSystem implements FileSystemPort {
  constructor(private readonly root: string) {}
  private abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'))
  }
  async read(rel: string): Promise<string | null> {
    try {
      return await fsp.readFile(this.abs(rel), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }
  async write(rel: string, content: string): Promise<void> {
    const p = this.abs(rel)
    await fsp.mkdir(path.dirname(p), { recursive: true })
    await fsp.writeFile(p, content, 'utf8')
  }
  async delete(rel: string): Promise<void> {
    await fsp.rm(this.abs(rel), { force: true })
  }
}

export class MemoryFileSystem implements FileSystemPort {
  readonly files = new Map<string, string>()
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.files.set(k, v)
  }
  async read(rel: string): Promise<string | null> {
    return this.files.get(rel) ?? null
  }
  async write(rel: string, content: string): Promise<void> {
    this.files.set(rel, content)
  }
  async delete(rel: string): Promise<void> {
    this.files.delete(rel)
  }
}
