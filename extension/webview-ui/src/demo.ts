// Dev harness: mocks the extension host when running outside VS Code.
// Replays a scripted run so every UI section is visible (`npm run dev`).
import type { FileChange, Hunk, LedgerEntry, LedgerSnapshot, ModelInfo, RunEvent } from '../../src/shared/types';
import type { EditorSelection } from '../../src/shared/messages';
import type { SessionSummary, TranscriptTurn } from '../../src/shared/sessions';
import type { HostMessage, Mention, WebviewMessage } from './vscode';
import { setMockHandler } from './vscode';
import { DEFAULT_SNAPSHOT, validateSetting } from '../../src/shared/settings';
import type { SandboxState, SettingsSnapshot } from '../../src/shared/settings';
import { bindProviders, providersHandle } from './demoProviders';

const send = (m: HostMessage) => window.postMessage(m, '*');
const ev = (event: RunEvent) => send({ type: 'run.event', event });

const MODELS: ModelInfo[] = [
  { name: 'anthropic/claude-sonnet', provider: 'anthropic', health: 'failing', lastError: '[Model Error] Request failed (429)', contextLength: 1_000_000, price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
  { name: 'openai/gpt-5', provider: 'openai', health: 'ok', contextLength: 400_000, price: { input: 1.25, output: 10, cacheRead: 0.125 } },
  { name: 'google/gemini-pro', provider: 'google', health: 'unknown', contextLength: 1_048_576 },
  { name: 'local/qwen-coder', provider: 'local', health: 'ok', contextLength: 32_768, price: { input: 0, output: 0 } },
];
let chain = ['anthropic/claude-sonnet', 'openai/gpt-5', 'google/gemini-pro'];
let agentModel = 'anthropic/claude-sonnet';
let inlineModel = 'local/qwen-coder';
let runN = 0;
let runId = 'run-0';
const SEL: EditorSelection = { path: 'src/flask/helpers.py', startLine: 42, endLine: 58 };
let selOn = true;
let settings: SettingsSnapshot = structuredClone(DEFAULT_SNAPSHOT);
let sandbox: SandboxState = {
  loaded: true,
  connected: false,
  skills: { enabled: false, reason: 'Skills run in a sandbox, which is not configured.' },
  busy: false,
};
const sendSettings = () => send({ type: 'settings.state', settings });
const sendSandbox = () => send({ type: 'sandbox.state', state: sandbox });
const sendServer = () => send({ type: 'server.info', server: { baseUrl: 'http://127.0.0.1:8790', version: '0.185.0' } });

/** Mirrors the host's `settings.update`: same allowlist and validation, applied to a local snapshot. */
function applySetting(key: string, value: unknown): void {
  const c = validateSetting(key, value);
  if (!c.ok) return console.warn('[temper dev] refused setting', key, c.reason);
  const v = c.value as never;
  const set: Record<string, () => void> = {
    'models.fallback.enabled': () => (settings.fallback.enabled = v),
    'models.fallback.retries': () => (settings.fallback.retries = v),
    'context.budgetTokens': () => (settings.context.budgetTokens = v),
    'context.budgetPercent': () => (settings.context.budgetPercent = v),
    'context.exclude': () => (settings.context.exclude = v),
    'review.mode': () => (settings.review.mode = v),
    'guards.scopeFence': () => (settings.guards.scopeFence = v),
    'guards.symbolCheck': () => (settings.guards.symbolCheck = v),
    'commands.runInShadowWorktree': () => (settings.commands.runInShadowWorktree = v),
    'pricing.fetch': () => (settings.pricing.fetch = v),
  };
  set[key]?.();
  settings = structuredClone(settings);
  sendSettings();
}

const sendModels = () => send({ type: 'models.update', models: MODELS, chain, agentModel, inlineModel });

const reasons = (r: LedgerEntry['reasons']) => r;
let entries: LedgerEntry[] = [
  { id: 'src/flask/helpers.py#get_debug_flag', path: 'src/flask/helpers.py', symbol: 'get_debug_flag', score: 9.1, tokens: 640, representation: 'full', included: true, pinned: true,
    reasons: reasons([{ reason: 'mention', detail: '@get_debug_flag' }, { reason: 'pinned', detail: 'Pinned by you' }]) },
  { id: 'src/flask/config.py', path: 'src/flask/config.py', score: 6.4, tokens: 2100, representation: 'outline', included: true,
    reasons: [{ reason: 'graph', detail: 'imported by helpers.py' }, { reason: 'keyword', detail: 'BM25: "debug flag"' }] },
  { id: 'tests/test_helpers.py', path: 'tests/test_helpers.py', score: 5.2, tokens: 1500, representation: 'snippet', startLine: 40, endLine: 88, included: true,
    reasons: [{ reason: 'testPair', detail: 'tests src/flask/helpers.py' }] },
  { id: 'docs/config.rst', path: 'docs/config.rst', score: 3.0, tokens: 3800, representation: 'full', included: false,
    reasons: [{ reason: 'docsPair', detail: 'documents DEBUG setting' }] },
  { id: 'src/flask/cli.py#FlaskGroup', path: 'src/flask/cli.py', symbol: 'FlaskGroup', startLine: 530, endLine: 610, score: 4.4, tokens: 1800, representation: 'snippet', included: true,
    reasons: [{ reason: 'symbol', detail: 'defines FlaskGroup' }, { reason: 'selection', detail: 'Inside your selection' }] },
  { id: 'src/flask/__init__.py', path: 'src/flask/__init__.py', score: 2.0, tokens: 700, representation: 'outline', included: true,
    reasons: [{ reason: 'graph', detail: 'package entry point' }] },
  { id: 'tests/conftest.py', path: 'tests/conftest.py', score: 1.8, tokens: 900, representation: 'outline', included: true,
    reasons: [{ reason: 'testPair', detail: 'fixtures used by test_helpers.py' }] },
  { id: 'src/flask/app.py', path: 'src/flask/app.py', score: 2.1, tokens: 9400, representation: 'outline', included: false,
    reasons: [{ reason: 'graph', detail: 'calls get_debug_flag' }, { reason: 'agent', detail: 'read via read_file' }] },
];
let budget = 8000;
const snapshot = (): LedgerSnapshot => ({
  runId,
  task: 'Make get_debug_flag also honour FLASK_DEBUG=0',
  budgetTokens: budget,
  usedTokens: entries.filter((e) => e.included && !e.evicted).reduce((a, e) => a + e.tokens, 0),
  candidates: entries.length + 12,
  entries,
});

const hunk = (path: string, i: number, over: Partial<Hunk>): Hunk => ({
  id: `${path}#${i}`, path, oldStart: 10, oldLines: 4, newStart: 10, newLines: 6,
  header: '@@ -10,4 +10,6 @@ def get_debug_flag', flags: [], decision: 'pending',
  lines: [
    ' def get_debug_flag() -> bool:',
    '     val = os.environ.get("FLASK_DEBUG")',
    '-    return bool(val and val.lower() not in {"0", "false", "no"})',
    '+    if val is None:',
    '+        return False',
    '+    return val.lower() not in {"0", "false", "no"}',
  ],
  ...over,
});
const changes: FileChange[] = [
  { path: 'src/flask/helpers.py', kind: 'modify', original: '', proposed: '', hunks: [
    hunk('src/flask/helpers.py', 0, { rationale: 'Treat unset FLASK_DEBUG explicitly instead of via truthiness.' }),
    hunk('src/flask/helpers.py', 1, {
      header: '@@ -52,3 +54,4 @@ def get_load_dotenv', rationale: 'Also touched the dotenv loader.',
      lines: [' def get_load_dotenv(default=True):', '-    val = os.environ.get("FLASK_SKIP_DOTENV")', '+    val = os.environ.get("FLASK_SKIP_DOTENV", "")', '     return not val'],
      flags: [{ kind: 'outsidePlan', detail: 'Not part of the approved plan' }, { kind: 'outsideSelection', detail: 'Outside your selection' }],
    }),
  ] },
  { path: 'src/flask/config.py', kind: 'modify', original: '', proposed: '', hunks: [
    hunk('src/flask/config.py', 0, {
      header: '@@ -30,2 +30,3 @@ class Config', rationale: 'Use the new helper.',
      lines: [' class Config(dict):', '-    debug = get_debug()', '+    debug = get_debug_flg()'],
      flags: [{ kind: 'unknownSymbol', symbols: ['get_debug_flg'], suggestions: { get_debug_flg: ['get_debug_flag'] } }],
    }),
  ] },
  { path: 'tests/test_debug_flag.py', kind: 'create', original: '', proposed: '', hunks: [
    hunk('tests/test_debug_flag.py', 0, {
      header: '@@ -0,0 +1,3 @@', oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, rationale: 'Regression test for FLASK_DEBUG=0.',
      lines: ['+def test_debug_zero(monkeypatch):', '+    monkeypatch.setenv("FLASK_DEBUG", "0")', '+    assert not get_debug_flag()'],
    }),
  ] },
];

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const SESSIONS: SessionSummary[] = [
  {
    id: 's-demo-1',
    title: 'Make get_debug_flag honour FLASK_DEBUG=0 and add a test',
    createdAt: ago(40),
    updatedAt: ago(3),
    turns: 3,
    model: 'anthropic/claude-sonnet',
  },
  { id: 's-demo-2', title: null, createdAt: ago(300), updatedAt: ago(240), turns: 1 },
  {
    id: 's-demo-3',
    title: 'Rename Config.get_namespace to get_section across the repo',
    createdAt: ago(3000),
    updatedAt: ago(2900),
    turns: 5,
    model: 'openai/gpt-5',
  },
  {
    id: 's-demo-4',
    title: 'Why does the CLI swallow ImportError when loading the app?',
    createdAt: ago(9000),
    updatedAt: ago(8990),
    turns: 2,
  },
  {
    id: 's-demo-5',
    title: 'Add a deprecation warning to the old session interface',
    createdAt: ago(30000),
    updatedAt: ago(29900),
    turns: 4,
  },
];
const PAGE = 3;

function demoTurns(): TranscriptTurn[] {
  const mk = (
    turnId: string,
    user: string,
    text: string,
    tool?: [string, unknown, string],
  ): TranscriptTurn => {
    const events: RunEvent[] = [
      {
        kind: 'runStart',
        runId: turnId,
        mode: 'agent',
        model: 'anthropic/claude-sonnet',
        sessionId: 's-demo-1',
      },
    ];
    if (tool) {
      events.push({
        kind: 'toolCall',
        runId: turnId,
        threadId: T,
        id: `${turnId}-t`,
        name: tool[0],
        args: tool[1],
      });
      events.push({
        kind: 'toolResult',
        runId: turnId,
        threadId: T,
        id: `${turnId}-t`,
        content: tool[2],
        isError: false,
      });
    }
    events.push({ kind: 'text', runId: turnId, threadId: T, delta: text });
    events.push({
      kind: 'done',
      runId: turnId,
      status: 'done',
      metrics: { inputTokens: 9100, outputTokens: 420, toolCalls: tool ? 1 : 0, durationMs: 8200 },
    });
    return { turnId, user, events };
  };
  return [
    mk(
      'd1',
      'Make get_debug_flag honour FLASK_DEBUG=0',
      'Done: unset now returns False and 0/false/no are handled.',
      ['read_file', { path: 'src/flask/helpers.py' }, 'def get_debug_flag(): ...'],
    ),
    mk(
      'd2',
      'Now add a regression test for it',
      'Added tests/test_debug_flag.py with a FLASK_DEBUG=0 case.',
      ['grep', { pattern: 'get_debug_flag' }, 'tests/test_helpers.py:12'],
    ),
    mk(
      'd3',
      'Does the docs page mention the old behaviour?',
      'No. docs/config.rst only lists the variable name.',
    ),
  ];
}

let timers: number[] = [];
const at = (ms: number, fn: () => void) => void timers.push(window.setTimeout(fn, ms));
const T = 'main';
const S = 'sub-1';

function streamText(start: number, threadId: string, text: string, runId: string, step = 35): number {
  const parts = text.match(/.{1,14}/gs) ?? [];
  parts.forEach((p, i) => at(start + i * step, () => ev({ kind: 'text', runId, threadId, delta: p })));
  return start + parts.length * step;
}

export function replay(
  userText = 'Make get_debug_flag honour FLASK_DEBUG=0 and add a test',
  mentions: Mention[] = [{ kind: 'symbol', value: 'get_debug_flag' }],
  mode?: 'agent' | 'edit',
  selection?: EditorSelection,
): void {
  stop();
  runId = `run-${++runN}`;
  const id = runId;
  window.dispatchEvent(new CustomEvent('temper-dev-user', { detail: { text: userText, mentions, mode, selection } }));
  at(100, () => ev({ kind: 'runStart', runId: id, mode: mode === 'edit' ? 'inline' : 'agent', model: agentModel, sessionId: 's1' }));
  at(250, () => send({ type: 'ledger.update', snapshot: snapshot() }));
  let t = streamText(400, T, "I'll start by exploring the repo.\n\n", id);
  const call = (tid: string, name: string, args: unknown, thread: string, result: string, isError = false, gap = 700) => {
    at(t += 150, () => ev({ kind: 'toolCall', runId: id, threadId: thread, id: tid, name, args }));
    at(t += gap, () => ev({ kind: 'toolResult', runId: id, threadId: thread, id: tid, content: result, isError }));
  };
  call('t0', 'list_tools', {}, T, 'read_file, grep, propose_edit, run_command', false, 300);
  call('t1', 'grep', { pattern: 'FLASK_DEBUG', path: 'src/' }, T, 'src/flask/helpers.py:12', false, 800);
  at(t += 100, () => ev({ kind: 'subagent', runId: id, threadId: S, title: 'Scout: exploring repo', phase: 'start' }));
  call('s1', 'grep', { pattern: 'get_debug_flag' }, S, 'src/flask/config.py:30', false, 600);
  call('s2', 'read_file', { path: 'src/flask/config.py', line: 28 }, S, 'class Config(dict): ...', false, 600);
  at(t += 200, () => ev({ kind: 'subagent', runId: id, threadId: S, title: 'Scout: exploring repo', phase: 'done', status: 'found 2 files' }));
  call('t2', 'read_file', { path: 'src/flask/helpers.py', line: 40 }, T, 'def get_debug_flag(): ...', false, 700);
  call('t3', 'read_file', { path: 'tests/test_helpers.py' }, T, 'def test_get_debug_flag(): ...', false, 700);
  at(t += 200, () => ev({ kind: 'compaction', runId: id, threadId: T, phase: 'start' }));
  at(t += 700, () => ev({ kind: 'compaction', runId: id, threadId: T, phase: 'done' }));
  at(t += 200, () => ev({ kind: 'fallback', runId: id, from: 'anthropic/claude-sonnet', to: 'openai/gpt-5', reason: 'rate limit 429' }));
  at(t += 100, () => ev({ kind: 'retry', runId: id, model: 'openai/gpt-5', attempt: 2, delayMs: 1500, reason: 'timeout' }));
  t = streamText(t + 300, T, "Found it. The fix is in `get_debug_flag`:\n\n- treat **unset** as `False`\n- keep the `0/false/no` handling\n\n```python\nif val is None:\n    return False\n```\n\n", id);
  call('t4', 'edit_file', { path: 'src/flask/config.py' }, T, 'No match for old_str (fuzzy failed)', true, 600);
  call('t5', 'edit_file', { path: 'src/flask/helpers.py', line: 10 }, T, 'ok', false, 600);
  call('t6', 'run_command', { command: 'pytest tests/test_helpers.py -q' }, T, '3 passed in 0.4s', false, 900);
  call('t7', 'submit_changeset', { files: 3 }, T, 'staged', false, 400);
  at(t += 100, () => ev({ kind: 'status', runId: id, status: 'paused' }));
  at(t + 100, () => send({ type: 'review.open', runId: id, changes: structuredClone(changes) }));
}

export function reset(): void {
  stop();
  window.dispatchEvent(new CustomEvent('temper-dev-reset'));
}

/** Dev bar: restore a past session straight into the chat, as a panel reload would. */
export function loadSession(notice?: string): void {
  stop();
  send({
    type: 'session.loaded',
    sessionId: 's-demo-1',
    turns: demoTurns(),
    ...(notice ? { notice } : {}),
  });
  send({ type: 'session.current', sessionId: 's-demo-1' });
}

export function toggleSelection(): void {
  selOn = !selOn;
  send({ type: 'editor.selection', selection: selOn ? SEL : null });
}

export function stop(): void {
  timers.forEach((id) => window.clearTimeout(id));
  timers = [];
}

function handle(m: WebviewMessage): void {
  console.debug('[temper dev] webview ->', m);
  if (providersHandle(m)) return;
  switch (m.type) {
    case 'ready':
      send({ type: 'connection', trueforge: 'connected', detail: 'localhost:8000' });
      sendModels();
      send({ type: 'checkpoints.update', canUndo: false });
      send({ type: 'editor.selection', selection: SEL });
      sendSettings();
      sendSandbox();
      sendServer();
      break;
    case 'settings.refresh':
      sendSettings();
      sendSandbox();
      sendServer();
      break;
    case 'settings.update':
      applySetting(m.key, m.value);
      break;
    case 'sandbox.connect':
      // The real host asks for the key in a VS Code password box; nothing is typed in the browser.
      sandbox = { ...sandbox, busy: true, result: undefined };
      sendSandbox();
      window.setTimeout(() => {
        sandbox = {
          ...sandbox,
          busy: false,
          connected: true,
          skills: { enabled: true },
          result: { level: 'info', text: 'Daytona connected. (dev mock: no key was entered)' },
        };
        sendSandbox();
      }, 600);
      break;
    case 'chat.send':
      replay(m.text, m.mentions, m.mode, m.selection);
      break;
    case 'run.cancel':
      stop();
      ev({ kind: 'done', runId, status: 'cancelled', message: 'Stopped by user' });
      break;
    case 'mention.query': {
      const all: Mention[] = [
        { kind: 'file', value: 'src/flask/helpers.py' },
        { kind: 'file', value: 'src/flask/config.py' },
        { kind: 'symbol', value: 'get_debug_flag' },
        { kind: 'symbol', value: 'get_load_dotenv' },
      ];
      send({ type: 'mention.suggestions', query: m.query, items: all.filter((x) => x.value.toLowerCase().includes(m.query.toLowerCase())) });
      break;
    }
    case 'ledger.pin':
      entries = entries.map((e) => (e.id === m.id ? { ...e, pinned: !e.pinned } : e));
      send({ type: 'ledger.update', snapshot: snapshot() });
      break;
    case 'ledger.evict':
      entries = entries.map((e) => (e.id === m.id ? { ...e, evicted: true } : e));
      send({ type: 'ledger.update', snapshot: snapshot() });
      break;
    case 'budget.set':
      budget = m.tokens;
      send({ type: 'ledger.update', snapshot: snapshot() });
      break;
    case 'models.reorder':
      chain = m.chain;
      sendModels();
      break;
    case 'models.pick':
      if (m.mode === 'agent') agentModel = m.name;
      else inlineModel = m.name;
      sendModels();
      break;
    case 'review.submit':
      send({ type: 'review.closed', runId, applied: 3, rejected: 1 });
      send({ type: 'checkpoints.update', canUndo: true, lastLabel: 'FLASK_DEBUG fix' });
      ev({ kind: 'status', runId, status: 'running' });
      at(500, () => ev({ kind: 'done', runId, status: 'done', metrics: { inputTokens: 12400, outputTokens: 860, cacheReadTokens: 8000, toolCalls: 4, durationMs: 14200, usage: [{ model: agentModel, inputTokens: 12400, outputTokens: 860, cacheReadTokens: 8000 }] } }));
      break;
    case 'history.list': {
      const start = m.pageToken ? Number(m.pageToken) : 0;
      const slice = SESSIONS.slice(start, start + PAGE);
      const more = start + PAGE < SESSIONS.length;
      at(300, () =>
        send({
          type: 'history.page',
          sessions: slice,
          nextPageToken: more ? String(start + PAGE) : undefined,
          append: !!m.pageToken,
        }),
      );
      break;
    }
    case 'session.load':
      at(200, () => {
        send({ type: 'session.loaded', sessionId: m.id, turns: demoTurns() });
        send({ type: 'session.current', sessionId: m.id });
      });
      break;
    case 'session.new':
      send({ type: 'session.current', sessionId: undefined });
      break;
    case 'undo.last':
      send({ type: 'checkpoints.update', canUndo: false });
      break;
    default:
      break;
  }
}

/** Dev bar: preview the Models view with TrueForge down, or reachable with no models. */
export function setServer(mode: 'up' | 'down' | 'empty'): void {
  const none = mode === 'empty';
  send({ type: 'connection', trueforge: mode === 'down' ? 'disconnected' : 'connected', detail: mode === 'down' ? 'connect ECONNREFUSED 127.0.0.1:8790' : undefined });
  send({ type: 'models.update', models: none ? [] : MODELS, chain: none ? [] : chain, agentModel: none ? '' : agentModel, inlineModel: none ? '' : inlineModel });
}

export function startDemo(): void {
  bindProviders(send);
  document.documentElement.dataset.devTheme = 'dark';
  document.body.className = 'vscode-dark';
  setMockHandler(handle);
}

/** Dev bar: what the native view-title buttons do in VS Code. */
export function navigate(to: 'newChat' | 'history' | 'settings'): void {
  send({ type: 'nav', to });
}

/** Dev bar: preview the Sandbox section states. */
export function setSandbox(mode: 'off' | 'on' | 'error'): void {
  sandbox =
    mode === 'on'
      ? { loaded: true, connected: true, skills: { enabled: true }, busy: false }
      : mode === 'error'
        ? { loaded: true, connected: false, busy: false, error: 'Reading the sandbox provider failed (HTTP 500)' }
        : { loaded: true, connected: false, busy: false, skills: { enabled: false, reason: 'Skills run in a sandbox, which is not configured.' } };
  sendSandbox();
}
