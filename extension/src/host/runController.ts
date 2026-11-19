// Orchestrates Temper runs: one active run at a time, a ChangesetStore per run, model routing with
// fallback, the approval -> review bridge, apply/undo checkpoints. No vscode imports: the editor side
// is behind RunUi so the same controller runs in tests and the live smoke test.
import { randomUUID } from 'node:crypto';
import { ChangesetStore } from '../changeset';
import type { FileSystemPort } from '../changeset';
import type { SymbolIndex } from '../guards';
import { applyScopeFenceToStore } from '../guards';
import type { Scope } from '../guards';
import type { Workspace } from '../mcp';
import { ToolError } from '../mcp';
import { ModelRouter } from '../trueforge';
import type { AgentSpec, RunResult, TrueForgeClientLike } from '../trueforge';
import type { TemperSettings } from '../config/settings';
import type { HostMessage } from '../shared/messages';
import type { Checkpoint, FileChange, HunkDecision, RunEvent, RunMode } from '../shared/types';
import { ApprovalBridge } from './approvalBridge';
import type { ApprovalTarget, BridgeOutcome, DecisionOrigin } from './approvalBridge';
import { applySymbolFlags } from './editTools';
import type { EditToolRun, SymbolFlagRecord } from './editTools';
import { agentRef, buildSpec, loadSpecTemplate } from './specs';
import { STAGING_TOOLS, STAGING_WAIT_MS, stagingOf } from './stagingTracker';
import { ShadowWorktree } from './shadow';
import { buildSymbolIndex } from './symbolIndex';

export interface ReviewHandlers {
  onDecide(hunkId: string, decision: HunkDecision): void;
  onDecideAll(decision: HunkDecision): void;
  onSubmit(reason?: string): void;
  onCancel(): void;
}

export interface ReviewPresentation {
  runId: string;
  mode: RunMode;
  files: FileChange[];
  scope?: Scope;
  handlers: ReviewHandlers;
}

/** Editor/webview side effects of a run. Implemented by the extension host (and by fakes in tests). */
export interface RunUi {
  /** Every normalized run event: forward to the webview, log, toast, status bar. */
  event(ev: RunEvent): void;
  post(msg: HostMessage): void;
  notify(kind: 'info' | 'warn' | 'error', text: string): void;
  /** Open the in-editor review. Webview review is handled by the controller via post(). */
  openReview(p: ReviewPresentation): void | Promise<void>;
  /** Decisions changed outside the editor: refresh the in-editor review. */
  updateReview(files: FileChange[]): void;
  closeReview(): void;
  /** Offer to review partial changes after a cancel. Resolves false on dismiss (default: discard). */
  askPartialReview(hunkCount: number, why: 'cancelled' | 'unsubmitted'): Promise<boolean>;
  confirm(text: string, okLabel: string): Promise<boolean>;
}

export interface ModelSelection {
  chain: string[];
  agentModel: string;
  inlineModel: string;
}

export interface RunControllerDeps {
  client: TrueForgeClientLike;
  ui: RunUi;
  getSettings(): TemperSettings;
  getModels(): ModelSelection;
  workspaceRoot: string;
  /** Same Workspace instance the MCP server uses (reads go through the active changeset). */
  workspace: Workspace;
  /** File access for applying accepted hunks; the extension supplies a WorkspaceEdit-backed port. */
  fsPort: FileSystemPort;
  getBudget?(): number;
  /** The conversation moved to another session. `isNew`: this run created it. */
  onSession?(info: { sessionId: string; model: string; isNew: boolean; label: string }): void;
  /** Override for tests. */
  loadSpec?: typeof loadSpecTemplate;
}

export interface StartOptions {
  mode: RunMode;
  /** Text sent to the model. */
  prompt: string;
  /** Inline mode: the selection; the Scope Fence flags edits outside it. */
  scope?: Scope;
  /** Short label for the checkpoint, e.g. the user's request. */
  label?: string;
}

interface CheckpointEntry {
  cp: Checkpoint;
  store: ChangesetStore;
  /** File contents right after applying, to detect edits made since (undo would discard them). */
  after: Record<string, string | null>;
}

interface Verdict {
  accepted: number;
  rejected: number;
  reason?: string;
}

