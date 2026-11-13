// TrueForge connection: health polling, MCP server registration, model list. No vscode imports;
// the extension host (temperHost.ts) turns its events into webview messages and the status bar.
import type { ModelHealth, ModelInfo } from '../shared/types';
import type { AgentSpec } from '../trueforge';
import { MCP_SERVER_NAME } from './specs';

export const MCP_DESCRIPTION =
  'Temper editor tools: read, search, symbols, context, staged edits, review-gated apply, allowlisted commands.';

export interface ConnectionClient {
  health(): Promise<{ ok: boolean; error?: string }>;
  listModels(): Promise<ModelInfo[]>;
  ensureMcpServer(name: string, url: string, description: string): Promise<void>;
  upsertAgent?(name: string, description: string, manifest: AgentSpec): Promise<void>;
}

export interface AgentDef {
  name: string;
  description: string;
  manifest: AgentSpec;
}

export interface ModelView {
  models: ModelInfo[];
  chain: string[];
  agentModel: string;
  inlineModel: string;
}

export interface ModelPrefs {
  chain: string[];
  agentMode: string;
  inlineEdit: string;
}

/** Chain = configured chain filtered to available models; if that is empty, every available model. */
export function computeModelView(
  available: ModelInfo[],
  prefs: ModelPrefs,
  health: Record<string, { health: ModelHealth; lastError?: string }> = {},
): ModelView {
  const names = new Set(available.map((m) => m.name));
  let chain = prefs.chain.filter((n, i, a) => names.has(n) && a.indexOf(n) === i);
  if (chain.length === 0) chain = available.map((m) => m.name);
  const pick = (want: string) => (want && names.has(want) ? want : (chain[0] ?? ''));
  const models = available.map((m) => ({ ...m, ...(health[m.name] ?? {}) }));
  return { models, chain, agentModel: pick(prefs.agentMode), inlineModel: pick(prefs.inlineEdit) };
}

export interface ConnectionState {
  connected: boolean;
  detail?: string;
  models: ModelInfo[];
}

export class TrueForgeConnection {
  private timer: ReturnType<typeof setInterval> | undefined;
  private mcpUrl: string | undefined;
  private registeredFor: string | undefined;
  private checking = false;
  private agentProvider: (() => Promise<AgentDef[]>) | undefined;
  private agentsSig: string | undefined;
  private agentWarned = false;
  onLog: ((line: string) => void) | undefined;
  state: ConnectionState = { connected: false, models: [] };
  private readonly listeners = new Set<(s: ConnectionState) => void>();

  constructor(
    private client: ConnectionClient,
    private readonly pollMs = 10_000,
  ) {}

  onChange(fn: (s: ConnectionState) => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => void this.listeners.delete(fn) };
  }

  /** Swap the client (base URL changed) and re-check immediately. */
  setClient(client: ConnectionClient): Promise<void> {
    this.client = client;
    this.registeredFor = undefined;
    this.agentsSig = undefined;
    return this.check();
  }

  /** Supplies the named agents to register (with their current models) whenever TrueForge is reachable. */
  setAgentProvider(fn: () => Promise<AgentDef[]>): void {
    this.agentProvider = fn;
    this.agentsSig = undefined;
  }

  setMcpUrl(url: string): void {
    this.mcpUrl = url;
    this.registeredFor = undefined;
  }

  start(): Promise<void> {
    this.stop();
    this.timer = setInterval(() => void this.check(), this.pollMs);
    return this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One health check; (re)registers the MCP server and refreshes models whenever we (re)connect. */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const h = await this.client.health();
      if (!h.ok) {
        this.set({ connected: false, detail: h.error ?? 'TrueForge is not responding', models: this.state.models });
        return;
      }
      let detail: string | undefined;
      if (this.mcpUrl && this.registeredFor !== this.mcpUrl) {
        try {
          await this.client.ensureMcpServer(MCP_SERVER_NAME, this.mcpUrl, MCP_DESCRIPTION);
          this.registeredFor = this.mcpUrl;
        } catch (e) {
          detail = `Could not register the Temper tools with TrueForge: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      let models = this.state.models;
      try {
        models = await this.client.listModels();
      } catch (e) {
        detail ??= `Could not list models: ${e instanceof Error ? e.message : String(e)}`;
      }
      await this.syncAgents();
      this.set({ connected: true, detail, models });
    } finally {
      this.checking = false;
    }
  }

  /** Upsert the named agents when connecting or when a mode's model pick changes. Never fails the check. */
  private async syncAgents(): Promise<void> {
    const upsert = this.client.upsertAgent?.bind(this.client);
    if (!this.agentProvider || !upsert) return;
    try {
      const defs = await this.agentProvider();
      const sig = JSON.stringify(defs);
      if (sig === this.agentsSig) return;
      for (const d of defs) await upsert(d.name, d.description, d.manifest);
      this.agentsSig = sig;
    } catch (e) {
      if (!this.agentWarned) {
        this.agentWarned = true;
        this.onLog?.(`Could not register the Temper agents in TrueForge (${e instanceof Error ? e.message : String(e)}); sessions will use inline specs.`);
      }
    }
  }

  private set(next: ConnectionState): void {
    const prev = this.state;
    this.state = next;
    const same =
      prev.connected === next.connected &&
      prev.detail === next.detail &&
      prev.models.length === next.models.length &&
      prev.models.every((m, i) => m.name === next.models[i]?.name);
    if (!same) for (const l of [...this.listeners]) l(next);
  }
}
