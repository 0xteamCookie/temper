// Editor side of the review: multi-file diff (agent mode) or in-place inline diff (inline mode).
import * as vscode from 'vscode';
import { InlineDiffSession } from '../inline';
import { PROPOSED_SCHEME, ReviewController } from '../review';
import type { FileChange } from '../shared/types';
import type { ReviewHandlers, ReviewPresentation } from './runController';

function isTemperTab(tab: vscode.Tab): boolean {
  const input = tab.input as { modified?: vscode.Uri; textDiffs?: { modified?: vscode.Uri }[] } | undefined;
  if (!input) return false;
  if (input.modified?.scheme === PROPOSED_SCHEME) return true;
  return !!input.textDiffs?.some((d) => d.modified?.scheme === PROPOSED_SCHEME);
}

export class EditorReview implements vscode.Disposable {
  private readonly agentReview: ReviewController;
  private handlers: ReviewHandlers | undefined;
  private inline: { session: InlineDiffSession; path: string } | undefined;
  private lastOpenedAgentReview = false;

  constructor(root: vscode.Uri | undefined) {
    this.agentReview = new ReviewController(
      {
        onDecide: (id, d) => this.handlers?.onDecide(id, d),
        onDecideAll: (d) => this.handlers?.onDecideAll(d),
        onSubmit: (r) => this.handlers?.onSubmit(r),
        onCancel: () => this.handlers?.onCancel(),
      },
      { root },
    );
  }

  /** Diff of one file from the webview ("Open diff"). */
  openDiff(path: string): void {
    void this.agentReview.openDiff(path);
  }

  async open(p: ReviewPresentation, root: vscode.Uri | undefined): Promise<void> {
    this.handlers = p.handlers;
    if (p.mode === 'inline') return this.openInline(p, root);
    this.lastOpenedAgentReview = true;
    await this.agentReview.open(p.runId, p.files);
  }

  private async openInline(p: ReviewPresentation, root: vscode.Uri | undefined): Promise<void> {
    const path = p.scope && p.scope.kind === 'selection' ? p.scope.path : p.files[0]?.path;
    const change = p.files.find((f) => f.path === path) ?? p.files[0];
    if (!change || !root) return;
    const uri = vscode.Uri.joinPath(root, ...change.path.split('/'));
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const handlers = p.handlers;
    this.inline?.session.dispose();
    const session = new InlineDiffSession(
      editor,
      change,
      {
        onDecide: (id, d) => handlers.onDecide(id, d),
        onComplete: () => {
          this.inline = undefined;
          handlers.onSubmit();
        },
        onCancel: () => {
          this.inline = undefined;
          handlers.onCancel();
        },
      },
      { runId: p.runId },
    );
    this.inline = { session, path: change.path };
  }

  update(files: FileChange[]): void {
    this.agentReview.updateDecisions(files);
    const inline = this.inline;
    if (inline) {
      const change = files.find((f) => f.path === inline.path);
      if (change) inline.session.update(change, { syncDecisions: true });
    }
  }

  close(): void {
    const inline = this.inline;
    this.inline = undefined;
    inline?.session.dispose();
    this.handlers = undefined;
    if (this.lastOpenedAgentReview) {
      this.lastOpenedAgentReview = false;
      this.agentReview.close();
      this.closeReviewTabs();
    }
  }

  private closeReviewTabs(): void {
    try {
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isTemperTab);
      if (tabs.length) void vscode.window.tabGroups.close(tabs);
    } catch {
      /* tab API unavailable: leave the tabs */
    }
  }

  dispose(): void {
    this.close();
    this.agentReview.dispose();
  }
}
