// In-editor review of one FileChange, without ever writing to the document buffer or disk.
//
// Rendering approach (design after Continue's vertical diff, Apache-2.0, continuedev/continue
// @ 5522c6f, modified by Temper authors):
//  - REMOVED lines: whole-line red decorations on the existing lines.
//  - ADDED lines: a green "ghost" block, one `after` pseudo-element hung off the last removed line
//    (or the line above a pure insertion). Its CSS `content` is injected through the decoration's
//    textDecoration string so it can hold `\A` newlines with `white-space: pre`. The block is
//    inline-block, top-aligned and indented, so it sits beside/below the red lines.
//  - Every ghost also carries a hover with the added code as a markdown diff block.
// Trade-off: Continue inserts real lines (stacked, always legible) but that edits the buffer, which
// Temper forbids ("nothing on disk until accepted", no dirty buffers). Monaco has fixed line height,
// so a multi-line ghost can overlap the lines under it. Mitigations: the hover, and a
// "Side-by-side" CodeLens on every change that opens vscode.diff (original vs proposed virtual doc).
// Visual verification in a real Extension Host is still required (see final notes).
import * as vscode from 'vscode';
import type { FileChange, HunkDecision } from '../shared/types';
import { proposedContent, ProposedContentProvider } from '../review/proposedContentProvider';
import { contentForDecisions } from '../review/effectiveContent';
import { cssGhostContent, planDecorations, toRanges } from './decorationModel';
import { hunkAtLine, layoutHunks } from './hunkLayout';
import type { HunkLayout } from './hunkLayout';
import { buildLenses } from './lensModel';
import type { LensSpec } from './lensModel';
import { refreshLenses, registerSession, unregisterSession } from './sessionRegistry';
import type { InlineSessionHandle } from './sessionRegistry';

export interface InlineDiffCallbacks {
  /** Every individual decision made in the editor (not fired for decisions pushed in via update()). */
  onDecide?(hunkId: string, decision: HunkDecision): void;
  /** All hunks decided, or Accept All / Reject All. The session is already disposed. */
  onComplete(decisions: Record<string, HunkDecision>): void;
  /** Escape, superseded, or the document was edited underneath the diff. Session already disposed. */
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
  /** Used for the Side-by-side lens; defaults to 'inline'. */
  runId?: string;
}

const RED = 'rgba(255, 70, 70, 0.22)';
const GREEN = 'rgba(60, 200, 90, 0.20)';
const GREY = 'rgba(128, 128, 128, 0.16)';

function ghostStyle(state: HunkDecision, content: string): vscode.ThemableDecorationAttachmentRenderOptions {
  const bg = state === 'reject' ? GREY : GREEN;
  const border = state === 'reject' ? '#888' : state === 'accept' ? '#2ea043' : '#3fb950';
  const strike = state === 'reject' ? ' text-decoration: line-through;' : '';
  const css = [
    'none',
    `content: "${content}"`,
    'display: inline-block',
    'vertical-align: top',
    'white-space: pre',
    'margin-left: 3ch',
    'padding: 0 1ch',
    `background: ${bg}`,
    `border-left: 3px solid ${border}`,
    'opacity: 0.95',
    'pointer-events: none',
  ].join('; ');
  return { textDecoration: css + ';' + strike, color: state === 'reject' ? '#888' : undefined };
}

