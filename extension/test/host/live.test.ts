// Live smoke test: real TrueForge + real model, no VS Code UI. Skipped unless TEMPER_LIVE is set.
//
//   TEMPER_LIVE=1 TEMPER_MODEL=<provider/model> npx vitest run test/host/live.test.ts
//
// Optional: TEMPER_ROOT (default C:/Projects/NOV-2026/flask), TEMPER_PROMPT, TEMPER_TRUEFORGE (default
// http://127.0.0.1:8790). Starts the MCP server with Node adapters, registers it in TrueForge, runs one
// agent turn and auto-approves the review. Applied content is recorded in memory: the workspace on disk
// is never written.
import { describe, expect, it } from 'vitest';
import { NodeFileSystem } from '../../src/changeset';
import { DEFAULT_SETTINGS } from '../../src/config/settings';
import { ContextEngine, createGetContextTool, createNodeReader } from '../../src/context';
import { createEditTools } from '../../src/host/editTools';
import { RunController } from '../../src/host/runController';
import type { RunUi } from '../../src/host/runController';
import { ChangesetWorkspace } from '../../src/host/changesetWorkspace';
import { MCP_DESCRIPTION } from '../../src/host/trueforgeConnection';
import { readOnlyTools, startMcpServer } from '../../src/mcp';
import type { RunEvent } from '../../src/shared/types';
import { TrueForgeClient } from '../../src/trueforge';

const live = !!process.env.TEMPER_LIVE;
const ROOT = process.env.TEMPER_ROOT ?? 'C:/Projects/NOV-2026/flask';
const BASE = process.env.TEMPER_TRUEFORGE ?? 'http://127.0.0.1:8790';
const PROMPT =
  process.env.TEMPER_PROMPT ??
  'In src/flask/cli.py, add a one-line comment above the definition of get_version explaining what it does, then submit the changeset.';

/** Reads from disk, records writes in memory instead of touching the workspace. */
class RecordingFs extends NodeFileSystem {
  written = new Map<string, string>();
  constructor(root: string) {
    super(root);
  }
  override async write(rel: string, content: string): Promise<void> {
    this.written.set(rel, content);
  }
  override async delete(rel: string): Promise<void> {
    this.written.set(rel, '<deleted>');
  }
}

describe.skipIf(!live)('live agent run (TrueForge + real model)', () => {
  it(
    'runs a turn end to end with auto-approval',
    async () => {
      const model = process.env.TEMPER_MODEL;
      if (!model) throw new Error('Set TEMPER_MODEL to a TrueForge model name, e.g. anthropic/claude-sonnet.');

      const client = new TrueForgeClient({ baseUrl: BASE });
      expect((await client.health()).ok).toBe(true);
      const known = (await client.listModels()).map((m) => m.name);
      expect(known, `TrueForge does not list ${model}`).toContain(model);

      const fs = new RecordingFs(ROOT);
      const events: RunEvent[] = [];
      const log: string[] = [];
      const ui: RunUi = {
        event: (ev) => {
          events.push(ev);
          if (ev.kind === 'toolCall') log.push(`-> ${ev.name} ${JSON.stringify(ev.args).slice(0, 120)}`);
          if (ev.kind === 'toolResult') log.push(`   ${ev.isError ? 'ERR ' : ''}${ev.content.slice(0, 120).replace(/\s+/g, ' ')}`);
        },
        post: () => {},
        notify: (k, t) => log.push(`${k}: ${t}`),
        openReview: (p) => {
          // Auto-approve: accept every hunk and submit.
          setTimeout(() => {
            p.handlers.onDecideAll('accept');
            p.handlers.onSubmit();
          }, 0);
        },
        updateReview: () => {},
        closeReview: () => {},
        askPartialReview: async () => false,
        confirm: async () => true,
      };

      // eslint-disable-next-line prefer-const
      let controller: RunController;
      const workspace = new ChangesetWorkspace(ROOT, () => controller.activeChangeset);
      const engine = new ContextEngine(createNodeReader(ROOT));
      controller = new RunController({
        client,
        ui,
        getSettings: () => DEFAULT_SETTINGS,
        getModels: () => ({ chain: [model], agentModel: model, inlineModel: model }),
        workspaceRoot: ROOT,
        workspace,
        fsPort: fs,
      });

      const mcp = await startMcpServer({
        tools: [...readOnlyTools, ...createEditTools(() => controller.active), createGetContextTool({ engine })],
        workspace,
        runId: () => controller.activeRunId,
        services: { contextEngine: engine, workspaceRoot: ROOT },
        onToolCall: (name, _a, r, ms) => log.push(`[mcp] ${name} ${r.isError ? 'ERROR' : 'ok'} ${ms} ms`),
      });
      try {
        await client.ensureMcpServer('temper', mcp.url, MCP_DESCRIPTION);
        const result = await controller.start({ mode: 'agent', prompt: PROMPT });
        console.log(log.join('\n'));
        console.log('applied files:', [...fs.written.keys()]);
        for (const [p, c] of fs.written) console.log(`--- ${p}\n${c.slice(0, 400)}`);
        const done = events.find((e) => e.kind === 'done');
        expect(result?.status, done && 'message' in done ? String(done.message) : undefined).toBe('done');
        expect(events.some((e) => e.kind === 'approval')).toBe(true);
        expect((await client.getAgent('temper-agent'))?.name).toBe('temper-agent');
      } finally {
        await mcp.stop();
      }
    },
    5 * 60_000,
  );
});
