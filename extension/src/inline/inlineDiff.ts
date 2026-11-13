// In-editor review of one FileChange.
//
// Rendering (pattern after Continue's vertical diff, Apache-2.0, continuedev/continue @ 5522c6f,
// modified by Temper authors): while the review is open, each hunk's added lines are inserted into the
// editor BUFFER directly below its removed lines. Removed lines get a red whole-line background and a
// "-" gutter mark, inserted lines a green one and a "+" mark; CodeLens above each hunk decides it.
//
// Safety contract for the temporary buffer text:
//  - it is NEVER saved. A save while it is present is intercepted (the lines are stripped in
//    onWillSave) and the session is cancelled;
//  - decisions only change decorations, never the buffer, while the review is in progress;
//  - on complete / cancel / dispose the inserted lines are deleted again in ONE WorkspaceEdit, the
//    document is reverted to its on-disk state if it is then identical, and only THEN do the
//    callbacks run (the host applies accepted hunks through changeset.applyAccepted);
//  - if the user edits a hunk region the session is cancelled; edits elsewhere are tracked;
//  - if auto-save is on (or the file is dirty / not a plain file) the buffer is not touched at all:
//    a side-by-side vscode.diff opens instead, with the same per-hunk CodeLens on the proposed side.
import * as vscode from 'vscode';
import type { FileChange, HunkDecision } from '../shared/types';
import { proposedContent, ProposedContentProvider } from '../review/proposedContentProvider';
import { contentForDecisions } from '../review/effectiveContent';
import {
  bufferDecorations,
  chooseDisplayMode,
  displayLayouts,
  planBuffer,
  proposedSideLayouts,
  restoreRanges,
  shiftBlocks,
  toRanges,
} from './bufferPlan';
import type { BufferBlock } from './bufferPlan';
import { hunkAtLine, layoutHunks } from './hunkLayout';
import type { HunkLayout } from './hunkLayout';
import { buildLenses } from './lensModel';
import type { LensSpec } from './lensModel';
import { refreshLenses, registerSession, unregisterSession } from './sessionRegistry';
import type { InlineSessionHandle } from './sessionRegistry';

export interface InlineDiffCallbacks {
  /** Every individual decision made in the editor (not fired for decisions pushed in via update()). */
  onDecide?(hunkId: string, decision: HunkDecision): void;
  /** All hunks decided, or Accept All / Reject All. The session is disposed and the buffer restored. */
  onComplete(decisions: Record<string, HunkDecision>): void;
  /** Escape, superseded, or the document was edited underneath the diff. Session disposed, buffer restored. */
  onCancel(): void;
}

export interface InlineDiffOptions {
  /** Added to hunk line numbers when change.original is a slice of the document (0-based start line). */
  lineOffset?: number;
  /** Default true: hunks flagged outsideSelection start out rejected. */
  rejectOutsideSelectionByDefault?: boolean;
  /** Default true. Set false to leave submission to an outer flow (agent-mode mirror). */
  completeWhenDecided?: boolean;
  /** Default false: set true while hunks are still streaming in; call finish() after. */
  streaming?: boolean;
  /** Used for the side-by-side diff; defaults to 'inline'. */
  runId?: string;
}

const RED = 'rgba(255, 70, 70, 0.28)';
const GREEN = 'rgba(60, 200, 90, 0.26)';

function gutter(sign: '+' | '-', color: string): vscode.Uri {
  const mark = sign === '+' ? 'M4 8h8M8 4v8' : 'M4 8h8';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="${mark}" stroke="${color}" stroke-width="2" fill="none"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function lineType(opts: vscode.DecorationRenderOptions): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({ isWholeLine: true, ...opts });
}

/** Pending-save / write ordering: restores still running per document, awaited by a successor session. */
const pendingRestores = new Map<string, Promise<void>>();

type Mode = 'buffer' | 'diff';