export interface ActiveRun extends EditToolRun {
  mode: RunMode;
  abort: AbortController;
  scope?: Scope;
  label: string;
  turn?: { sessionId: string; turnId: string; model: string };
  verdict?: Verdict;
  appliedHunks: number;
  budgetTokens: number;
  reviewOpen: boolean;
  shadowTree?: ShadowWorktree;
  indexPromise?: Promise<SymbolIndex>;
}

const NOTHING_STAGED =
  'Nothing is staged. Make edits with propose_edit or create_file first, then call submit_changeset.';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function reviewFiles(cs: { files(): FileChange[] }): FileChange[] {
  return cs.files().filter((f) => f.hunks.length > 0);
}

export class RunController {
  active: ActiveRun | undefined;
  /** The agent-mode session the next message continues (TrueForge keeps its history). */
  session: { id: string; model?: string; pick?: string } | undefined;
  private leftover: ChangesetStore | undefined;
  private readonly bridge: ApprovalBridge;
  private readonly router: ModelRouter;
  private readonly checkpoints: CheckpointEntry[] = [];
  private currentReview: { runId: string; mode: RunMode } | undefined;
  private verdictRun: ActiveRun | undefined;
  private reviewSource: { files(): FileChange[] } | undefined;

  constructor(private readonly deps: RunControllerDeps) {
    const s = deps.getSettings();
    this.router = new ModelRouter({
      client: deps.client,
      chain: deps.getModels().chain,
      retries: s.models.fallback.retries,
      fallbackEnabled: s.models.fallback.enabled,
    });
    this.bridge = new ApprovalBridge(deps.client, {
      onDecisionsChanged: (files, origin) => this.onDecisionsChanged(files, origin),
      beforeSend: (outcome) => {
        // The verdict must be recorded before the approval leaves: TrueForge may call the tool at once.
        const run = this.verdictRun;
        if (run && outcome.kind === 'allow') run.verdict = { accepted: outcome.accepted, rejected: outcome.rejected, reason: outcome.userReason };
        this.deps.ui.closeReview();
      },
    });
  }

  get activeRunId(): string {
    return this.active?.runId ?? '';
  }

  /** Active changeset for the MCP workspace overlay (undefined between runs). */
  get activeChangeset(): ChangesetStore | undefined {
    return this.active?.changeset;
  }

  get isRunning(): boolean {
    return this.active !== undefined;
  }

  /** Continue `session` with the next agent message, or start a new chat when undefined. */
  setSession(session: { id: string; model?: string; pick?: string } | undefined): void {
    this.session = session;
  }

  modelHealth() {
    return this.router.getHealth();
  }

  canUndo(): { canUndo: boolean; lastLabel?: string } {
    const top = this.checkpoints[this.checkpoints.length - 1];
    return top ? { canUndo: true, lastLabel: top.cp.label } : { canUndo: false };
  }

  postCheckpoints(): void {
    this.deps.ui.post({ type: 'checkpoints.update', ...this.canUndo() });
  }

  /* ------------------------------------------------------------------ */
  /* Starting and ending runs                                            */
  /* ------------------------------------------------------------------ */

