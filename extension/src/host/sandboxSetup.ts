// Daytona sandbox setup. The key is typed into a host-side password box, sent once to TrueForge and never
// stored, logged or shown by Temper. Temper's agents do not use the sandbox (config.sandbox stays off).
import * as vscode from 'vscode';
import { buildSandboxManifest, SandboxAdmin } from '../providers/sandbox';
import { safeError } from '../providers/scrub';
import type { HostMessage } from '../shared/messages';
import type { SandboxState, ServerInfo } from '../shared/settings';

export interface SandboxSetupDeps {
  getBaseUrl(): string;
  post(m: HostMessage): void;
  log(line: string): void;
}

export class SandboxSetup {
  private state: SandboxState = { loaded: false, connected: false, busy: false };
  private manifest: unknown;

  constructor(private readonly deps: SandboxSetupDeps) {}

  private admin(secrets: string[] = []): SandboxAdmin {
    return new SandboxAdmin(this.deps.getBaseUrl(), undefined, () => secrets);
  }

  private publish(): void {
    this.deps.post({ type: 'sandbox.state', state: this.state });
  }

  /** Reload sandbox status and the TrueForge version. Errors surface as state; TrueForge being down is covered by the banner. */
  async refresh(): Promise<void> {
    const admin = this.admin();
    const [version, status] = await Promise.all([
      admin.version(),
      admin.status().then(
        (s) => ({ s }),
        (e: unknown) => ({ e: safeError(e) }),
      ),
    ]);
    const server: ServerInfo = { baseUrl: this.deps.getBaseUrl(), ...(version ? { version } : {}) };
    this.deps.post({ type: 'server.info', server });
    if ('s' in status) {
      this.manifest = status.s.manifest;
      this.state = {
        ...this.state,
        loaded: true,
        connected: status.s.connected,
        ready: status.s.ready,
        environment: status.s.environment,
        skills: status.s.skills,
        error: undefined,
      };
    } else {
      this.state = { ...this.state, loaded: true, error: status.e };
    }
    this.publish();
  }

  /** Connect, or replace the key of, the Daytona sandbox provider. */
  async connect(): Promise<void> {
    const replacing = this.state.connected;
    const k = await vscode.window.showInputBox({
      title: replacing ? 'Replace Daytona API key' : 'Connect Daytona',
      prompt: 'Daytona API key. It is sent to TrueForge and is not stored by Temper.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'An API key is required.'),
    });
    if (k === undefined) return;
    const key = k.trim();
    this.state = { ...this.state, busy: true, result: undefined };
    this.publish();
    let result: SandboxState['result'];
    try {
      await this.admin([key]).put(buildSandboxManifest(key, this.manifest));
      result = { level: 'info', text: replacing ? 'Daytona key replaced.' : 'Daytona connected.' };
    } catch (e) {
      const msg = safeError(e, [key]);
      this.deps.log(`sandbox: ${msg}`);
      result = { level: 'error', text: msg };
    }
    await this.refresh();
    this.state = { ...this.state, busy: false, result };
    this.publish();
  }
}
