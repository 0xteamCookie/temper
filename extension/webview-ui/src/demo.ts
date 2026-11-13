// Dev harness: mocks the extension host when running outside VS Code.
// Replays a scripted run so every UI section is visible (`npm run dev`).
import type { FileChange, Hunk, LedgerEntry, LedgerSnapshot, ModelInfo, RunEvent } from '../../src/shared/types';
import type { HostMessage, Mention, WebviewMessage } from './vscode';
import { setMockHandler } from './vscode';

const send = (m: HostMessage) => window.postMessage(m, '*');
const ev = (event: RunEvent) => send({ type: 'run.event', event });

const MODELS: ModelInfo[] = [
  { name: 'anthropic/claude-sonnet', provider: 'anthropic', health: 'failing', lastError: '[Model Error] Request failed (429)' },
  { name: 'openai/gpt-5', provider: 'openai', health: 'ok' },
  { name: 'google/gemini-pro', provider: 'google', health: 'unknown' },
  { name: 'local/qwen-coder', provider: 'local', health: 'ok' },
];
let chain = ['anthropic/claude-sonnet', 'openai/gpt-5', 'google/gemini-pro'];
let agentModel = 'anthropic/claude-sonnet';
let inlineModel = 'local/qwen-coder';
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
  { id: 'src/flask/app.py', path: 'src/flask/app.py', score: 2.1, tokens: 9400, representation: 'outline', included: false,
    reasons: [{ reason: 'graph', detail: 'calls get_debug_flag' }, { reason: 'agent', detail: 'read via read_file' }] },
];
let budget = 8000;
const snapshot = (): LedgerSnapshot => ({
  runId: 'run-1',
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

let timers: number[] = [];
const at = (ms: number, fn: () => void) => void timers.push(window.setTimeout(fn, ms));
const T = 'main';
const S = 'sub-1';

function streamText(start: number, threadId: string, text: string, runId: string, step = 35): number {
  const parts = text.match(/.{1,14}/gs) ?? [];
  parts.forEach((p, i) => at(start + i * step, () => ev({ kind: 'text', runId, threadId, delta: p })));
  return start + parts.length * step;
}

export function replay(userText = 'Make get_debug_flag honour FLASK_DEBUG=0 and add a test', mentions: Mention[] = [{ kind: 'symbol', value: 'get_debug_flag' }]): void {
  stop();
  const runId = 'run-1';
  window.dispatchEvent(new CustomEvent('temper-dev-user', { detail: { text: userText, mentions } }));
  at(100, () => ev({ kind: 'runStart', runId, mode: 'agent', model: 'anthropic/claude-sonnet', sessionId: 's1' }));
  at(250, () => send({ type: 'ledger.update', snapshot: snapshot() }));
  let t = streamText(400, T, "I'll start by exploring the repo.\n\n", runId);
  at(t += 100, () => ev({ kind: 'subagent', runId, threadId: S, title: 'Scout: exploring repo', phase: 'start' }));
  at(t += 200, () => ev({ kind: 'toolCall', runId, threadId: S, id: 't1', name: 'grep', args: { pattern: 'FLASK_DEBUG', path: 'src/' } }));
  at(t += 800, () => ev({ kind: 'toolResult', runId, threadId: S, id: 't1', content: 'src/flask/helpers.py:12', isError: false }));
  at(t += 100, () => ev({ kind: 'toolCall', runId, threadId: S, id: 't2', name: 'read_file', args: { path: 'src/flask/helpers.py' } }));
  at(t += 700, () => ev({ kind: 'toolResult', runId, threadId: S, id: 't2', content: 'def get_debug_flag(): ...', isError: false }));
  at(t += 200, () => ev({ kind: 'subagent', runId, threadId: S, title: 'Scout: exploring repo', phase: 'done', status: 'found 2 files' }));
  at(t += 200, () => ev({ kind: 'compaction', runId, threadId: T, phase: 'start' }));
  at(t += 700, () => ev({ kind: 'compaction', runId, threadId: T, phase: 'done' }));
  at(t += 200, () => ev({ kind: 'fallback', runId, from: 'anthropic/claude-sonnet', to: 'openai/gpt-5', reason: 'rate limit 429' }));
  at(t += 100, () => ev({ kind: 'retry', runId, model: 'openai/gpt-5', attempt: 2, delayMs: 1500, reason: 'timeout' }));
  t = streamText(t + 300, T, "Found it. The fix is in `get_debug_flag`:\n\n- treat **unset** as `False`\n- keep the `0/false/no` handling\n\n```python\nif val is None:\n    return False\n```\n\n", runId);
  at(t += 100, () => ev({ kind: 'toolCall', runId, threadId: T, id: 't3', name: 'edit_file', args: { path: 'src/flask/config.py' } }));
  at(t += 600, () => ev({ kind: 'toolResult', runId, threadId: T, id: 't3', content: 'No match for old_str (fuzzy failed)', isError: true }));
  at(t += 100, () => ev({ kind: 'toolCall', runId, threadId: T, id: 't4', name: 'edit_file', args: { path: 'src/flask/helpers.py' } }));
  at(t += 600, () => ev({ kind: 'toolResult', runId, threadId: T, id: 't4', content: 'ok', isError: false }));
  at(t += 100, () => ev({ kind: 'status', runId, status: 'paused' }));
  at(t + 100, () => send({ type: 'review.open', runId, changes: structuredClone(changes) }));
}

export function stop(): void {
  timers.forEach((id) => window.clearTimeout(id));
  timers = [];
}

function handle(m: WebviewMessage): void {
  console.debug('[temper dev] webview ->', m);
  switch (m.type) {
    case 'ready':
      send({ type: 'connection', trueforge: 'connected', detail: 'localhost:8000' });
      sendModels();
      send({ type: 'checkpoints.update', canUndo: false });
      at(500, () => replay());
      break;
    case 'chat.send':
      replay(m.text, m.mentions);
      break;
    case 'run.cancel':
      stop();
      ev({ kind: 'done', runId: 'run-1', status: 'cancelled', message: 'Stopped by user' });
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
      send({ type: 'review.closed', runId: 'run-1', applied: 2, rejected: 2 });
      send({ type: 'checkpoints.update', canUndo: true, lastLabel: 'FLASK_DEBUG fix' });
      ev({ kind: 'status', runId: 'run-1', status: 'running' });
      at(500, () => ev({ kind: 'done', runId: 'run-1', status: 'done', metrics: { inputTokens: 12400, outputTokens: 860, toolCalls: 4, durationMs: 14200 } }));
      break;
    case 'undo.last':
      send({ type: 'checkpoints.update', canUndo: false });
      break;
    default:
      break;
  }
}

export function startDemo(): void {
  setMockHandler(handle);
}
