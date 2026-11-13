// In-editor provider setup (Cline/Roo style). Keys are typed into host-side VS Code input boxes, held in
// memory only for the call, sent to the provider's model-LIST endpoint (discovery) and to TrueForge, and
// never stored, logged or shown. Temper makes no inference call to any provider.
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ProviderAdmin } from '../providers/admin';
import type { ConfiguredProvider } from '../providers/admin';
import { COMPATIBLE_PRESETS, defForConfigured, findDef } from '../providers/catalog';
import type { DiscoveredModel, ProviderDef } from '../providers/catalog';
import { discoverModels } from '../providers/discovery';
import {
  buildManifest,
  describeModel,
  REDACTED_KEY,
  suggestModels,
  toResourceName,
} from '../providers/manifest';
import { buildRows, compareServed } from '../providers/rows';
import { safeError } from '../providers/scrub';
import type { HostMessage } from '../shared/messages';
import type { ProviderPanelState, ProviderResult } from '../shared/providers';

export const TRUEFORGE_VERSION = '0.185.0';
export const TRUEFORGE_NPX = `npx @truefoundry/trueforge@${TRUEFORGE_VERSION}`;

export interface ProviderSetupDeps {
  extensionUri: vscode.Uri;
  getBaseUrl(): string;
  post(m: HostMessage): void;
  log(line: string): void;
  /** Re-check the TrueForge connection so the model list refreshes. */
  refreshConnection(): Promise<void>;
}

const isHttpUrl = (s: string) => /^https?:\/\/[^\s/]+/i.test(s);

export class ProviderSetup {
  private rows: ProviderPanelState['rows'] = [];
  private busy: string | null = null;
  private result: ProviderResult | undefined;
  private error: string | undefined;

  constructor(private readonly deps: ProviderSetupDeps) {}

  private admin(secrets: string[] = []): ProviderAdmin {
    return new ProviderAdmin(this.deps.getBaseUrl(), undefined, () => secrets);
  }

  private publish(): void {
    this.deps.post({
      type: 'providers.state',
      state: { rows: this.rows, busy: this.busy, result: this.result, error: this.error },
    });
  }

  private finish(
    scope: string,
    level: ProviderResult['level'],
    text: string,
    command?: string,
  ): void {
    this.result = { scope, level, text, ...(command ? { command } : {}) };
    this.busy = null;
    this.publish();
  }

  /** Reload the provider list from TrueForge. Silent when TrueForge is down (the connection state covers that). */
  async refresh(): Promise<void> {
    const admin = this.admin();
    try {
      const [configured, served] = await Promise.all([admin.list(), admin.servedModelNames()]);
      this.rows = buildRows(configured, served);
      this.error = undefined;
    } catch (e) {
      this.rows = buildRows([], []);
      this.error = safeError(e);
    }
    this.publish();
  }

  private async changed(): Promise<void> {
    await this.deps.refreshConnection();
    await this.refresh();
  }

  /* ----------------------------- add / edit ----------------------------- */

  /** `id` is a provider def id, or 'compatible-pick' to choose among the OpenAI-compatible presets. */
  async add(id: string): Promise<void> {
    let def: ProviderDef | undefined;
    if (id === 'compatible-pick') {
      const pick = await vscode.window.showQuickPick(
        COMPATIBLE_PRESETS.map((d) => ({ label: d.label, description: d.baseUrl, def: d })),
        {
          title: 'Add an OpenAI-compatible provider',
          placeHolder: 'Ollama, LM Studio, OpenRouter, Groq or any /v1 endpoint',
        },
      );
      def = pick?.def;
    } else {
      def = findDef(id);
    }
    if (!def) return;
    await this.configure(def, undefined);
  }

  async edit(name: string): Promise<void> {
    let existing: ConfiguredProvider | undefined;
    try {
      existing = (await this.admin().list()).find((p) => p.name === name);
    } catch (e) {
      this.finish(name, 'error', safeError(e));
      return;
    }
    if (!existing) {
      await this.add(findDef(name)?.id ?? name);
      return;
    }
    await this.configure(defForConfigured(name, existing.manifest.type), existing);
  }