  async start(opts: StartOptions): Promise<RunResult | undefined> {
    const { ui } = this.deps;
    if (this.active) {
      ui.notify('warn', 'A Temper run is already in progress. Stop it before starting another.');
      return undefined;
    }
    this.discardLeftover();

    const settings = this.deps.getSettings();
    const models = this.deps.getModels();
    if (models.chain.length === 0) {
      ui.notify('error', 'Temper has no model to use. Configure a model provider in TrueForge, then pick a model in the Temper panel.');
      return undefined;
    }
    let template: Record<string, unknown>;
    try {
      const load = this.deps.loadSpec ?? loadSpecTemplate;
      template = await load(opts.mode, opts.mode === 'agent' ? settings.trueforge.agent : settings.trueforge.inlineAgent);
    } catch (e) {
      ui.notify('error', errMsg(e));
      return undefined;
    }
    if (this.active) return undefined; // another start won the race during the await

    const runId = randomUUID();
    const changeset = new ChangesetStore(this.deps.fsPort);
    const run: ActiveRun = {
      runId,
      mode: opts.mode,
      workspaceRoot: this.deps.workspaceRoot,
      changeset,
      abort: new AbortController(),
      scope: opts.scope,
      label: (opts.label ?? opts.prompt).replace(/\s+/g, ' ').trim().slice(0, 60) || 'Temper changes',
      appliedHunks: 0,
      budgetTokens: this.deps.getBudget?.() ?? 0,
      reviewOpen: false,
      symbolFlags: [] as SymbolFlagRecord[],
      bounces: new Map<string, number>(),
      settings: () => this.deps.getSettings(),
      symbolIndex: () => (run.indexPromise ??= buildSymbolIndex(this.deps.workspace).catch(() => ({ has: () => true, suggest: () => [] }))),
      shadow: () => (run.shadowTree ??= new ShadowWorktree(this.deps.workspaceRoot, runId, () => this.deps.workspace.walk())),
      applySubmitted: (summary) => this.applySubmitted(run, summary),
    };
    this.active = run;
    // Warm the symbol index in the background so the first propose_edit does not pay for it.
    void run.symbolIndex();

    this.router.setConfig({
      chain: models.chain,
      retries: settings.models.fallback.retries,
      fallbackEnabled: settings.models.fallback.enabled,
    });
    const pick = opts.mode === 'agent' ? models.agentModel : models.inlineModel;

    let result: RunResult | undefined;
    try {
      result = await this.router.run({
        mode: opts.mode,
        agent: agentRef(opts.mode),
        buildSpec: (model): AgentSpec => buildSpec(template, model, { reviewMode: this.deps.getSettings().review.mode }),
        prompt: opts.prompt,
        signal: run.abort.signal,
        hasSideEffects: () => !run.changeset.isEmpty() || run.appliedHunks > 0,
        onEvent: (ev) => this.onEvent(run, ev),
        pick: pick || undefined,
        runId,
        session: opts.mode === 'agent' ? this.session : undefined,
        onTurn: (info) => {
          run.turn = info;
          if (opts.mode !== 'agent') return;
          const isNew = info.sessionId !== this.session?.id;
          this.session = { id: info.sessionId, model: info.model, pick: isNew ? pick || undefined : this.session?.pick };
          this.deps.onSession?.({
            sessionId: info.sessionId,
            model: info.model,
            isNew,
            label: run.label,
          });
        },
      });
    } catch (e) {
      ui.notify('error', `The Temper run failed: ${errMsg(e)}`);
      ui.event({ kind: 'done', runId, status: 'error', message: errMsg(e) });
    } finally {
      await this.endRun(run, result?.status);
    }
    return result;
  }

  private onEvent(run: ActiveRun, ev: RunEvent): void {
    try {
      this.deps.ui.event(ev);
    } catch {
      /* UI errors must never break the run */
    }
    // Track staging calls announced by the model so a same-batch submit_changeset can wait for them.
    if (ev.kind === 'toolCall' && STAGING_TOOLS.has(ev.name)) stagingOf(run).begin(`ev:${ev.id}`);
    else if (ev.kind === 'toolResult') stagingOf(run).end(`ev:${ev.id}`);
    else if (ev.kind === 'done') stagingOf(run).clear();
    if (ev.kind === 'approval') void this.handleApproval(run, ev);
  }

  private async endRun(run: ActiveRun, status: RunResult['status'] | undefined): Promise<void> {
    this.bridge.abort();
    this.verdictRun = undefined;
    if (run.reviewOpen) this.closeReviewUi(run.runId, 0, 0);
    this.active = undefined;
    try {
      await run.shadowTree?.dispose();
    } catch {
      /* temp dir cleanup is best effort */
    }
    const cs = run.changeset;
    if (cs.isEmpty()) return;
    const hunks = reviewFiles(cs).reduce((n, f) => n + f.hunks.length, 0);
    if (run.mode === 'agent' && (status === 'cancelled' || status === 'done') && hunks > 0) {
      void this.offerPartial(cs, hunks, status === 'cancelled' ? 'cancelled' : 'unsubmitted');
    } else {
      cs.discard();
    }
  }

  /** Stop the active run. Nothing was written, so the workspace is untouched. */
  cancel(): void {
    const run = this.active;
    if (run) {
      run.abort.abort();
      this.bridge.abort();
      if (run.reviewOpen) this.closeReviewUi(run.runId, 0, 0);
      return;
    }
    if (this.leftover) this.discardLeftover();
  }