export class InlineDiffSession implements InlineSessionHandle, vscode.Disposable {
  readonly uri: string;
  private readonly docUri: string;
  private readonly mode: Mode;
  private change: FileChange;
  private layouts: HunkLayout[] = [];
  private blocks: BufferBlock[] = [];
  private decisions: Record<string, HunkDecision> = {};
  private disposed = false;
  private inserted = false;
  private busy = false;
  private savePending = false;
  private diffShown = false;
  private streaming: boolean;
  private readonly lineOffset: number;
  private readonly opts: InlineDiffOptions;
  private readonly subs: vscode.Disposable[] = [];
  /** Serializes every buffer operation (insert, re-plan, restore). */
  private queue: Promise<void> = Promise.resolve();
  private restoreDone: Promise<void> = Promise.resolve();

  private readonly removedPending = lineType({
    backgroundColor: RED,
    overviewRulerColor: 'rgba(255,70,70,0.8)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    gutterIconPath: gutter('-', '#f85149'),
    gutterIconSize: 'contain',
  });
  private readonly removedAccepted = lineType({ backgroundColor: 'rgba(128,128,128,0.10)', opacity: '0.45', textDecoration: 'line-through' });
  private readonly removedRejected = lineType({
    backgroundColor: 'rgba(255,70,70,0.12)',
    gutterIconPath: gutter('-', '#f85149'),
    gutterIconSize: 'contain',
  });
  private readonly addedPending = lineType({
    backgroundColor: GREEN,
    overviewRulerColor: 'rgba(60,200,90,0.8)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    gutterIconPath: gutter('+', '#3fb950'),
    gutterIconSize: 'contain',
  });
  private readonly addedAccepted = lineType({
    backgroundColor: 'rgba(60,200,90,0.14)',
    gutterIconPath: gutter('+', '#3fb950'),
    gutterIconSize: 'contain',
  });
  private readonly addedRejected = lineType({ backgroundColor: 'rgba(128,128,128,0.10)', opacity: '0.45', textDecoration: 'line-through' });