  private async configure(
    def: ProviderDef,
    existing: ConfiguredProvider | undefined,
  ): Promise<void> {
    const scope = def.name || def.id;
    let key = '';
    this.busy = scope;
    this.result = undefined;
    this.publish();
    try {
      // 1. Name + endpoint (OpenAI-compatible only).
      let name = existing?.name ?? def.name;
      let baseUrl = existing?.manifest.base_url ?? def.baseUrl;
      if (def.kind === 'custom') {
        if (!existing && def.askBaseUrl) {
          const n = await vscode.window.showInputBox({
            title: 'Provider name',
            prompt:
              'A short name for this provider (lowercase letters, digits, hyphens). Models appear as "name/model".',
            validateInput: (v) =>
              toResourceName(v) ? undefined : 'Use letters, digits or hyphens.',
            ignoreFocusOut: true,
          });
          if (n === undefined) return this.cancelled();
          name = toResourceName(n);
        }
        if (def.askBaseUrl || existing) {
          const b = await vscode.window.showInputBox({
            title: `${name || 'Provider'} base URL`,
            prompt: 'OpenAI-compatible base URL, usually ending in /v1',
            value: baseUrl ?? 'http://127.0.0.1:8000/v1',
            validateInput: (v) => (isHttpUrl(v.trim()) ? undefined : 'Enter an http(s) URL.'),
            ignoreFocusOut: true,
          });
          if (b === undefined) return this.cancelled();
          baseUrl = b.trim();
        }
      }

      // 2. Key: host-side password box. Never passes through the webview.
      const keepable = !!existing;
      const k = await vscode.window.showInputBox({
        title: `${existing ? 'Edit' : 'Add'} ${def.label}`,
        prompt: keepable
          ? 'API key. Leave empty to keep the key already stored in TrueForge. Temper does not store keys.'
          : def.keyOptional
            ? 'API key (optional for local servers; leave empty if the server needs none). Temper does not store keys.'
            : 'API key. It is sent to the provider to list models and to TrueForge, and is not stored by Temper.',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) =>
          !keepable && !def.keyOptional && !v.trim() ? 'An API key is required.' : undefined,
      });
      if (k === undefined) return this.cancelled();
      key = k.trim();

      const admin = this.admin([key]);
      const catalog = def.kind === 'catalog' ? await admin.catalogModels(def.type) : [];
      const keepNames = new Map((existing?.manifest.models ?? []).map((m) => [m.model_id, m.name]));
      const current: DiscoveredModel[] = (existing?.manifest.models ?? []).map((m) => ({
        id: m.model_id,
        context:
          typeof m.properties?.context_length === 'number'
            ? m.properties.context_length
            : undefined,
        maxOutput:
          typeof m.properties?.max_output_tokens === 'number'
            ? m.properties.max_output_tokens
            : undefined,
      }));

      // 3. Discover models (list endpoint only). With a kept key we cannot list; fall back to the current set.
      let found: DiscoveredModel[] = [];
      let note = '';
      const canList = !!key || !!def.keyOptional;
      if (canList) {
        try {
          found = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Listing ${def.label} models`,
            },
            () => discoverModels({ def, key, baseUrl: baseUrl ?? def.listBase }),
          );
        } catch (e) {
          note = safeError(e, [key]);
          this.deps.log(`provider ${scope}: model listing failed: ${note}`);
        }
      }
      if (found.length === 0) {
        found = catalog.map((c) => ({
          id: c.model_id,
          context:
            typeof c.properties?.context_length === 'number'
              ? c.properties.context_length
              : undefined,
          maxOutput:
            typeof c.properties?.max_output_tokens === 'number'
              ? c.properties.max_output_tokens
              : undefined,
        }));
      }
      const have = new Set(found.map((m) => m.id));
      for (const c of current) if (!have.has(c.id)) found.push(c);
      if (found.length === 0) {
        const manual = await vscode.window.showInputBox({
          title: `${def.label} models`,
          prompt: `${note || 'No models were found.'} Enter model ids, comma separated.`,
          ignoreFocusOut: true,
        });
        if (!manual) return this.cancelled();
        found = manual
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((id) => ({ id }));
      } else if (note) {
        void vscode.window.showWarningMessage(
          `Could not list ${def.label} models (${note}). Showing preset and current models.`,
        );
      }

      // 4. Multi-pick models.
      const pre = existing
        ? new Set(current.map((m) => m.id))
        : suggestModels(found, new Set(catalog.map((c) => c.model_id)));
      const picked = await vscode.window.showQuickPick(
        found.map((m) => ({ label: m.id, ...describeModel(m), picked: pre.has(m.id), model: m })),
        {
          title: `${def.label}: choose models for TrueForge`,
          placeHolder: 'Tool-capable models are preselected. Space toggles, Enter confirms.',
          canPickMany: true,
          matchOnDescription: true,
          ignoreFocusOut: true,
        },
      );
      if (!picked) return this.cancelled();
      if (picked.length === 0) {
        this.finish(scope, 'error', 'No models selected, nothing was saved.');
        return;
      }

      // 5. Build the manifest and upsert into TrueForge.
      const manifest = buildManifest({
        def,
        apiKey: key || (existing ? REDACTED_KEY : ''),
        baseUrl,
        name,
        models: picked.map((p) => p.model),
        catalog,
        keepNames,
      });
      await admin.upsert(manifest);
      await this.changed();
      this.finish(
        scope,
        'info',
        `${existing ? 'Updated' : 'Connected'} ${def.label}: ${picked.length} model${picked.length === 1 ? '' : 's'} saved in TrueForge.`,
      );
    } catch (e) {
      const msg = safeError(e, [key]);
      this.deps.log(`provider ${scope}: ${msg}`);
      this.finish(scope, 'error', msg);
    }
  }

  private cancelled(): void {
    this.busy = null;
    this.publish();
  }

  /* ------------------------------- check -------------------------------- */

  /**
   * Two things are verified and the result says which: (1) TrueForge serves the provider's configured models
   * (`GET /models`); (2) if the user pastes the key now (or the server needs none), the provider's model list
   * accepts it. Temper has no stored key, so (2) is opt-in.
   */
  async check(name: string): Promise<void> {
    let key = '';
    this.busy = name;
    this.result = undefined;
    this.publish();
    try {
      const admin = this.admin();
      const [configured, served] = await Promise.all([admin.list(), admin.servedModelNames()]);
      const p = configured.find((c) => c.name === name);
      if (!p) {
        this.finish(name, 'error', 'This provider is not configured in TrueForge.');
        return;
      }
      const cmp = compareServed(p, served);
      const def = defForConfigured(name, p.manifest.type);
      const lines = [
        cmp.missing.length === 0
          ? `TrueForge serves all ${cmp.expected} configured model${cmp.expected === 1 ? '' : 's'}.`
          : `TrueForge serves ${cmp.served} of ${cmp.expected} configured models (missing: ${cmp.missing.slice(0, 3).join(', ')}).`,
      ];
      let level: ProviderResult['level'] = cmp.missing.length === 0 ? 'info' : 'error';

      let verify = def.keyOptional === true && !!p.manifest.base_url;
      if (!verify) {
        const k = await vscode.window.showInputBox({
          title: `Check ${def.label}`,
          prompt:
            'Optional: paste the key to verify it against the provider model list. Leave empty to skip. It is not stored.',
          password: true,
          ignoreFocusOut: true,
        });
        if (k === undefined) return this.cancelled();
        key = k.trim();
        verify = !!key;
      }
      if (verify) {
        try {
          const list = await discoverModels({
            def,
            key,
            baseUrl: p.manifest.base_url ?? def.listBase,
          });
          lines.push(
            `${new URL(p.manifest.base_url ?? def.listBase ?? 'https://provider').host} accepted the key and lists ${list.length} models.`,
          );
        } catch (e) {
          level = 'error';
          lines.push(`Provider model list failed: ${safeError(e, [key])}`);
        }
      } else {
        lines.push('The key was not verified with the provider.');
      }
      lines.push('No model was called.');
      this.finish(name, level, lines.join(' '));
    } catch (e) {
      this.finish(name, 'error', safeError(e, [key]));
    }
  }

  /* ------------------------------- remove ------------------------------- */

  async remove(name: string): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      `Remove "${name}" from TrueForge? Its models stop working and its stored key is deleted.`,
      { modal: true },
      'Remove',
    );
    if (ok !== 'Remove') return;
    this.busy = name;
    this.result = undefined;
    this.publish();
    try {
      await this.admin().remove(name);
      await this.changed();
      this.finish(name, 'info', `Removed ${name} from TrueForge.`);
    } catch (e) {
      this.finish(name, 'error', safeError(e));
    }
  }

  /* ------------------------------- server ------------------------------- */

  private findStartScript(): string | undefined {
    const file = process.platform === 'win32' ? 'start-trueforge.ps1' : 'start-trueforge.sh';
    const roots = [
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      path.resolve(this.deps.extensionUri.fsPath, '..'),
    ];
    for (const r of roots) {
      const p = path.join(r, 'scripts', file);
      if (existsSync(p)) return p;
    }
    return undefined;
  }

  async startServer(): Promise<void> {
    const script = this.findStartScript();
    if (!script) {
      await vscode.env.clipboard.writeText(TRUEFORGE_NPX);
      this.finish(
        'server',
        'info',
        'The Temper start script was not found in this workspace. The command below was copied; run it in a terminal.',
        TRUEFORGE_NPX,
      );
      return;
    }
    const win = process.platform === 'win32';
    const term = vscode.window.createTerminal({
      name: 'TrueForge',
      cwd: path.dirname(path.dirname(script)),
      ...(win ? { shellPath: 'powershell.exe' } : {}),
    });
    term.show(true);
    term.sendText(win ? `& '${script}'` : `bash '${script}'`);
    this.finish(
      'server',
      'info',
      'Starting TrueForge in a terminal. The first start downloads the package and can take a minute. Press Retry when it is ready.',
    );
  }

  async copyCommand(): Promise<void> {
    await vscode.env.clipboard.writeText(TRUEFORGE_NPX);
    this.finish('server', 'info', 'Copied.', TRUEFORGE_NPX);
  }
}