  /* ------------------------------------------------------------------ */
  /* Approval -> review                                                  */
  /* ------------------------------------------------------------------ */

  private async handleApproval(run: ActiveRun, ev: Extract<RunEvent, { kind: 'approval' }>): Promise<void> {
    const turn = run.turn;
    if (!turn) {
      this.deps.ui.notify('error', 'Temper received an approval request before the turn started; cancelling.');
      this.cancel();
      return;
    }
    const target: ApprovalTarget = { sessionId: turn.sessionId, turnId: turn.turnId, threadId: ev.threadId, toolCallId: ev.toolCallId };
    const send = (d: { status: 'allow' } | { status: 'deny'; reason: string }) =>
      this.deps.client.approve(target.sessionId, target.turnId, target.threadId, target.toolCallId, d);
    try {
      if (run.abort.signal.aborted) return;
      if (ev.name === 'submit_changeset') await this.reviewSubmit(run, target, send);
      else if (ev.name === 'propose_edit' || ev.name === 'create_file') await this.reviewSingleEdit(run, ev, target, send);
      else await send({ status: 'deny', reason: `Tool "${ev.name}" is not permitted in Temper.` });
    } catch (e) {
      this.deps.ui.notify('error', `Temper could not complete the review: ${errMsg(e)}`);
      if (!run.abort.signal.aborted) {
        try {
          await send({ status: 'deny', reason: `The review could not be completed: ${errMsg(e)}` });
        } catch {
          this.cancel();
        }
      }
    }
  }

  private async reviewSubmit(
    run: ActiveRun,
    target: ApprovalTarget,
    send: (d: { status: 'allow' } | { status: 'deny'; reason: string }) => Promise<void>,
  ): Promise<void> {
    // propose_edit/create_file may still be running (same batch as submit_changeset): open the
    // review only after they have settled, then look at the changeset.
    await stagingOf(run).settle(STAGING_WAIT_MS);
    if (run.abort.signal.aborted) return;
    const cs = run.changeset;
    if (cs.isEmpty()) return send({ status: 'deny', reason: NOTHING_STAGED });

    applySymbolFlags(cs, run.symbolFlags);
    if (run.scope) applyScopeFenceToStore(cs, run.scope, this.deps.getSettings().guards.scopeFence);
    if (reviewFiles(cs).length === 0) {
      return send({ status: 'deny', reason: 'Every proposed change was outside the allowed scope and was blocked. Stay within the requested scope.' });
    }

    if (this.deps.getSettings().review.mode === 'perEdit') {
      // Each edit was already approved one by one; the final submit only applies them.
      cs.setAll('accept');
      run.verdict = { accepted: reviewFiles(cs).reduce((n, f) => n + f.hunks.length, 0), rejected: 0 };
      return send({ status: 'allow' });
    }

    const outcome = await this.runReview(run, target, cs, { forSubmit: true });
    this.afterReview(run, outcome, cs);
  }

  /** perEdit mode: show the single edit the agent wants to make before it is staged. */
  private async reviewSingleEdit(
    run: ActiveRun,
    ev: Extract<RunEvent, { kind: 'approval' }>,
    target: ApprovalTarget,
    send: (d: { status: 'allow' } | { status: 'deny'; reason: string }) => Promise<void>,
  ): Promise<void> {
    const args = (ev.args ?? {}) as Record<string, unknown>;
    const path = String(args.path ?? '');
    const scratch = new ChangesetStore({
      read: (p) => run.changeset.read(p),
      write: () => Promise.reject(new Error('preview only')),
      delete: () => Promise.reject(new Error('preview only')),
    });
    const r =
      ev.name === 'create_file'
        ? await scratch.createFile(path, String(args.content ?? ''), String(args.rationale ?? ''))
        : await scratch.stage(path, String(args.old_string ?? ''), String(args.new_string ?? ''), String(args.rationale ?? ''));
    if (!r.ok) return send({ status: 'deny', reason: r.message });
    if (run.scope) applyScopeFenceToStore(scratch, run.scope, this.deps.getSettings().guards.scopeFence);
    if (reviewFiles(scratch).length === 0) return send({ status: 'deny', reason: 'This edit is outside the allowed scope.' });
    const outcome = await this.runReview(run, target, scratch, { requireAll: true });
    if (outcome.kind === 'error') this.deps.ui.notify('error', `Could not send your decision to TrueForge: ${outcome.message}`);
    this.closeReviewUi(run.runId, 0, 0);
  }

