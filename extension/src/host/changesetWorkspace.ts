// mcp Workspace whose reads go through the changeset overlay, so the agent sees its own staged edits.
import { NodeWorkspace } from '../mcp';
import type { ChangesetStore } from '../changeset';

export class ChangesetWorkspace extends NodeWorkspace {
  constructor(
    root: string,
    private readonly getChangeset: () => ChangesetStore | undefined,
  ) {
    super(root);
  }

  /** Rebuild the base class overlay map from the live changeset. */
  private sync(): void {
    this.overlay.clear();
    const cs = this.getChangeset();
    if (!cs) return;
    for (const f of cs.files()) this.overlay.set(f.path, f.proposed);
  }

  override async readFile(rel: string): Promise<string | undefined> {
    this.sync();
    if (this.overlay.has(rel)) return this.overlay.get(rel) ?? undefined;
    const cs = this.getChangeset();
    if (cs) {
      try {
        return (await cs.read(rel)) ?? undefined;
      } catch {
        return undefined;
      }
    }
    return super.readFile(rel);
  }

  override listDir(rel: string) {
    this.sync();
    return super.listDir(rel);
  }

  override exists(rel: string) {
    this.sync();
    return super.exists(rel);
  }

  override walk(opts?: Parameters<NodeWorkspace['walk']>[0]) {
    this.sync();
    return super.walk(opts);
  }

  override dirtyPaths(): string[] {
    this.sync();
    return super.dirtyPaths();
  }
}
