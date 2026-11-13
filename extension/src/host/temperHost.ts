// The extension-host composition root: TrueForge connection, MCP server, run controller, editor
// review, status bar, output channel and the webview backend. Everything is async; activation never blocks.
import * as vscode from 'vscode';
import { ContextEngine, createGetContextTool, createNodeReader } from '../context';
import { getSettings } from '../config';
import { startMcpServer, readOnlyTools } from '../mcp';
import type { RunningMcpServer, TemperTool } from '../mcp';
import { promptInstruction } from '../inline';
import { TrueForgeClient } from '../trueforge';
import type { AgentSpec, RawEvent, StreamOptions } from '../trueforge';
import type { HostMessage, WebviewMessage } from '../shared/messages';
import type { ApprovalDecision, ModelInfo, RunEvent } from '../shared/types';
import type { PanelBackend } from '../panel';
import { ChangesetWorkspace } from './changesetWorkspace';
import { createEditTools } from './editTools';
import { EditorReview } from './editorReview';
import { mentionSuggestions } from './mentions';
import { buildInlinePrompt, composeAgentPrompt } from './prompts';
import { RunController } from './runController';
import type { ReviewPresentation, RunUi } from './runController';
import { computeModelView, TrueForgeConnection } from './trueforgeConnection';
import type { ConnectionClient } from './trueforgeConnection';
import { VscodeFileSystem, workspaceRootPath } from './vscodeAdapters';

const BUDGET_KEY = 'temper.budgetTokens';

/** Delegates to the current TrueForgeClient so a changed base URL does not require rebuilding everything. */
class ClientProxy implements ConnectionClient {
  constructor(public inner: TrueForgeClient) {}
  health() {
    return this.inner.health();
  }
  listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }
  ensureMcpServer(name: string, url: string, description: string) {
    return this.inner.ensureMcpServer(name, url, description);
  }
  createSession(spec: AgentSpec) {
    return this.inner.createSession(spec);
  }
  streamTurn(sessionId: string, text: string, opts?: StreamOptions): AsyncIterable<RawEvent> {
    return this.inner.streamTurn(sessionId, text, opts);
  }
  subscribe(sessionId: string, turnId: string, afterEventId?: string, signal?: AbortSignal): AsyncIterable<RawEvent> {
    return this.inner.subscribe(sessionId, turnId, afterEventId, signal);
  }
  approve(sessionId: string, turnId: string, threadId: string, toolCallId: string, decision: ApprovalDecision) {
    return this.inner.approve(sessionId, turnId, threadId, toolCallId, decision);
  }
  cancel(sessionId: string) {
    return this.inner.cancel(sessionId);
  }
}

function short(v: unknown, n = 120): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  s = (s ?? '').replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '...' : s;
}

export class TemperHost implements PanelBackend, RunUi, vscode.Disposable {
  private readonly out = vscode.window.createOutputChannel('Temper');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly root = workspaceRootPath();
  private readonly client: ClientProxy;
  private readonly connection: TrueForgeConnection;
  private readonly editorReview: EditorReview;
  private readonly controller: RunController;
  private readonly engine: ContextEngine | undefined;
  private mcp: RunningMcpServer | undefined;
  private postFn: ((m: HostMessage) => void) | undefined;
  private lastSessionId: string | undefined;
  private statusModelOverride: string | undefined;
  private readonly subs: vscode.Disposable[] = [];
  private baseUrl: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    const s = getSettings();
    this.baseUrl = s.trueforge.baseUrl;
    this.client = new ClientProxy(new TrueForgeClient({ baseUrl: this.baseUrl }));
    this.connection = new TrueForgeConnection(this.client);
    this.editorReview = new EditorReview(this.root ? vscode.Uri.file(this.root) : undefined);

    const rootPath = this.root ?? process.cwd();
    const workspace = new ChangesetWorkspace(rootPath, () => this.controller?.activeChangeset);
    const fsPort = new VscodeFileSystem(vscode.Uri.file(rootPath));
    if (this.root) {
      this.engine = new ContextEngine(createNodeReader(rootPath), {
        excludes: s.context.exclude,
        budget: { mode: s.context.budgetTokens > 0 ? 'fixed' : 'adaptive', percent: s.context.budgetPercent, tokens: this.budget() || undefined },
      });
    }
    this.controller = new RunController({
      client: this.client,
      ui: this,
      getSettings,
      getModels: () => {
        const v = this.modelView();
        return { chain: v.chain, agentModel: v.agentModel, inlineModel: v.inlineModel };
      },
      workspaceRoot: rootPath,
      workspace,
      fsPort,
      getBudget: () => this.budget(),
    });
    this.workspace = workspace;

    this.status.command = 'temper.selectModel';
    this.renderStatus();
    this.status.show();

