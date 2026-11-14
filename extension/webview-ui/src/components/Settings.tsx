import { useState } from 'react';
import type { ModelInfo } from '../../../src/shared/types';
import { DEFAULT_SNAPSHOT } from '../../../src/shared/settings';
import type { SandboxState, ServerInfo, SettingsSnapshot } from '../../../src/shared/settings';
import { fmtTokens } from '../../../src/shared/format';
import type { State, SettingsPage } from '../state';
import { postToHost } from '../vscode';
import { FallbackPage } from './Fallback';
import { ProvidersPage } from './Providers';
import {
  Group,
  Help,
  JsonLink,
  NumberField,
  Page,
  SelectField,
  StatusLine,
  Toggle,
  update,
} from './settingsWidgets';
import { Icon, ModelPicker, shortModel } from './ui';

interface SectionDef {
  id: SettingsPage;
  icon: string;
  title: string;
}

export const SECTIONS: SectionDef[] = [
  { id: 'models', icon: 'sparkle', title: 'Models' },
  { id: 'providers', icon: 'plug', title: 'Providers' },
  { id: 'fallback', icon: 'arrow-swap', title: 'Fallback chain' },
  { id: 'context', icon: 'files', title: 'Context' },
  { id: 'safety', icon: 'shield', title: 'Review & safety' },
  { id: 'pricing', icon: 'credit-card', title: 'Pricing' },
  { id: 'sandbox', icon: 'vm', title: 'Sandbox (Daytona)' },
  { id: 'connection', icon: 'server', title: 'Connection' },
];

export const sectionTitle = (id: SettingsPage) => SECTIONS.find((s) => s.id === id)?.title ?? 'Settings';

const REVIEW_LABEL = { endOfRun: 'Review at end of run', perEdit: 'Review each edit' } as const;
const FENCE_LABEL = { flagAndReject: 'on', block: 'blocking', warn: 'warn only', off: 'off' } as const;

function contextSummary(s: SettingsSnapshot): string {
  return s.context.budgetTokens > 0
    ? `${fmtTokens(s.context.budgetTokens)} tokens`
    : `Auto, ${s.context.budgetPercent}% of the window`;
}

function summaries(state: State, s: SettingsSnapshot): Record<SettingsPage, string> {
  const connected = state.connection.trueforge === 'connected';
  const nProviders = state.providers.rows.filter((r) => r.connected).length;
  const failing = state.models.filter((m) => state.chain.includes(m.name) && m.health === 'failing').length;
  return {
    models: state.agentModel
      ? `Agent ${shortModel(state.agentModel)}${state.inlineModel ? `, inline ${shortModel(state.inlineModel)}` : ''}`
      : connected
        ? 'No model chosen'
        : 'Needs TrueForge',
    providers: connected ? `${nProviders} connected` : 'Needs TrueForge',
    fallback: `${state.chain.length} model${state.chain.length === 1 ? '' : 's'}${failing ? `, ${failing} failing` : ''}`,
    context: contextSummary(s),
    safety: `${REVIEW_LABEL[s.review.mode]}, scope fence ${FENCE_LABEL[s.guards.scopeFence]}`,
    pricing: s.pricing.fetch ? 'Prices from models.dev' : 'Bundled prices only',
    sandbox: sandboxSummary(state.sandbox),
    connection: connected ? `Connected${state.server?.version ? `, v${state.server.version}` : ''}` : 'Not connected',
  };
}

