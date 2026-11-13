// The extension-host composition root: TrueForge connection, MCP server, run controller, editor
// review, status bar, output channel and the webview backend. Everything is async; activation never blocks.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ContextEngine, createGetContextTool, createNodeReader } from '../context';
import { getSettings } from '../config';
import { formatPrice } from '../shared/usage';
import { createPricingService } from '../pricing';
import type { PricingService } from '../pricing';
import { startMcpServer, readOnlyTools } from '../mcp';
import type { RunningMcpServer, TemperTool } from '../mcp';
import { addToHistory, promptInstruction } from '../inline';
import { selectionToLines } from '../inline/instructionModel';
import { TrueForgeClient } from '../trueforge';
import type { AgentRef, AgentSpec, RawEvent, StreamOptions } from '../trueforge';
import type {
  ComposerMode,
  EditorSelection,
  HostMessage,
  WebviewMessage,
} from '../shared/messages';
import type { ApprovalDecision, ModelInfo, RunEvent } from '../shared/types';
import type { PanelBackend } from '../panel';
import { ChangesetWorkspace } from './changesetWorkspace';
import { createEditTools } from './editTools';
import { EditorReview } from './editorReview';
import { mentionSuggestions } from './mentions';
import { ProviderSetup } from './providerSetup';
import { SandboxSetup } from './sandboxSetup';
import { isJsonOnlyKey, validateSetting } from '../shared/settings';
import type { SettingsSnapshot } from '../shared/settings';
import { buildInlinePrompt, composeAgentPrompt } from './prompts';
import { RunController } from './runController';
import type { ReviewPresentation, RunUi } from './runController';
import { computeModelView, TrueForgeConnection } from './trueforgeConnection';
import type { AgentDef, ConnectionClient } from './trueforgeConnection';
import { agentRef, buildSpec, loadSpecTemplate } from './specs';
import { VscodeFileSystem, workspaceRootPath } from './vscodeAdapters';
import { SessionCoordinator } from './sessionCoordinator';
import { SessionHistory } from './sessionHistory';

