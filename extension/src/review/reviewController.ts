// Multi-file review: per-file side-by-side diffs over virtual documents, with per-hunk decisions
// mirrored between the webview panel and an in-editor InlineDiffSession.
// openMultiFileDiff pattern from Cline (Apache-2.0, cline/cline @ 72b3d7140553a733242126e51a7c2e87efe75c64), modified by Temper
// authors: plain args instead of gRPC types, falls back to sequential vscode.diff.
import * as vscode from 'vscode';
import { InlineDiffSession } from '../inline/inlineDiff';
import type { FileChange, HunkDecision } from '../shared/types';
import { contentForDecisions } from './effectiveContent';
import { ProposedContentProvider, proposedContent } from './proposedContentProvider';

export interface ReviewHandlers {
  onDecide(hunkId: string, decision: HunkDecision): void;
  onDecideAll(decision: HunkDecision, path?: string): void;
  onSubmit(reason?: string): void;
  onCancel(): void;
}

export interface ReviewControllerOptions {
  /** Workspace root used to resolve change.path; defaults to the first workspace folder. */
  root?: vscode.Uri;
}

export class ReviewController implements vscode.Disposable {
  private runId: string | undefined;
  private changes: FileChange[] = [];
  private readonly sessions = new Map<string, InlineDiffSession>();

  constructor(
    private readonly handlers: ReviewHandlers,
    private readonly options: ReviewControllerOptions = {},
  ) {}

  get isOpen(): boolean {
    return this.runId !== undefined;
  }

  private fileUri(path: string): vscode.Uri {
    const root = this.options.root ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    return root ? vscode.Uri.joinPath(root, path) : vscode.Uri.file(path);
  }

  private decisionMap(c: FileChange): Record<string, HunkDecision> {
    return Object.fromEntries(c.hunks.map((h) => [h.id, h.decision]));
  }

  private pushContent(c: FileChange): void {
    if (!this.runId) return;
    // Right side previews: accepted + pending applied, rejected hunks reverted.
    const preview = c.hunks.length ? contentForDecisions(c, this.decisionMap(c), { pendingAs: 'accept' }) : c.proposed;
    proposedContent.update(this.runId, c.path, c.original, preview);
  }

  /** Open one multi-file diff (vscode.changes) with every file's original vs proposed. */
  async open(runId: string, changes: FileChange[]): Promise<void> {
    if (this.runId && this.runId !== runId) this.close();
    this.runId = runId;
    this.changes = changes;
    changes.forEach((c) => this.pushContent(c));
    if (changes.length === 0) return;
    const title = `Temper: review ${changes.length} file${changes.length === 1 ? '' : 's'}`;
    const resources = changes.map(
      (c) =>
        [
          this.fileUri(c.path),
          ProposedContentProvider.originalUri(runId, c.path),
          ProposedContentProvider.proposedUri(runId, c.path),
        ] as [vscode.Uri, vscode.Uri, vscode.Uri],
    );
    try {
      const cmds = await vscode.commands.getCommands(true);
      if (!cmds.includes('vscode.changes')) throw new Error('vscode.changes unavailable');
      await vscode.commands.executeCommand('vscode.changes', title, resources);
    } catch {
      for (const c of changes) await this.openDiff(c.path, { preserveFocus: true, preview: false });
    }
  }

  /** Refresh after decisions changed elsewhere (webview): updates diffs and any mirrored editor. */
  updateDecisions(changes: FileChange[]): void {
    this.changes = changes;
    for (const c of changes) {
      this.pushContent(c);
      this.sessions.get(c.path)?.update(c, { syncDecisions: true });
    }
  }

  /** Single-file side-by-side diff. */
  async openDiff(path: string, opts: { preserveFocus?: boolean; preview?: boolean } = {}): Promise<void> {
    const c = this.changes.find((x) => x.path === path);
    if (!c || !this.runId) return;
    this.pushContent(c);
    await vscode.commands.executeCommand(
      'vscode.diff',
      ProposedContentProvider.originalUri(this.runId, c.path),
      ProposedContentProvider.proposedUri(this.runId, c.path),
      `Temper: ${c.path} (original ↔ proposed)`,
      { preserveFocus: opts.preserveFocus, preview: opts.preview ?? true },
    );
  }

  /**
   * Open the real file and show its hunks in place (red/green + CodeLens). Decisions made there are
   * forwarded to onDecide, and updateDecisions() keeps the editor in sync with the webview.
   * New files (kind 'create') have no editor to decorate; they fall back to openDiff.
   */
  async openInEditor(path: string): Promise<void> {
    const c = this.changes.find((x) => x.path === path);
    if (!c) return;
    if (c.kind === 'create') return this.openDiff(path);
    const doc = await vscode.workspace.openTextDocument(this.fileUri(path));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    this.sessions.get(path)?.dispose();
    const drop = () => void this.sessions.delete(path);
    const session = new InlineDiffSession(
      editor,
      c,
      {
        onDecide: (id, d) => this.handlers.onDecide(id, d),
        onComplete: drop,
        onCancel: drop,
      },
      { completeWhenDecided: false, rejectOutsideSelectionByDefault: false, runId: this.runId },
    );
    this.sessions.set(path, session);
  }

  /** Command handlers the integrator can bind (e.g. temper.review.openDiff, .submit, .cancel). */
  readonly commands = {
    openDiff: (path: string) => this.openDiff(path),
    openInEditor: (path: string) => this.openInEditor(path),
    acceptAll: (path?: string) => this.handlers.onDecideAll('accept', path),
    rejectAll: (path?: string) => this.handlers.onDecideAll('reject', path),
    submit: (reason?: string) => this.handlers.onSubmit(reason),
    cancel: () => this.handlers.onCancel(),
  };

  close(): void {
    this.sessions.forEach((s) => s.dispose());
    this.sessions.clear();
    if (this.runId) proposedContent.clear(this.runId);
    this.runId = undefined;
    this.changes = [];
  }

  dispose(): void {
    this.close();
  }
}