  private async runReview(
    run: ActiveRun,
    target: ApprovalTarget,
    subject: { files(): FileChange[]; setDecision(id: string, d: HunkDecision): boolean; setAll(d: HunkDecision): void },
    opts: { requireAll?: boolean; forSubmit?: boolean },
  ): Promise<BridgeOutcome> {
    const files = reviewFiles(subject);
    this.reviewSource = subject;
    this.currentReview = { runId: run.runId, mode: run.mode };
    run.reviewOpen = true;
    if (run.mode === 'agent') this.deps.ui.post({ type: 'review.open', runId: run.runId, changes: files });
    this.verdictRun = opts.forSubmit ? run : undefined;
    const pending = this.bridge.open(target, subject, opts);
    try {
      await this.deps.ui.openReview({ runId: run.runId, mode: run.mode, files, scope: run.scope, handlers: this.handlers() });
    } catch (e) {
      this.deps.ui.notify('warn', `Could not open the editor review (${errMsg(e)}). Use the Temper panel to review.`);
    }
    return pending;
  }

  private afterReview(run: ActiveRun, outcome: BridgeOutcome, cs: ChangesetStore): void {
    switch (outcome.kind) {
      case 'allow':
        break; // verdict already recorded in beforeSend; submit_changeset's handler applies and closes the review
      case 'deny': {
        const total = reviewFiles(cs).reduce((n, f) => n + f.hunks.length, 0);
        cs.setAll('pending');
        this.closeReviewUi(run.runId, 0, total);
        break;
      }
      case 'error':
        this.deps.ui.notify('error', `Could not send your decision to TrueForge: ${outcome.message}`);
        this.closeReviewUi(run.runId, 0, 0);
        break;
      case 'aborted':
        break;
    }
  }

  private handlers(): ReviewHandlers {
    return {
      onDecide: (id, d) => this.bridge.decide(id, d, 'editor'),
      onDecideAll: (d) => this.bridge.decideAll(d, 'editor'),
      onSubmit: (reason) => void this.bridge.submit(reason),
      onCancel: () => this.cancel(),
    };
  }

  private onDecisionsChanged(files: FileChange[], origin: DecisionOrigin): void {
    const cur = this.currentReview;
    if (!cur) return;
    const shown = files.filter((f) => f.hunks.length > 0);
    if (origin === 'webview') this.deps.ui.updateReview(shown);
    else if (cur.mode === 'agent') this.deps.ui.post({ type: 'review.open', runId: cur.runId, changes: shown });
  }

  private closeReviewUi(runId: string, applied: number, rejected: number): void {
    this.deps.ui.closeReview();
    if (this.currentReview?.mode !== 'inline') this.deps.ui.post({ type: 'review.closed', runId, applied, rejected });
    this.currentReview = undefined;
    this.reviewSource = undefined;
    if (this.active) this.active.reviewOpen = false;
  }

  /* Webview -> controller */

  decide(hunkId: string, decision: HunkDecision): void {
    this.bridge.decide(hunkId, decision, 'webview');
  }
  decideAll(decision: HunkDecision): void {
    this.bridge.decideAll(decision, 'webview');
  }
  submitReview(reason?: string): void {
    void this.bridge.submit(reason);
  }
  /** Current files under review (for review.openDiff). */
  reviewFilesNow(): FileChange[] {
    return this.reviewSource ? reviewFiles(this.reviewSource) : [];
  }

  /* ------------------------------------------------------------------ */
  /* Apply (submit_changeset handler) and undo                           */
  /* ------------------------------------------------------------------ */