export function SettingsHome({ state, onOpen }: { state: State; onOpen: (p: SettingsPage) => void }) {
  const sum = summaries(state, state.settings ?? DEFAULT_SNAPSHOT);
  return (
    <ul className="menu" aria-label="Settings sections">
      {SECTIONS.map((sec) => (
        <li key={sec.id}>
          <button type="button" className="menu-row" onClick={() => onOpen(sec.id)}>
            <Icon name={sec.icon} className="menu-icon" />
            <span className="menu-text">
              <span className="menu-title">{sec.title}</span>
              <span className="ellipsis muted small">{sum[sec.id]}</span>
            </span>
            <Icon name="chevron-right" className="muted" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------ pages ------------------------------ */

function ModelsPage({
  models,
  agentModel,
  inlineModel,
  connected,
  onPick,
}: {
  models: ModelInfo[];
  agentModel: string;
  inlineModel: string;
  connected: boolean;
  onPick: (mode: 'agent' | 'inline', name: string) => void;
}) {
  const pick = (mode: 'agent' | 'inline') => (name: string) => {
    onPick(mode, name);
    postToHost({ type: 'models.pick', mode, name });
  };
  return (
    <Page>
      {!connected && <Help>Connect to TrueForge to choose models.</Help>}
      <Group>
        <div className="field">
          <span className="field-label" id="agent-model-l">
            Agent model
          </span>
          <ModelPicker variant="field" label="Agent model" models={models} value={agentModel} onPick={pick('agent')} />
          <Help>Runs chat and multi-step tasks.</Help>
        </div>
        <div className="field">
          <span className="field-label" id="inline-model-l">
            Inline edit model
          </span>
          <ModelPicker variant="field" label="Inline edit model" models={models} value={inlineModel} onPick={pick('inline')} />
          <Help>Rewrites the selection when you use Edit Selection.</Help>
        </div>
      </Group>
    </Page>
  );
}

function ContextPage({ s }: { s: SettingsSnapshot }) {
  const [draft, setDraft] = useState('');
  const fixed = s.context.budgetTokens > 0;
  const addGlob = () => {
    const v = draft.trim();
    if (!v) return;
    setDraft('');
    if (!s.context.exclude.includes(v)) update('context.exclude', [...s.context.exclude, v]);
  };
  return (
    <Page>
      <Group title="Context budget">
        <Help>How much code Temper packs into each request.</Help>
        <div className="seg" role="group" aria-label="Context budget mode">
          <button
            type="button"
            className="seg-btn"
            aria-pressed={!fixed}
            onClick={() => fixed && update('context.budgetTokens', 0)}
          >
            Auto
          </button>
          <button
            type="button"
            className="seg-btn"
            aria-pressed={fixed}
            onClick={() => !fixed && update('context.budgetTokens', 8000)}
          >
            Fixed tokens
          </button>
        </div>
        {fixed ? (
          <NumberField
            label="Token budget"
            value={s.context.budgetTokens}
            min={1}
            max={10_000_000}
            suffix={`tokens (${fmtTokens(s.context.budgetTokens)})`}
            onCommit={(n) => update('context.budgetTokens', n)}
          />
        ) : (
          <NumberField
            label="Share of the model's window"
            value={s.context.budgetPercent}
            min={1}
            max={90}
            suffix="%"
            help="Auto uses this share of the selected model's context window."
            onCommit={(n) => update('context.budgetPercent', n)}
          />
        )}
      </Group>
      <Group title="Excluded files and folders">
        <Help>Never indexed or sent as context. Globs and folder names.</Help>
        <ul className="chips" aria-label="Excluded globs">
          {s.context.exclude.map((g) => (
            <li key={g} className="chip">
              <code className="ellipsis">{g}</code>
              <button
                type="button"
                className="icon-btn chip-x"
                aria-label={`Remove ${g}`}
                title={`Remove ${g}`}
                onClick={() => update('context.exclude', s.context.exclude.filter((x) => x !== g))}
              >
                <Icon name="close" />
              </button>
            </li>
          ))}
          {s.context.exclude.length === 0 && <li className="muted small">Nothing excluded.</li>}
        </ul>
        <div className="input-row">
          <input
            className="text-input grow"
            aria-label="Add a glob to exclude"
            placeholder="e.g. build/** or *.min.js"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addGlob()}
          />
          <button type="button" className="btn" disabled={!draft.trim()} onClick={addGlob}>
            Add
          </button>
        </div>
      </Group>
    </Page>
  );
}

function SafetyPage({ s }: { s: SettingsSnapshot }) {
  return (
    <Page>
      <Group>
        <SelectField
          label="Review mode"
          value={s.review.mode}
          onChange={(v) => update('review.mode', v)}
          options={[
            { value: 'endOfRun', label: 'At the end of the run', help: 'Review all proposed changes together when the agent finishes. Nothing is written before you accept.' },
            { value: 'perEdit', label: 'Each edit', help: 'Review each edit as the agent proposes it.' },
          ]}
        />
        <SelectField
          label="Scope fence"
          value={s.guards.scopeFence}
          onChange={(v) => update('guards.scopeFence', v)}
          options={[
            { value: 'flagAndReject', label: 'Flag and reject', help: 'Edits outside the requested scope are flagged and rejected by default in review.' },
            { value: 'block', label: 'Block', help: 'Edits outside the requested scope are blocked.' },
            { value: 'warn', label: 'Warn', help: 'Edits outside the requested scope are flagged in review.' },
            { value: 'off', label: 'Off', help: 'The scope fence is disabled.' },
          ]}
        />
        <SelectField
          label="Symbol check"
          value={s.guards.symbolCheck}
          onChange={(v) => update('guards.symbolCheck', v)}
          options={[
            { value: 'bounceThenWarn', label: 'Return once, then warn', help: 'Unresolved symbols go back to the agent once, then show as a warning.' },
            { value: 'bounce', label: 'Always return', help: 'Unresolved symbols always go back to the agent.' },
            { value: 'warn', label: 'Warn', help: 'Unresolved symbols show as warnings in review.' },
            { value: 'off', label: 'Off', help: 'Symbol check is disabled.' },
          ]}
        />
      </Group>
      <Group title="Commands">
        <Help>The agent may only run commands that start with one of these. Anything else is refused.</Help>
        <ul className="chips" aria-label="Allowed commands">
          {s.commands.allowlist.map((c) => (
            <li key={c} className="chip">
              <code className="ellipsis">{c}</code>
            </li>
          ))}
          {s.commands.allowlist.length === 0 && <li className="muted small">No commands allowed.</li>}
        </ul>
        <JsonLink settingKey="commands.allowlist" />
        <Toggle
          label="Run commands in a shadow worktree"
          checked={s.commands.runInShadowWorktree}
          onChange={(v) => update('commands.runInShadowWorktree', v)}
          help="Runs them in a throwaway copy of the workspace that includes the pending changes, not in your working tree."
        />
      </Group>
    </Page>
  );
}

function PricingPage({ s }: { s: SettingsSnapshot }) {
  return (
    <Page>
      <Group>
        <Help>Costs shown in the panel are estimates from per-million-token prices, not a bill.</Help>
        <Toggle
          label="Fetch prices from models.dev"
          checked={s.pricing.fetch}
          onChange={(v) => update('pricing.fetch', v)}
          help="At most once a day. Only the public price index is requested; nothing about your code or usage is sent. When off, Temper uses a small bundled list."
        />
      </Group>
      <Group title="Overrides">
        <Help>
          {s.pricing.overrideCount > 0
            ? `${s.pricing.overrideCount} model${s.pricing.overrideCount === 1 ? '' : 's'} with your own price. Overrides win over models.dev.`
            : 'No overrides. Set your own USD per 1M tokens for any model; it wins over models.dev.'}
        </Help>
        <JsonLink settingKey="pricing.overrides" />
      </Group>
    </Page>
  );
}

function sandboxSummary(sb: SandboxState): string {
  if (!sb.loaded) return 'Optional';
  if (!sb.connected) return 'Not connected';
  if (sb.ready) return 'Ready';
  return sb.environment?.status === 'failed' ? 'Setup failed' : 'Preparing';
}

function SandboxPage({ sb, connected }: { sb: SandboxState; connected: boolean }) {
  const r = sb.result;
  return (
    <Page>
      <Group>
        <Help>
          Optional. Temper&apos;s agent does not use the sandbox by default; Tasks run on your local workspace.
        </Help>
        {!connected ? (
          <Help>Connect to TrueForge to manage the sandbox.</Help>
        ) : (
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              {!sb.loaded ? (
                <span className="muted">Checking…</span>
              ) : sb.error ? (
                <StatusLine tone="bad">Could not load: {sb.error}</StatusLine>
              ) : sb.connected && sb.ready ? (
                <StatusLine tone="ok">Ready (Daytona)</StatusLine>
              ) : sb.connected && sb.environment?.status === 'failed' ? (
                <>
                  <StatusLine tone="bad">Key saved, but the sandbox image failed to build</StatusLine>
                  {sb.environment.reason && <div className="muted small">{sb.environment.reason}</div>}
                  {/permission/i.test(sb.environment.reason ?? '') && (
                    <div className="muted small">
                      Create a Daytona key with write:sandboxes, write:snapshots and delete:snapshots, then use Replace
                      key.
                    </div>
                  )}
                </>
              ) : sb.connected ? (
                <StatusLine tone="muted">Key saved, preparing the sandbox image…</StatusLine>
              ) : (
                <StatusLine tone="muted">Not connected</StatusLine>
              )}
            </dd>
            {sb.loaded && sb.skills && (
              <>
                <dt>Skills</dt>
                <dd>
                  {sb.skills.enabled ? (
                    <StatusLine tone="ok">Available</StatusLine>
                  ) : (
                    <>
                      <StatusLine tone="muted">Not available</StatusLine>
                      {sb.skills.reason && <div className="muted small">{sb.skills.reason}</div>}
                    </>
                  )}
                </dd>
              </>
            )}
          </dl>
        )}
        {connected && (
          <div className="btn-row">
            <button
              type="button"
              className={`btn${sb.connected ? '' : ' btn-primary'}`}
              disabled={sb.busy}
              onClick={() => postToHost({ type: 'sandbox.connect' })}
            >
              <Icon name={sb.connected ? 'key' : 'plug'} /> {sb.connected ? 'Replace key' : 'Connect Daytona'}
            </button>
            <button type="button" className="btn" disabled={sb.busy} onClick={() => postToHost({ type: 'settings.refresh' })}>
              <Icon name="refresh" /> Refresh
            </button>
          </div>
        )}
        {r && (
          <p className={`small ${r.level === 'error' ? 'err-text' : 'muted'}`} role="status">
            <Icon name={r.level === 'error' ? 'warning' : 'info'} /> {r.text}
          </p>
        )}
        <Help>The key is typed into a VS Code prompt and sent to TrueForge. Temper does not store it.</Help>
      </Group>
    </Page>
  );
}

function ConnectionPage({ state, server }: { state: State; server?: ServerInfo }) {
  const c = state.connection;
  const up = c.trueforge === 'connected';
  return (
    <Page>
      <Group>
        <dl className="facts">
          <dt>Status</dt>
          <dd>
            {up ? (
              <StatusLine tone="ok">Connected</StatusLine>
            ) : c.trueforge === 'unknown' ? (
              <span className="muted">Connecting…</span>
            ) : (
              <>
                <StatusLine tone="bad">Not connected</StatusLine>
                {c.detail && <div className="muted small">{c.detail}</div>}
              </>
            )}
          </dd>
          <dt>URL</dt>
          <dd>
            <code className="wrap">{server?.baseUrl ?? 'http://127.0.0.1:8790'}</code>
          </dd>
          <dt>Version</dt>
          <dd>{server?.version ? `v${server.version}` : <span className="muted">unknown</span>}</dd>
        </dl>
        <div className="btn-row">
          {!up && (
            <button type="button" className="btn btn-primary" onClick={() => postToHost({ type: 'server.start' })}>
              <Icon name="play" /> Start TrueForge
            </button>
          )}
          <button type="button" className="btn" onClick={() => postToHost({ type: 'connection.retry' })}>
            <Icon name="refresh" /> Retry
          </button>
          <button type="button" className="btn" disabled={!up} onClick={() => postToHost({ type: 'trueforge.open' })}>
            <Icon name="link-external" /> Open TrueForge
          </button>
        </div>
        <JsonLink settingKey="trueforge.baseUrl" label="Change the URL in settings.json" />
      </Group>
    </Page>
  );
}

export function SettingsPageView({
  page,
  state,
  onChain,
  onPick,
}: {
  page: SettingsPage;
  state: State;
  onChain: (c: string[]) => void;
  onPick: (mode: 'agent' | 'inline', name: string) => void;
}) {
  const s = state.settings ?? DEFAULT_SNAPSHOT;
  const connected = state.connection.trueforge === 'connected';
  switch (page) {
    case 'models':
      return (
        <ModelsPage
          models={state.models}
          agentModel={state.agentModel}
          inlineModel={state.inlineModel}
          connected={connected}
          onPick={onPick}
        />
      );
    case 'providers':
      return <ProvidersPage state={state.providers} connected={connected} hasModels={state.models.length > 0} />;
    case 'fallback':
      return <FallbackPage models={state.models} chain={state.chain} settings={s} connected={connected} onChain={onChain} />;
    case 'context':
      return <ContextPage s={s} />;
    case 'safety':
      return <SafetyPage s={s} />;
    case 'pricing':
      return <PricingPage s={s} />;
    case 'sandbox':
      return <SandboxPage sb={state.sandbox} connected={connected} />;
    case 'connection':
      return <ConnectionPage state={state} server={state.server} />;
  }
}