export class InlineDiffSession implements InlineSessionHandle, vscode.Disposable {
  readonly uri: string;
  private change: FileChange;
  private layouts: HunkLayout[] = [];
  private decisions: Record<string, HunkDecision> = {};
  private disposed = false;
  private streaming: boolean;
  private readonly lineOffset: number;
  private readonly opts: InlineDiffOptions;
  private readonly subs: vscode.Disposable[] = [];
  private readonly removedPending = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: RED,
    overviewRulerColor: 'rgba(255,70,70,0.8)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly removedAccepted = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(255,70,70,0.08)',
    textDecoration: 'line-through',
    opacity: '0.6',
  });
  private readonly keptRejected = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: GREY,
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: '#888',
  });
  private ghostTypes: vscode.TextEditorDecorationType[] = [];

  constructor(
    private readonly editor: vscode.TextEditor,
    change: FileChange,
    private readonly callbacks: InlineDiffCallbacks,
    options: InlineDiffOptions = {},
  ) {
    this.opts = options;
    this.change = change;
    this.uri = editor.document.uri.toString();
    this.lineOffset = options.lineOffset ?? 0;
    this.streaming = options.streaming ?? false;
    this.ingest(change);
    this.subs.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === this.uri && e.contentChanges.length > 0) {
          void vscode.window.showWarningMessage('Temper: the file changed while a diff was open; the inline diff was dismissed.');
          this.cancel();
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
    );
    registerSession(this);
    this.render();
    // Initial default rejections are reported so the outer state matches what the user sees.
    for (const h of this.change.hunks) {
      const d = this.decisions[h.id];
      if (d && d !== 'pending' && h.decision === 'pending') this.callbacks.onDecide?.(h.id, d);
    }
  }

  /** Streaming-friendly: replace the change (new hunks appear, existing decisions are kept). */
  update(change: FileChange, opts: { syncDecisions?: boolean } = {}): void {
    if (this.disposed) return;
    this.change = change;
    this.ingest(change, opts.syncDecisions);
    this.render();
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

  lenses(): LensSpec[] {
    return buildLenses(this.uri, this.change.hunks, this.layouts, this.decisions, this.editor.document.lineCount);
  }

  hunkAtLine(line: number): string | undefined {
    return hunkAtLine(this.layouts, line);
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
    this.dispose();
    this.callbacks.onComplete(result);
  }

  cancel(): void {
    if (this.disposed) return;
    this.dispose();
    this.callbacks.onCancel();
  }

  async openSideBySide(): Promise<void> {
    const runId = this.opts.runId ?? 'inline';
    const path = this.change.path;
    const preview = contentForDecisions(this.change, this.decisions, { pendingAs: 'accept' });
    proposedContent.update(runId, path, this.change.original, preview);
    await vscode.commands.executeCommand(
      'vscode.diff',
      ProposedContentProvider.originalUri(runId, path),
      ProposedContentProvider.proposedUri(runId, path),
      `Temper: ${path} (original ↔ proposed)`,
      { preview: true, viewColumn: vscode.ViewColumn.Beside },
    );
  }

  private render(): void {
    if (this.disposed) return;
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === this.uri);
    const targets = editors.length ? editors : [this.editor];
    const plan = planDecorations(this.layouts, this.decisions);
    const lineCount = this.editor.document.lineCount;
    const rangesFor = (lines: number[]) =>
      toRanges(lines.filter((l) => l >= 0 && l < lineCount)).map(
        ([a, b]) => new vscode.Range(a, 0, b, this.editor.document.lineAt(b).range.end.character),
      );

    this.ghostTypes.forEach((t) => t.dispose());
    this.ghostTypes = [];
    const ghostEntries: Array<{ type: vscode.TextEditorDecorationType; options: vscode.DecorationOptions }> = [];
    for (const g of plan.ghosts) {
      const host = Math.min(Math.max(0, g.hostLine), lineCount - 1);
      const marker = g.state === 'accept' ? '✓' : g.state === 'reject' ? '–' : '+';
      const type = vscode.window.createTextEditorDecorationType({ after: ghostStyle(g.state, cssGhostContent(g.lines, marker)) });
      this.ghostTypes.push(type);
      const end = this.editor.document.lineAt(host).range.end;
      const md = new vscode.MarkdownString();
      md.appendCodeblock(g.lines.map((l) => `+ ${l}`).join('\n'), 'diff');
      ghostEntries.push({ type, options: { range: new vscode.Range(end, end), hoverMessage: md } });
    }

    for (const ed of targets) {
      ed.setDecorations(this.removedPending, rangesFor(plan.removedPending));
      ed.setDecorations(this.removedAccepted, rangesFor(plan.removedAccepted));
      ed.setDecorations(this.keptRejected, rangesFor(plan.keptRejected));
      for (const e of ghostEntries) ed.setDecorations(e.type, [e.options]);
    }
    refreshLenses();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    unregisterSession(this);
    this.subs.forEach((s) => s.dispose());
    for (const t of [this.removedPending, this.removedAccepted, this.keptRejected, ...this.ghostTypes]) t.dispose();
    this.ghostTypes = [];
  }
}