  private async applySubmitted(run: ActiveRun, summary: string): Promise<string> {
    const verdict = run.verdict;
    if (!verdict) {
      throw new ToolError('The changeset has not been approved by the user, so nothing was applied. Wait for the review to finish.');
    }
    run.verdict = undefined;
    const cs = run.changeset;
    let cp: Checkpoint;
    try {
      cp = await cs.applyAccepted(summary.replace(/\s+/g, ' ').trim().slice(0, 60) || run.label);
    } catch (e) {
      this.closeReviewUi(run.runId, 0, 0);
      throw e;
    }
    run.appliedHunks += cp.appliedHunks;
    const paths = Object.keys(cp.originals);
    const after: Record<string, string | null> = {};
    for (const p of paths) {
      try {
        after[p] = await cs.read(p);
      } catch {
        after[p] = null;
      }
    }
    this.checkpoints.push({ cp, store: cs, after });
    this.closeReviewUi(run.runId, cp.appliedHunks, cp.rejectedHunks);
    this.postCheckpoints();
    const why = verdict.reason ?? (cp.rejectedHunks > 0 ? 'not accepted by the user in review' : 'none');
    return `Applied ${cp.appliedHunks} hunk${cp.appliedHunks === 1 ? '' : 's'} in ${paths.join(', ')}; rejected ${cp.rejectedHunks} (${why}).`;
  }

  async undoLast(): Promise<void> {
    const { ui } = this.deps;
    const top = this.checkpoints[this.checkpoints.length - 1];
    if (!top) {
      ui.notify('info', 'Temper has no agent change to undo.');
      return;
    }
    const changed: string[] = [];
    for (const [p, expected] of Object.entries(top.after)) {
      let now: string | null = null;
      try {
        now = await top.store.read(p);
      } catch {
        /* treat as missing */
      }
      if (now !== expected) changed.push(p);
    }
    if (changed.length > 0) {
      const ok = await ui.confirm(
        `${changed.join(', ')} changed since Temper applied "${top.cp.label}". Undoing will discard those later edits. Undo anyway?`,
        'Undo anyway',
      );
      if (!ok) return;
    }
    try {
      const done = await top.store.undo(top.cp.id);
      if (!done) {
        ui.notify('warn', 'That change can no longer be undone.');
      } else {
        ui.notify('info', `Reverted "${top.cp.label}" (${Object.keys(top.cp.originals).length} file${Object.keys(top.cp.originals).length === 1 ? '' : 's'}).`);
      }
    } catch (e) {
      ui.notify('error', `Undo failed: ${errMsg(e)}`);
      return;
    }
    this.checkpoints.pop();
    this.postCheckpoints();
  }

  /* ------------------------------------------------------------------ */
  /* Partial changes after cancel                                        */
  /* ------------------------------------------------------------------ */

  private async offerPartial(cs: ChangesetStore, hunks: number, why: 'cancelled' | 'unsubmitted'): Promise<void> {
    this.leftover = cs;
    const wants = await this.deps.ui.askPartialReview(hunks, why).catch(() => false);
    if (this.leftover !== cs) return; // superseded by a new run or discarded
    if (!wants) {
      this.discardLeftover();
      return;
    }
    const runId = randomUUID();
    const mode: RunMode = 'agent';
    this.verdictRun = undefined;
    this.reviewSource = cs;
    this.currentReview = { runId, mode };
    const files = reviewFiles(cs);
    this.deps.ui.post({ type: 'review.open', runId, changes: files });
    const pending = this.bridge.open(undefined, cs);
    try {
      await this.deps.ui.openReview({ runId, mode, files, handlers: this.handlers() });
    } catch {
      /* the panel review still works */
    }
    const outcome = await pending;
    if (this.leftover !== cs) return;
    this.leftover = undefined;
    if (outcome.kind !== 'allow') {
      cs.discard();
      this.closeReviewUi(runId, 0, 0);
      return;
    }
    try {
      const cp = await cs.applyAccepted('Partial agent changes');
      const after: Record<string, string | null> = {};
      for (const p of Object.keys(cp.originals)) after[p] = await cs.read(p).catch(() => null);
      this.checkpoints.push({ cp, store: cs, after });
      this.closeReviewUi(runId, cp.appliedHunks, cp.rejectedHunks);
      this.postCheckpoints();
    } catch (e) {
      this.closeReviewUi(runId, 0, 0);
      this.deps.ui.notify('error', `Could not apply the partial changes: ${errMsg(e)}`);
    }
  }

  private discardLeftover(): void {
    const cs = this.leftover;
    if (!cs) return;
    this.leftover = undefined;
    this.bridge.abort();
    cs.discard();
    if (this.currentReview) this.closeReviewUi(this.currentReview.runId, 0, 0);
  }

  dispose(): void {
    this.cancel();
    this.discardLeftover();
  }
}