  constructor(
    private readonly editor: vscode.TextEditor,
    change: FileChange,
    private readonly callbacks: InlineDiffCallbacks,
    options: InlineDiffOptions = {},
  ) {
    this.opts = options;
    this.change = change;
    this.docUri = editor.document.uri.toString();
    this.lineOffset = options.lineOffset ?? 0;
    this.streaming = options.streaming ?? false;

    const choice = chooseDisplayMode({
      autoSave: vscode.workspace.getConfiguration('files', editor.document.uri).get<string>('autoSave'),
      isDirty: editor.document.isDirty,
      scheme: editor.document.uri.scheme,
    });
    this.mode = choice.mode;
    this.uri =
      this.mode === 'diff' ? ProposedContentProvider.proposedUri(options.runId ?? 'inline', change.path).toString() : this.docUri;

    this.ingest(change);
    if (this.mode === 'diff') {
      void vscode.window.showInformationMessage(`Temper: ${choice.reason ?? 'opening side-by-side'}.`);
    }
    this.subs.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocChange(e)),
      vscode.workspace.onWillSaveTextDocument((e) => this.onWillSave(e)),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (this.savePending && d.uri.toString() === this.docUri) {
          void vscode.window.showWarningMessage('Temper: the file was saved while a diff was open; the inline diff was dismissed.');
          this.cancel();
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.checkDiffTabOpen()),
    );
    // Wait for any restore still running on this document (a superseded session) before touching it.
    registerSession(this); // may cancel a superseded session, which starts its restore
    const prior = pendingRestores.get(this.docUri) ?? Promise.resolve();
    this.queue = prior.then(() => (this.mode === 'buffer' ? this.insert() : this.showDiff())).catch(() => undefined);
    void this.queue.then(() => {
      this.render();
      // Initial default rejections are reported so the outer state matches what the user sees.
      for (const h of this.change.hunks) {
        const d = this.decisions[h.id];
        if (d && d !== 'pending' && h.decision === 'pending') this.callbacks.onDecide?.(h.id, d);
      }
    });
  }

  /** Streaming-friendly: replace the change (new hunks appear, existing decisions are kept). */
  update(change: FileChange, opts: { syncDecisions?: boolean } = {}): void {
    if (this.disposed) return;
    const changedShape = JSON.stringify(change.hunks.map((h) => [h.id, h.lines])) !== JSON.stringify(this.change.hunks.map((h) => [h.id, h.lines]));
    this.change = change;
    this.ingest(change, opts.syncDecisions);
    if (changedShape && this.mode === 'buffer') {
      this.queue = this.queue.then(async () => {
        if (this.disposed) return;
        await this.removeInserted();
        await this.insert();
        this.render();
      }).catch(() => undefined);
    } else {
      this.render();
    }
  }

  /** Call when the stream is complete so the all-decided auto-completion can fire. */
  finish(): void {
    this.streaming = false;
    this.maybeComplete();
  }

  getDecisions(): Record<string, HunkDecision> {
    return { ...this.decisions };
  }

  private ingest(change: FileChange, sync = false): void {
    this.layouts = layoutHunks(change.hunks, this.lineOffset);
    const rejectOutside = this.opts.rejectOutsideSelectionByDefault ?? true;
    const next: Record<string, HunkDecision> = {};
    for (const h of change.hunks) {
      const prev = this.decisions[h.id];
      if (sync) next[h.id] = h.decision; // the outer flow is the authority
      else if (prev !== undefined) next[h.id] = prev;
      else if (h.decision !== 'pending') next[h.id] = h.decision;
      else next[h.id] = rejectOutside && h.flags.some((f) => f.kind === 'outsideSelection') ? 'reject' : 'pending';
    }
    this.decisions = next;
  }

  private currentLayouts(): HunkLayout[] {
    if (this.mode === 'diff') return proposedSideLayouts(this.change.hunks, this.lineOffset);
    return displayLayouts(this.change.hunks, this.blocks, this.layouts);
  }

  lenses(): LensSpec[] {
    const lineCount =
      this.mode === 'diff' ? this.change.proposed.split(/\r?\n/).length : this.editor.document.lineCount;
    return buildLenses(this.uri, this.change.hunks, this.currentLayouts(), this.decisions, lineCount);
  }

  hunkAtLine(line: number): string | undefined {
    return hunkAtLine(this.currentLayouts(), line);
  }

  decide(hunkId: string, decision: HunkDecision): void {
    if (this.disposed || !(hunkId in this.decisions)) return;
    this.decisions[hunkId] = decision;
    this.callbacks.onDecide?.(hunkId, decision);
    this.render();
    this.maybeComplete();
  }

  decideAll(decision: HunkDecision): void {
    if (this.disposed) return;
    for (const id of Object.keys(this.decisions)) {
      this.decisions[id] = decision;
      this.callbacks.onDecide?.(id, decision);
    }
    if (decision === 'pending') {
      this.render();
      return;
    }
    this.complete();
  }

  private maybeComplete(): void {
    if (this.streaming || this.opts.completeWhenDecided === false) return;
    const ids = Object.keys(this.decisions);
    if (ids.length > 0 && ids.every((id) => this.decisions[id] !== 'pending')) this.complete();
  }

  private complete(): void {
    if (this.disposed) return;
    const result = { ...this.decisions };
    this.teardown();
    // Restore the buffer first; only then may the host apply the accepted hunks.
    void this.restoreDone.then(() => this.callbacks.onComplete(result));
  }

  cancel(): void {
    if (this.disposed) return;
    this.teardown();
    void this.restoreDone.then(() => this.callbacks.onCancel());
  }

  async openSideBySide(): Promise<void> {
    if (this.mode === 'diff') {
      await this.showDiff();
      return;
    }
    const runId = this.opts.runId ?? 'inline';
    const path = this.change.path;
    proposedContent.update(runId, path, this.change.original, contentForDecisions(this.change, this.decisions, { pendingAs: 'accept' }));
    await vscode.commands.executeCommand(
      'vscode.diff',
      ProposedContentProvider.originalUri(runId, path),
      ProposedContentProvider.proposedUri(runId, path),
      `Temper: ${path} (original ↔ proposed)`,
      { preview: true, viewColumn: vscode.ViewColumn.Beside },
    );
  }

  /* ---------------------------------------------------------------- */
  /* Diff-editor fallback                                              */
  /* ---------------------------------------------------------------- */

  private async showDiff(): Promise<void> {
    const runId = this.opts.runId ?? 'inline';
    const path = this.change.path;
    proposedContent.update(runId, path, this.change.original, this.change.proposed);
    await vscode.commands.executeCommand(
      'vscode.diff',
      ProposedContentProvider.originalUri(runId, path),
      ProposedContentProvider.proposedUri(runId, path),
      `Temper: ${path} (original ↔ proposed)`,
      { preview: false },
    );
    this.diffShown = true;
  }

  private proposedTabs(): vscode.Tab[] {
    try {
      const want = ProposedContentProvider.proposedUri(this.opts.runId ?? 'inline', this.change.path).toString();
      return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => {
        const i = t.input as { modified?: vscode.Uri } | undefined;
        return i?.modified?.toString() === want;
      });
    } catch {
      return [];
    }
  }

  private checkDiffTabOpen(): void {
    if (this.mode !== 'diff' || !this.diffShown || this.disposed) return;
    if (this.proposedTabs().length === 0) this.cancel();
  }

  /* ---------------------------------------------------------------- */
  /* Buffer: insert / track / restore                                  */
  /* ---------------------------------------------------------------- */

  private async insert(): Promise<void> {
    if (this.disposed) return;
    const doc = this.editor.document;
    const plan = planBuffer(doc.getText(), this.layouts, doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    this.blocks = plan.blocks;
    if (plan.edits.length === 0) return;
    this.busy = true;
    let ok: boolean;
    try {
      ok = await this.editor.edit(
        (eb) => {
          for (const e of plan.edits) {
            const pos = e.character === 'end' ? doc.lineAt(e.line).range.end : new vscode.Position(e.line, 0);
            eb.insert(pos, e.text);
          }
        },
        { undoStopBefore: false, undoStopAfter: false },
      );
    } finally {
      this.busy = false;
    }
    if (!ok) {
      this.blocks = [];
      void vscode.window.showWarningMessage('Temper: could not show the inline diff in the editor; it was dismissed.');
      this.cancel();
      return;
    }
    this.inserted = true;
    const first = this.currentLayouts().reduce((m, l) => Math.min(m, l.firstLine), Number.MAX_SAFE_INTEGER);
    if (first !== Number.MAX_SAFE_INTEGER && first < doc.lineCount) {
      this.editor.revealRange(new vscode.Range(first, 0, first, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  private currentRestoreEdits(): vscode.TextEdit[] {
    const doc = this.editor.document;
    const len = (l: number) => (l >= 0 && l < doc.lineCount ? doc.lineAt(l).text.length : 0);
    return restoreRanges(this.blocks, len).map((r) =>
      vscode.TextEdit.delete(new vscode.Range(r.startLine, r.startCharacter, r.endLine, r.endCharacter)),
    );
  }

  /** Delete the inserted lines (one WorkspaceEdit). */
  private async removeInserted(): Promise<void> {
    if (!this.inserted) return;
    const edits = this.currentRestoreEdits();
    const we = new vscode.WorkspaceEdit();
    we.set(this.editor.document.uri, edits);
    this.busy = true;
    try {
      await vscode.workspace.applyEdit(we);
    } finally {
      this.busy = false;
    }
    this.inserted = false;
    this.blocks = [];
  }

  /** If the restored buffer equals the file on disk, drop the dirty flag by reverting that document. */
  private async revertIfClean(): Promise<void> {
    const doc = this.editor.document;
    if (!doc.isDirty || doc.isClosed) return;
    let disk: string;
    try {
      disk = Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString('utf8');
    } catch {
      return;
    }
    const norm = (s: string) => s.split(String.fromCharCode(0xfeff)).join('').split('\r\n').join('\n');
    if (norm(doc.getText()) !== norm(disk)) return; // the user has real unsaved edits: leave them alone
    try {
      if (vscode.window.activeTextEditor?.document !== doc) {
        await vscode.window.showTextDocument(doc, { viewColumn: this.editor.viewColumn, preview: false });
      }
      await vscode.commands.executeCommand('workbench.action.files.revert');
    } catch {
      /* stays dirty-but-identical; harmless */
    }
  }

  private async restore(): Promise<void> {
    await this.queue;
    try {
      await this.removeInserted();
    } catch {
      /* document gone: nothing to restore */
    }
    if (this.mode === 'buffer') await this.revertIfClean();
  }

  private onWillSave(e: vscode.TextDocumentWillSaveEvent): void {
    if (this.mode !== 'buffer' || !this.inserted || e.document.uri.toString() !== this.docUri) return;
    // Never persist the temporary lines: strip them as part of this very save, then end the session.
    e.waitUntil(Promise.resolve(this.currentRestoreEdits()));
    this.inserted = false;
    this.savePending = true;
  }

  private onDocChange(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.toString() !== this.docUri || this.busy || this.disposed || e.contentChanges.length === 0) return;
    if (this.mode === 'diff') {
      void vscode.window.showWarningMessage('Temper: the file changed while a diff was open; the diff was dismissed.');
      this.cancel();
      return;
    }
    if (!this.inserted) return;
    let blocks = this.blocks;
    const changes = [...e.contentChanges].sort((a, b) => b.range.start.line - a.range.start.line);
    for (const c of changes) {
      const next = shiftBlocks(blocks, {
        startLine: c.range.start.line,
        endLine: c.range.end.line,
        newLineBreaks: c.text.split(/\r\n|\r|\n/).length - 1,
      });
      if (!next) {
        void vscode.window.showWarningMessage('Temper: the file changed while a diff was open; the inline diff was dismissed.');
        this.cancel();
        return;
      }
      blocks = next;
    }
    this.blocks = blocks;
    this.render();
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  private render(): void {
    if (this.disposed) return;
    refreshLenses();
    if (this.mode !== 'buffer') return;
    const doc = this.editor.document;
    const plan = bufferDecorations(this.blocks, this.decisions);
    const rangesFor = (lines: number[]) =>
      toRanges(lines.filter((l) => l >= 0 && l < doc.lineCount)).map(([a, b]) => new vscode.Range(a, 0, b, doc.lineAt(b).range.end.character));
    const editors = vscode.window.visibleTextEditors.filter((ed) => ed.document.uri.toString() === this.docUri);
    for (const ed of editors.length ? editors : [this.editor]) {
      ed.setDecorations(this.removedPending, rangesFor(plan.removedPending));
      ed.setDecorations(this.removedAccepted, rangesFor(plan.removedAccepted));
      ed.setDecorations(this.removedRejected, rangesFor(plan.removedRejected));
      ed.setDecorations(this.addedPending, rangesFor(plan.addedPending));
      ed.setDecorations(this.addedAccepted, rangesFor(plan.addedAccepted));
      ed.setDecorations(this.addedRejected, rangesFor(plan.addedRejected));
    }
  }

  /** Stop interacting immediately; start restoring the buffer in the background (see restoreDone). */
  private teardown(): void {
    if (this.disposed) return;
    this.disposed = true;
    unregisterSession(this);
    this.subs.forEach((s) => s.dispose());
    for (const t of [this.removedPending, this.removedAccepted, this.removedRejected, this.addedPending, this.addedAccepted, this.addedRejected]) {
      t.dispose();
    }
    const tabs = this.proposedTabs();
    if (tabs.length) {
      try {
        void vscode.window.tabGroups.close(tabs);
      } catch {
        /* tab API unavailable */
      }
    }
    const p = this.restore().finally(() => {
      if (pendingRestores.get(this.docUri) === p) pendingRestores.delete(this.docUri);
    });
    this.restoreDone = p;
    pendingRestores.set(this.docUri, p);
  }

  dispose(): void {
    this.teardown();
  }
}