    this.subs.push(
      this.connection.onChange(() => {
        this.postConnection();
        this.postModels();
        this.renderStatus();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('temper')) return;
        const next = getSettings();
        if (next.trueforge.baseUrl !== this.baseUrl) {
          this.baseUrl = next.trueforge.baseUrl;
          this.client.inner = new TrueForgeClient({ baseUrl: this.baseUrl });
          void this.connection.setClient(this.client);
        }
        this.engine?.setBudget(this.budget() || undefined, next.context.budgetPercent);
        this.postModels();
        this.renderStatus();
      }),
    );
  }

  private readonly workspace: ChangesetWorkspace;

  /* ------------------------------------------------------------------ */
  /* Startup                                                             */
  /* ------------------------------------------------------------------ */

  async init(): Promise<void> {
    if (this.root) {
      try {
        const settings = getSettings();
        const controller = this.controller;
        const tools: TemperTool[] = [...readOnlyTools, ...createEditTools(() => controller.active)];
        if (this.engine) {
          const engine = this.engine;
          tools.push(
            createGetContextTool({
              engine,
              getBudgetTokens: () => this.budget() || undefined,
              getContextLength: () => {
                const name = this.modelView().agentModel;
                return this.connection.state.models.find((m) => m.name === name)?.contextLength;
              },
              onSnapshot: (snapshot) => this.send({ type: 'ledger.update', snapshot }),
            }),
          );
          this.subs.push(
            engine.ledger.onDidChange((e) => {
              if (e.type === 'agentRead') this.send({ type: 'ledger.update', snapshot: e.snapshot });
            }),
          );
        }
        const services = {
          get changeset() {
            return controller.activeChangeset;
          },
          contextEngine: this.engine,
          workspaceRoot: this.root,
          get budgetTokens() {
            return controller.active?.budgetTokens ?? 0;
          },
        };
        this.mcp = await startMcpServer({
          tools,
          workspace: this.workspace,
          runId: () => controller.activeRunId,
          services,
          port: settings.mcp.port,
          onToolCall: (name, args, result, ms) => {
            this.log(`tool ${name}(${short(args, 80)}) -> ${result.isError ? 'ERROR ' : ''}${short(result.text, 100)} [${ms} ms]`);
            if (name === 'read_file' && !result.isError && this.engine && args && typeof args === 'object') {
              const a = args as Record<string, unknown>;
              if (typeof a.path === 'string') {
                this.engine.noteAgentRead(controller.activeRunId, {
                  path: a.path.replace(/\\/g, '/'),
                  startLine: typeof a.start_line === 'number' ? a.start_line : undefined,
                  endLine: typeof a.end_line === 'number' ? a.end_line : undefined,
                  tool: 'read_file',
                  content: result.text,
                });
              }
            }
          },
        });
        this.connection.setMcpUrl(this.mcp.url);
        this.log(`MCP server listening on ${this.mcp.url}`);
        void this.engine?.init().catch((e) => this.log(`context index failed: ${e instanceof Error ? e.message : String(e)}`));
      } catch (e) {
        this.log(`failed to start the MCP server: ${e instanceof Error ? e.message : String(e)}`);
        void vscode.window.showErrorMessage(`Temper could not start its tool server: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      this.log('no workspace folder is open; Temper needs one to run agents');
    }
    await this.connection.start();
  }

  /* ------------------------------------------------------------------ */
  /* Models / connection / status                                        */
  /* ------------------------------------------------------------------ */

  private budget(): number {
    return this.context.workspaceState.get<number>(BUDGET_KEY, getSettings().context.budgetTokens);
  }

  private modelView() {
    const s = getSettings();
    return computeModelView(
      this.connection.state.models,
      { chain: s.models.chain, agentMode: s.models.agentMode, inlineEdit: s.models.inlineEdit },
      this.controller?.modelHealth() ?? {},
    );
  }

  private postModels(): void {
    const v = this.modelView();
    this.send({ type: 'models.update', models: v.models, chain: v.chain, agentModel: v.agentModel, inlineModel: v.inlineModel });
  }

  private postConnection(): void {
    const st = this.connection.state;
    this.send({ type: 'connection', trueforge: st.connected ? 'connected' : 'disconnected', detail: st.detail });
  }

  private renderStatus(): void {
    const st = this.connection.state;
    if (!st.connected) {
      this.status.text = '$(sparkle) Temper: offline';
      this.status.tooltip = `TrueForge is not reachable at ${this.baseUrl}${st.detail ? `\n${st.detail}` : ''}`;
      this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }
    const model = this.statusModelOverride ?? this.modelView().agentModel;
    this.status.text = `$(sparkle) Temper: ${model || 'no model'}`;
    this.status.tooltip = model ? `Temper uses ${model} through TrueForge. Click to change.` : 'No model is configured in TrueForge.';
    this.status.backgroundColor = model ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  post(msg: HostMessage): void {
    this.send(msg);
  }

  private send(m: HostMessage): void {
    try {
      this.postFn?.(m);
    } catch {
      /* a disposed webview must not break the host */
    }
  }

  private log(line: string): void {
    this.out.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
  }

  /* ------------------------------------------------------------------ */
  /* RunUi                                                               */
  /* ------------------------------------------------------------------ */

  event(ev: RunEvent): void {
    this.send({ type: 'run.event', event: ev });
    switch (ev.kind) {
      case 'runStart':
        this.lastSessionId = ev.sessionId;
        this.statusModelOverride = ev.model;
        this.renderStatus();
        this.log(`run ${ev.runId.slice(0, 8)} (${ev.mode}) started on ${ev.model}, session ${ev.sessionId}`);
        break;
      case 'toolCall':
        this.log(`-> ${ev.name} ${short(ev.args, 100)}`);
        break;
      case 'toolResult':
        if (ev.isError) this.log(`   tool error: ${short(ev.content, 160)}`);
        break;
      case 'approval':
        this.log(`approval requested for ${ev.name}`);
        break;
      case 'fallback':
        this.statusModelOverride = ev.to;
        this.renderStatus();
        this.log(`fallback ${ev.from} -> ${ev.to}: ${ev.reason}`);
        void vscode.window.showWarningMessage(`Temper: ${ev.from} failed (${short(ev.reason, 120)}) — switched to ${ev.to}`);
        break;
      case 'retry':
        this.log(`retry ${ev.model} #${ev.attempt} in ${ev.delayMs} ms: ${short(ev.reason, 120)}`);
        break;
      case 'done':
        this.statusModelOverride = undefined;
        this.renderStatus();
        this.log(`run ended: ${ev.status}${ev.message ? ` (${short(ev.message, 200)})` : ''}`);
        if (ev.status === 'error') void vscode.window.showErrorMessage(`Temper: ${short(ev.message ?? 'The run failed.', 300)}`);
        break;
      default:
        break;
    }
  }

  notify(kind: 'info' | 'warn' | 'error', text: string): void {
    this.log(`${kind}: ${text}`);
    const fn = kind === 'error' ? vscode.window.showErrorMessage : kind === 'warn' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void fn(`Temper: ${text}`);
  }

  async openReview(p: ReviewPresentation): Promise<void> {
    await this.editorReview.open(p, this.root ? vscode.Uri.file(this.root) : undefined);
  }

  updateReview(files: Parameters<EditorReview['update']>[0]): void {
    this.editorReview.update(files);
  }

  closeReview(): void {
    this.editorReview.close();
  }

  async askPartialReview(hunkCount: number, why: 'cancelled' | 'unsubmitted'): Promise<boolean> {
    const msg =
      why === 'cancelled'
        ? `Temper stopped. ${hunkCount} proposed change${hunkCount === 1 ? '' : 's'} were not applied.`
        : `Temper finished without submitting ${hunkCount} proposed change${hunkCount === 1 ? '' : 's'}. Nothing was applied.`;
    const choice = await vscode.window.showInformationMessage(msg, 'Review partial changes', 'Discard');
    return choice === 'Review partial changes';
  }

  async confirm(text: string, okLabel: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(`Temper: ${text}`, { modal: true }, okLabel);
    return choice === okLabel;
  }

  /* ------------------------------------------------------------------ */
  /* Panel backend                                                       */
  /* ------------------------------------------------------------------ */

  attach(post: (m: HostMessage) => void): vscode.Disposable {
    this.postFn = post;
    return { dispose: () => void (this.postFn === post ? (this.postFn = undefined) : undefined) };
  }

  handle(msg: WebviewMessage): void {
    switch (msg.type) {
      case 'ready':
        this.postConnection();
        this.postModels();
        this.controller.postCheckpoints();
        void this.connection.check();
        break;
      case 'chat.send':
        void this.runAgent(msg.text, msg.mentions);
        break;
      case 'run.cancel':
        this.cancel();
        break;
      case 'ledger.pin': {
        const ledger = this.engine?.ledger;
        if (!ledger) break;
        if (ledger.retrievalState().pinned.includes(msg.id)) ledger.unpin(msg.id);
        else ledger.pin(msg.id);
        break;
      }
      case 'ledger.evict':
        this.engine?.ledger.evict(msg.id);
        break;
      case 'budget.set':
        void this.context.workspaceState.update(BUDGET_KEY, Math.max(0, Math.trunc(msg.tokens)));
        this.engine?.setBudget(msg.tokens > 0 ? msg.tokens : undefined);
        break;
      case 'models.reorder':
        void vscode.workspace.getConfiguration('temper').update('models.chain', msg.chain, vscode.ConfigurationTarget.Global);
        break;
      case 'models.pick':
        void vscode.workspace
          .getConfiguration('temper')
          .update(msg.mode === 'agent' ? 'models.agentMode' : 'models.inlineEdit', msg.name, vscode.ConfigurationTarget.Global);
        break;
      case 'review.decide':
        this.controller.decide(msg.hunkId, msg.decision);
        break;
      case 'review.decideAll':
        this.controller.decideAll(msg.decision);
        break;
      case 'review.submit':
        this.controller.submitReview(msg.reason);
        break;
      case 'review.openDiff':
        this.editorReview.openDiff(msg.path);
        break;
      case 'undo.last':
        void this.controller.undoLast();
        break;
      case 'mention.query':
        void mentionSuggestions(msg.query).then(
          (items) => this.send({ type: 'mention.suggestions', query: msg.query, items }),
          () => this.send({ type: 'mention.suggestions', query: msg.query, items: [] }),
        );
        break;
      case 'openSession':
        void this.openSession();
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Commands                                                            */
  /* ------------------------------------------------------------------ */

  private requireWorkspace(): boolean {
    if (!this.root) {
      this.notify('warn', 'Open a folder first. Temper works on the files of the open workspace.');
      return false;
    }
    return true;
  }

  private requireConnection(): boolean {
    if (!this.connection.state.connected) {
      this.notify('error', `TrueForge is not reachable at ${this.baseUrl}. Start it and try again.`);
      void this.connection.check();
      return false;
    }
    return true;
  }

  async runAgent(text: string, mentions: Parameters<typeof composeAgentPrompt>[1]): Promise<void> {
    if (!text.trim() || !this.requireWorkspace() || !this.requireConnection()) {
      this.send({ type: 'run.event', event: { kind: 'done', runId: 'none', status: 'error', message: 'Could not start the run.' } });
      return;
    }
    await this.controller.start({ mode: 'agent', prompt: composeAgentPrompt(text, mentions), label: text });
  }

  async inlineEdit(): Promise<void> {
    if (!this.requireWorkspace() || !this.requireConnection()) return;
    if (this.controller.isRunning) {
      this.notify('warn', 'A Temper run is already in progress. Stop it before starting another.');
      return;
    }
    const r = await promptInstruction(this.context.globalState);
    if (!r || !this.root) return;
    const doc = r.editor.document;
    const rel = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/');
    if (doc.uri.scheme !== 'file' || rel.startsWith('..') || /^[A-Za-z]:/.test(rel)) {
      this.notify('warn', 'Inline edits work on files inside the open workspace.');
      return;
    }
    const startLine = r.range.start.line + 1;
    const endLine = r.range.end.line + 1;
    const prompt = buildInlinePrompt({
      path: rel,
      instruction: r.instruction,
      lines: doc.getText().split(/\r?\n/),
      startLine,
      endLine,
    });
    await this.controller.start({
      mode: 'inline',
      prompt,
      scope: { kind: 'selection', path: rel, startLine, endLine },
      label: r.instruction,
    });
  }

  cancel(): void {
    this.controller.cancel();
  }

  undoLast(): Promise<void> {
    return this.controller.undoLast();
  }

  async selectModel(): Promise<void> {
    const st = this.connection.state;
    if (!st.connected) {
      await this.connection.check();
    }
    const models = this.connection.state.models;
    if (models.length === 0) {
      this.notify('warn', 'TrueForge reports no models. Add a model provider in TrueForge first.');
      return;
    }
    const current = this.modelView().agentModel;
    const pick = await vscode.window.showQuickPick(
      models.map((m) => ({ label: m.name, description: m.name === current ? 'current' : m.provider, detail: m.contextLength ? `${m.contextLength.toLocaleString()} token context` : undefined })),
      { title: 'Temper: select the model for agent mode', placeHolder: current || 'Choose a model' },
    );
    if (!pick) return;
    await vscode.workspace.getConfiguration('temper').update('models.agentMode', pick.label, vscode.ConfigurationTarget.Global);
  }

  async openSession(): Promise<void> {
    const id = this.controller.active?.turn?.sessionId ?? this.lastSessionId;
    const url = id ? `${this.baseUrl}/sessions/${encodeURIComponent(id)}` : this.baseUrl;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  showLog(): void {
    this.out.show(true);
  }

  dispose(): void {
    this.connection.stop();
    this.controller.dispose();
    this.editorReview.dispose();
    void this.mcp?.stop();
    this.subs.forEach((s) => s.dispose());
    this.status.dispose();
    this.out.dispose();
  }
}
