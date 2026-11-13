import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/shared/types';
import { ModelRouter, TrueForgeClient } from '../../src/trueforge';

// Live test against a local TrueForge (127.0.0.1:8790) with the spike mock provider
// (mock/tool, mock/e401) and the spike MCP server (8791). Skipped when unavailable.
const BASE = process.env.TF_URL ?? 'http://127.0.0.1:8790';
const client = new TrueForgeClient({ baseUrl: BASE });

async function available(): Promise<boolean> {
  try {
    if (!(await client.health()).ok) return false;
    const names = (await client.listModels()).map((m) => m.name);
    if (!['mock/tool', 'mock/e401'].every((n) => names.includes(n))) return false;
    const mcp = await fetch('http://127.0.0.1:8791/', { signal: AbortSignal.timeout(1500) }).catch(() => undefined);
    return !!mcp;
  } catch {
    return false;
  }
}
const live = await available();

const spec = (model: string) => ({
  model: { name: model },
  instructions: 'You are a coding agent. Use the MCP tools read_file and propose_edit.',
  mcp_servers: [{ name: 'spike-fs', preload: true, require_approval_for_tools: ['propose_edit'] }],
  config: { dynamic_sub_agents: { enabled: false }, ask_user_questions: { enabled: false }, generative_ui: { enabled: false } },
});

describe.skipIf(!live)('live TrueForge', () => {
  it('lists models', async () => {
    const models = await client.listModels();
    expect(models.find((m) => m.name === 'mock/tool')).toMatchObject({ provider: 'mock', health: 'unknown' });
  });

  it('runs a tool turn, approves, completes', async () => {
    const events: RunEvent[] = [];
    let turn: { sessionId: string; turnId: string } | undefined;
    const router = new ModelRouter({ client, chain: ['mock/tool'], retries: 0, fallbackEnabled: true });
    const res = await router.run({
      mode: 'agent',
      buildSpec: spec,
      prompt: 'Read src/app.py then edit it.',
      hasSideEffects: () => false,
      onTurn: (t) => (turn = t),
      onEvent: (e) => {
        events.push(e);
        if (e.kind === 'approval' && turn) void client.approve(turn.sessionId, turn.turnId, e.threadId, e.toolCallId, { status: 'allow' });
      },
    });
    expect(res.status).toBe('done');
    expect(events.some((e) => e.kind === 'approval')).toBe(true);
  }, 20_000);

  it('falls back from a 401 model', async () => {
    const events: RunEvent[] = [];
    const router = new ModelRouter({ client, chain: ['mock/e401', 'mock/tool'], retries: 0, fallbackEnabled: true });
    const res = await router.run({
      mode: 'inline',
      buildSpec: (m) => ({ ...spec(m), mcp_servers: [] }),
      prompt: 'hi',
      hasSideEffects: () => false,
      onEvent: (e) => events.push(e),
    });
    expect(events.find((e) => e.kind === 'fallback')).toMatchObject({ from: 'mock/e401', to: 'mock/tool' });
    expect(res.model).toBe('mock/tool');
  }, 20_000);

  it('unknown model fails at session creation with ModelUnavailableError', async () => {
    await expect(client.createSession(spec('nope/none'))).rejects.toMatchObject({ name: 'ModelUnavailableError' });
  });
});