const BUDGET_KEY = 'temper.budgetTokens';
const SESSION_KEY = 'temper.sessionId';

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
  upsertAgent(name: string, description: string, manifest: AgentSpec) {
    return this.inner.upsertAgent(name, description, manifest);
  }
  createSession(spec: AgentSpec, agent?: AgentRef, metadata?: Record<string, string>) {
    return this.inner.createSession(spec, agent, metadata);
  }
  getAgentId(name: string) {
    return this.inner.getAgentId(name);
  }
  listSessions(opts: Parameters<TrueForgeClient['listSessions']>[0]) {
    return this.inner.listSessions(opts);
  }
  listTurns(sessionId: string) {
    return this.inner.listTurns(sessionId);
  }
  listSessionEvents(sessionId: string) {
    return this.inner.listSessionEvents(sessionId);
  }
  setSessionTitle(sessionId: string, title: string) {
    return this.inner.setSessionTitle(sessionId, title);
  }
  streamTurn(sessionId: string, text: string, opts?: StreamOptions): AsyncIterable<RawEvent> {
    return this.inner.streamTurn(sessionId, text, opts);
  }
  subscribe(
    sessionId: string,
    turnId: string,
    afterEventId?: string,
    signal?: AbortSignal,
  ): AsyncIterable<RawEvent> {
    return this.inner.subscribe(sessionId, turnId, afterEventId, signal);
  }
  approve(
    sessionId: string,
    turnId: string,
    threadId: string,
    toolCallId: string,
    decision: ApprovalDecision,
  ) {
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
  private readonly pricing: PricingService;
  private readonly editorReview: EditorReview;
  private readonly controller: RunController;
  private readonly sessions: SessionCoordinator;
  private readonly engine: ContextEngine | undefined;
  private mcp: RunningMcpServer | undefined;
  private postFn: ((m: HostMessage) => void) | undefined;
  private lastSessionId: string | undefined;
  private webviewReady = false;
  private readonly queued: HostMessage[] = [];
  private lastSelection: EditorSelection | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | undefined;
  private statusModelOverride: string | undefined;
  private readonly subs: vscode.Disposable[] = [];
  private baseUrl: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    const s = getSettings();
    this.baseUrl = s.trueforge.baseUrl;
    this.client = new ClientProxy(
      new TrueForgeClient({ baseUrl: this.baseUrl, log: (l) => this.log(l) }),
    );
    this.pricing = createPricingService(context, (l) => this.log(l));
    this.connection = new TrueForgeConnection(this.client);
    this.connection.onLog = (l) => this.log(l);
    this.providers = new ProviderSetup({
      extensionUri: context.extensionUri,
      getBaseUrl: () => this.baseUrl,
      post: (m) => this.send(m),
      log: (l) => this.log(l),
      refreshConnection: () => this.connection.check(),
    });
    this.sandbox = new SandboxSetup({
      getBaseUrl: () => this.baseUrl,
      post: (m) => this.send(m),
      log: (l) => this.log(l),
    });
    this.connection.setAgentProvider(() => this.agentDefs());
    this.editorReview = new EditorReview(this.root ? vscode.Uri.file(this.root) : undefined);

    const rootPath = this.root ?? process.cwd();
    const workspace = new ChangesetWorkspace(rootPath, () => this.controller?.activeChangeset);
    const fsPort = new VscodeFileSystem(vscode.Uri.file(rootPath));
    if (this.root) {
      this.engine = new ContextEngine(createNodeReader(rootPath), {
        excludes: s.context.exclude,
        budget: {
          mode: s.context.budgetTokens > 0 ? 'fixed' : 'adaptive',
          percent: s.context.budgetPercent,
          tokens: this.budget() || undefined,
        },
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
      onSession: (info) => this.sessions.onSession(info),
    });
    this.sessions = new SessionCoordinator({
      history: new SessionHistory(this.client, agentRef('agent').name),
      controller: this.controller,
      store: {
        get: () => this.context.workspaceState.get<string>(SESSION_KEY),
        set: (id) => void this.context.workspaceState.update(SESSION_KEY, id),
      },
      post: (m) => this.send(m),
      setTitle: (id, title) => this.client.setSessionTitle(id, title),
      log: (l) => this.log(l),
    });
    this.workspace = workspace;

    void vscode.commands.executeCommand('setContext', 'temper.canUndo', false);
    this.status.command = 'temper.selectModel';
    this.renderStatus();
    this.status.show();

    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        // Focus moving to the webview makes the active editor undefined; keep the last value then.
        if (e) this.scheduleSelection();
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.scheduleSelection();
      }),
      this.connection.onChange(() => {
        this.postConnection();
        void this.providers.refresh();
        void this.sandbox.refresh();
        this.postModels();
        this.renderStatus();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('temper')) return;
        const next = getSettings();
        if (next.trueforge.baseUrl !== this.baseUrl) {
          this.baseUrl = next.trueforge.baseUrl;
          this.client.inner = new TrueForgeClient({
            baseUrl: this.baseUrl,
            log: (l) => this.log(l),
          });
          void this.connection.setClient(this.client);
        }
        this.engine?.setBudget(this.budget() || undefined, next.context.budgetPercent);
        this.postSettings();
        this.postModels();
        this.renderStatus();
      }),
    );
  }

  private readonly workspace: ChangesetWorkspace;
  private readonly providers: ProviderSetup;
  private readonly sandbox: SandboxSetup;

  /* ------------------------------------------------------------------ */
  /* Startup                                                             */
  /* ------------------------------------------------------------------ */

  async init(): Promise<void> {
    void this.pricing.init().then((changed) => changed && this.postModels());
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
              if (e.type === 'agentRead')
                this.send({ type: 'ledger.update', snapshot: e.snapshot });
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
            this.log(
              `tool ${name}(${short(args, 80)}) -> ${result.isError ? 'ERROR ' : ''}${short(result.text, 100)} [${ms} ms]`,
            );
            if (
              name === 'read_file' &&
              !result.isError &&
              this.engine &&
              args &&
              typeof args === 'object'
            ) {
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
        void this.engine
          ?.init()
          .catch((e) =>
            this.log(`context index failed: ${e instanceof Error ? e.message : String(e)}`),
          );
      } catch (e) {
        this.log(`failed to start the MCP server: ${e instanceof Error ? e.message : String(e)}`);
        void vscode.window.showErrorMessage(
          `Temper could not start its tool server: ${e instanceof Error ? e.message : String(e)}`,
        );
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

  /** The named agents to keep registered in TrueForge, with the model currently picked for each mode. */
  private async agentDefs(): Promise<AgentDef[]> {
    const s = getSettings();
    const v = this.modelView();
    const out: AgentDef[] = [];
    for (const mode of ['agent', 'inline'] as const) {
      const model = mode === 'agent' ? v.agentModel : v.inlineModel;
      if (!model) continue;
      const template = await loadSpecTemplate(
        mode,
        mode === 'agent' ? s.trueforge.agent : s.trueforge.inlineAgent,
      );
      out.push({
        ...agentRef(mode),
        manifest: buildSpec(template, model, { reviewMode: s.review.mode }),
      });
    }
    return out;
  }

  private postModels(): void {
    const v = this.modelView();
    this.send({ type: 'models.update', models: this.pricing.enrich(v.models), chain: v.chain, agentModel: v.agentModel, inlineModel: v.inlineModel });
  }

  private settingsSnapshot(): SettingsSnapshot {
    const s = getSettings();
    const cfg = vscode.workspace.getConfiguration('temper');
    const overrides = cfg.get<Record<string, unknown>>('pricing.overrides') ?? {};
    return {
      fallback: s.models.fallback,
      context: { budgetTokens: this.budget(), budgetPercent: s.context.budgetPercent, exclude: s.context.exclude },
      review: { mode: s.review.mode },
      guards: s.guards,
      commands: s.commands,
      pricing: { fetch: cfg.get<boolean>('pricing.fetch') ?? true, overrideCount: Object.keys(overrides).length },
    };
  }

  private postSettings(): void {
    this.send({ type: 'settings.state', settings: this.settingsSnapshot() });
  }

  private async updateSetting(key: string, value: unknown): Promise<void> {
    const check = validateSetting(key, value);
    if (!check.ok) {
      this.log(`settings.update refused (${key}): ${check.reason}`);
      this.notify('warn', check.reason);
      this.postSettings();
      return;
    }
    // The ledger's own budget control keeps a workspace override that would mask this setting.
    if (key === 'context.budgetTokens') await this.context.workspaceState.update(BUDGET_KEY, check.value);
    try {
      await vscode.workspace
        .getConfiguration('temper')
        .update(key, check.value, vscode.ConfigurationTarget.Global);
    } catch (e) {
      this.notify('error', `Could not save temper.${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.engine?.setBudget(this.budget() || undefined, getSettings().context.budgetPercent);
    this.postSettings();
  }

  private postConnection(): void {
    const st = this.connection.state;
    this.send({
      type: 'connection',
      trueforge: st.connected ? 'connected' : 'disconnected',
      detail: st.detail,
    });
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
    this.status.tooltip = model
      ? `Temper uses ${model} through TrueForge. Click to change.`
      : 'No model is configured in TrueForge.';
    this.status.backgroundColor = model
      ? undefined
      : new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  post(msg: HostMessage): void {
    this.send(msg);
  }

  private send(m: HostMessage): void {
    if (m.type === 'checkpoints.update')
      void vscode.commands.executeCommand('setContext', 'temper.canUndo', m.canUndo);
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
        this.log(
          `run ${ev.runId.slice(0, 8)} (${ev.mode}) started on ${ev.model}, session ${ev.sessionId}`,
        );
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
        void vscode.window.showWarningMessage(
          `Temper: ${ev.from} failed (${short(ev.reason, 120)}) — switched to ${ev.to}`,
        );
        break;
      case 'retry':
        this.log(`retry ${ev.model} #${ev.attempt} in ${ev.delayMs} ms: ${short(ev.reason, 120)}`);
        break;
      case 'done':
        this.statusModelOverride = undefined;
        this.renderStatus();
        this.log(`run ended: ${ev.status}${ev.message ? ` (${short(ev.message, 200)})` : ''}`);
        if (ev.status === 'error')
          void vscode.window.showErrorMessage(
            `Temper: ${short(ev.message ?? 'The run failed.', 300)}`,
          );
        break;
      default:
        break;
    }
  }

  notify(kind: 'info' | 'warn' | 'error', text: string): void {
    this.log(`${kind}: ${text}`);
    const fn =
      kind === 'error'
        ? vscode.window.showErrorMessage
        : kind === 'warn'
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
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
    const choice = await vscode.window.showInformationMessage(
      msg,
      'Review partial changes',
      'Discard',
    );
    return choice === 'Review partial changes';
  }

  async confirm(text: string, okLabel: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      `Temper: ${text}`,
      { modal: true },
      okLabel,
    );
    return choice === okLabel;
  }

  /* ------------------------------------------------------------------ */
  /* Panel backend                                                       */
  /* ------------------------------------------------------------------ */

  attach(post: (m: HostMessage) => void): vscode.Disposable {
    this.postFn = post;
    this.webviewReady = false;
    return { dispose: () => void (this.postFn === post ? (this.postFn = undefined) : undefined) };
  }

  handle(msg: WebviewMessage): void {
    switch (msg.type) {
      case 'ready':
        this.webviewReady = true;
        for (const m of this.queued.splice(0)) this.send(m);
        this.lastSelection = this.computeSelection(vscode.window.activeTextEditor);
        this.send({ type: 'editor.selection', selection: this.lastSelection });
        this.postConnection();
        this.postModels();
        this.postSettings();
        this.controller.postCheckpoints();
        void this.connection.check();
        void this.sessions.restore();
        void this.providers.refresh();
        break;
      case 'providers.refresh':
        void this.providers.refresh();
        break;
      case 'providers.add':
        void this.providers.add(msg.id);
        break;
      case 'providers.edit':
        void this.providers.edit(msg.name);
        break;
      case 'providers.check':
        void this.providers.check(msg.name);
        break;
      case 'providers.remove':
        void this.providers.remove(msg.name);
        break;
      case 'settings.refresh':
        this.postSettings();
        void this.sandbox.refresh();
        break;
      case 'settings.update':
        void this.updateSetting(msg.key, msg.value);
        break;
      case 'settings.openJson':
        if (isJsonOnlyKey(msg.key))
          void vscode.commands.executeCommand('workbench.action.openSettingsJson', {
            revealSetting: { key: `temper.${msg.key}`, edit: false },
          });
        break;
      case 'sandbox.connect':
        void this.sandbox.connect();
        break;
      case 'trueforge.open':
        void vscode.env.openExternal(vscode.Uri.parse(this.baseUrl));
        break;
      case 'server.start':
        void this.providers.startServer();
        break;
      case 'server.copyCommand':
        void this.providers.copyCommand();
        break;
      case 'connection.retry':
        void this.connection.check().then(() => this.providers.refresh());
        break;
      case 'chat.send':
        if (msg.mode === 'edit') void this.runEditFromChat(msg.text, msg.selection);
        else void this.runAgent(msg.text, msg.mentions);
        break;
      case 'open.file':
        void this.openFile(msg.path, msg.line);
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
        void vscode.workspace
          .getConfiguration('temper')
          .update('models.chain', msg.chain, vscode.ConfigurationTarget.Global);
        break;
      case 'models.pick':
        void vscode.workspace
          .getConfiguration('temper')
          .update(
            msg.mode === 'agent' ? 'models.agentMode' : 'models.inlineEdit',
            msg.name,
            vscode.ConfigurationTarget.Global,
          );
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
        void this.openSession(msg.sessionId);
        break;
      case 'history.list':
        void this.sessions.list(msg.pageToken);
        break;
      case 'session.load':
        void this.sessions.load(msg.id);
        break;
      case 'session.new':
        if (!this.sessions.newChat())
          this.notify('warn', 'Stop the current run before starting a new chat.');
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
      this.notify(
        'error',
        `TrueForge is not reachable at ${this.baseUrl}. Start it and try again.`,
      );
      void this.connection.check();
      return false;
    }
    return true;
  }

  async runAgent(text: string, mentions: Parameters<typeof composeAgentPrompt>[1]): Promise<void> {
    if (!text.trim() || !this.requireWorkspace() || !this.requireConnection()) {
      this.send({
        type: 'run.event',
        event: {
          kind: 'done',
          runId: 'none',
          status: 'error',
          message: 'Could not start the run.',
        },
      });
      return;
    }
    await this.controller.start({
      mode: 'agent',
      prompt: composeAgentPrompt(text, mentions),
      label: text,
    });
  }

  async inlineEdit(): Promise<void> {
    if (!this.requireWorkspace() || !this.requireConnection()) return;
    if (this.controller.isRunning) {
      this.notify('warn', 'A Temper run is already in progress. Stop it before starting another.');
      return;
    }
    const r = await promptInstruction(this.context.globalState, {
      model: this.modelView().inlineModel,
      onContinueInChat: (text, editor, range) => {
        const sel = this.toEditorSelection(
          editor.document.uri,
          range.start.line + 1,
          range.end.line + 1,
        );
        if (sel) void this.addSelectionToChat(sel, text);
      },
      onChangeModel: () => void this.selectModel('inline'),
    });
    if (!r) return;
    const doc = r.editor.document;
    const sel = this.toEditorSelection(doc.uri, r.range.start.line + 1, r.range.end.line + 1);
    if (!sel) {
      this.notify('warn', 'Inline edits work on files inside the open workspace.');
      return;
    }
    await this.startInlineRun(sel, r.instruction, doc.getText());
  }

  /** chat.send with mode 'edit': the inline flow with the instruction and range from the composer. */
  private async runEditFromChat(text: string, sel: EditorSelection | undefined): Promise<void> {
    const fail = (message: string) =>
      this.send({
        type: 'run.event',
        event: { kind: 'done', runId: 'none', status: 'error', message },
      });
    if (!sel) return fail('Edit mode needs a selection. Select code in the editor first.');
    if (!text.trim() || !this.requireWorkspace() || !this.requireConnection())
      return fail('Could not start the run.');
    if (this.controller.isRunning) return fail('A Temper run is already in progress.');
    const root = this.root;
    const abs = root ? path.resolve(root, sel.path) : '';
    const rel = root ? path.relative(root, abs) : '';
    if (!root || rel.startsWith('..') || path.isAbsolute(rel)) {
      return fail('Inline edits work on files inside the open workspace.');
    }
    let content: string;
    try {
      content = (await vscode.workspace.openTextDocument(vscode.Uri.file(abs))).getText();
    } catch {
      return fail(`Could not read ${sel.path}.`);
    }
    await addToHistory(this.context.globalState, text);
    await this.startInlineRun(sel, text.trim(), content);
  }

  private async startInlineRun(
    sel: EditorSelection,
    instruction: string,
    content: string,
  ): Promise<void> {
    const prompt = buildInlinePrompt({
      path: sel.path,
      instruction,
      lines: content.split(/\r?\n/),
      startLine: sel.startLine,
      endLine: sel.endLine,
    });
    await this.controller.start({
      mode: 'inline',
      prompt,
      scope: { kind: 'selection', path: sel.path, startLine: sel.startLine, endLine: sel.endLine },
      label: instruction,
    });
  }

  /** Workspace-relative forward-slash path for a file in the workspace, else undefined. */
  private relativePath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') return undefined;
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    if (rel.startsWith('..') || /^[A-Za-z]:/.test(rel) || rel.startsWith('/')) return undefined;
    return rel;
  }

  private toEditorSelection(
    uri: vscode.Uri,
    startLine: number,
    endLine: number,
  ): EditorSelection | undefined {
    const rel = this.relativePath(uri);
    return rel ? { path: rel, startLine, endLine } : undefined;
  }

  private computeSelection(editor: vscode.TextEditor | undefined): EditorSelection | null {
    if (!editor) return null;
    const s = editor.selection;
    const lines = selectionToLines({
      startLine: s.start.line,
      startChar: s.start.character,
      endLine: s.end.line,
      endChar: s.end.character,
    });
    return (
      (lines && this.toEditorSelection(editor.document.uri, lines.startLine, lines.endLine)) || null
    );
  }

  private scheduleSelection(): void {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = undefined;
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sel = this.computeSelection(editor);
      const prev = this.lastSelection;
      if (
        prev === sel ||
        (prev &&
          sel &&
          prev.path === sel.path &&
          prev.startLine === sel.startLine &&
          prev.endLine === sel.endLine)
      )
        return;
      this.lastSelection = sel;
      this.send({ type: 'editor.selection', selection: sel });
    }, 150);
  }

  private async openFile(rel: string, line?: number): Promise<void> {
    if (!this.root) return;
    const abs = path.resolve(this.root, rel);
    const r = path.relative(this.root, abs);
    if (r.startsWith('..') || path.isAbsolute(r)) return;
    try {
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: false });
      if (line && line > 0) {
        const l = Math.min(line, editor.document.lineCount) - 1;
        const range = editor.document.lineAt(l).range;
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    } catch (e) {
      this.notify('warn', `Could not open ${rel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Reveals the panel and sends `composer.focus`; queued until the webview has posted `ready`. */
  async addSelectionToChat(selection?: EditorSelection, text?: string): Promise<void> {
    let sel = selection;
    if (!sel) {
      sel = this.computeSelection(vscode.window.activeTextEditor) ?? undefined;
      if (!sel) {
        this.notify('info', 'Select some code in a workspace file first.');
        return;
      }
    }
    await vscode.commands.executeCommand('workbench.view.extension.temper');
    const m: HostMessage = {
      type: 'composer.focus',
      selection: sel,
      mode: 'edit' as ComposerMode,
      ...(text ? { text } : {}),
    };
    if (this.postFn && this.webviewReady) this.send(m);
    else this.queued.push(m);
  }

  /** A view-title command: reveal the panel, then tell the webview to switch views. */
  async navigate(to: 'newChat' | 'history' | 'settings'): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.temper');
    const m: HostMessage = { type: 'nav', to };
    if (this.postFn && this.webviewReady) this.send(m);
    else this.queued.push(m);
  }

  cancel(): void {
    this.controller.cancel();
  }

  undoLast(): Promise<void> {
    return this.controller.undoLast();
  }

  async selectModel(mode: 'agent' | 'inline' = 'agent'): Promise<void> {
    const st = this.connection.state;
    if (!st.connected) {
      await this.connection.check();
    }
    const models = this.connection.state.models;
    if (models.length === 0) {
      this.notify('warn', 'TrueForge reports no models. Add a model provider in TrueForge first.');
      return;
    }
    const view = this.modelView();
    const current = mode === 'agent' ? view.agentModel : view.inlineModel;
    const pick = await vscode.window.showQuickPick(
      this.pricing.enrich(models).map((m) => ({
        label: m.name,
        description: m.name === current ? 'current' : m.provider,
        detail: m.price ? `${formatPrice(m.price)} per 1M tokens` : undefined,
      })),
      { title: `Temper: select the model for ${mode === 'agent' ? 'agent' : 'inline edit'} mode`, placeHolder: current || 'Choose a model' },
    );
    if (!pick) return;
    await vscode.workspace
      .getConfiguration('temper')
      .update(
        mode === 'agent' ? 'models.agentMode' : 'models.inlineEdit',
        pick.label,
        vscode.ConfigurationTarget.Global,
      );
  }

  async openSession(sessionId?: string): Promise<void> {
    const id =
      sessionId ??
      this.controller.active?.turn?.sessionId ??
      this.controller.session?.id ??
      this.lastSessionId;
    const url = id ? `${this.baseUrl}/sessions/${encodeURIComponent(id)}` : this.baseUrl;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  showLog(): void {
    this.out.show(true);
  }

  dispose(): void {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.connection.stop();
    this.controller.dispose();
    this.editorReview.dispose();
    void this.mcp?.stop();
    this.subs.forEach((s) => s.dispose());
    this.status.dispose();
    this.out.dispose();
  }
}
