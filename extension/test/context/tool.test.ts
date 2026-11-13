import { describe, expect, it } from 'vitest';
import { ContextEngine, createGetContextTool } from '../../src/context';
import type { ToolContext } from '../../src/mcp/tool';
import type { LedgerSnapshot } from '../../src/shared/types';
import { memReader, TOY } from './helpers';

describe('get_context tool', () => {
  it('returns packed text and publishes the snapshot', async () => {
    const engine = new ContextEngine(memReader(TOY));
    let seen: LedgerSnapshot | undefined;
    const tool = createGetContextTool({ engine, onSnapshot: (s) => (seen = s), getBudgetTokens: () => 3000 });
    expect(tool.name).toBe('get_context');
    const args = tool.inputSchema.parse({ task: 'document the run command', mentions: ['@src/app/helpers.py', '@symbol:main'] });
    const out = await tool.handler(args, { runId: 'run-1', services: {}, workspace: {} } as unknown as ToolContext);
    expect(out).toContain('### src/app/helpers.py');
    expect(out).toContain('you mentioned @symbol:main');
    expect(seen?.runId).toBe('run-1');
    expect(seen?.budgetTokens).toBe(3000);
    expect(engine.ledger.latest()).toBe(seen);
  });

  it('reports unknown mentions instead of failing', async () => {
    const engine = new ContextEngine(memReader(TOY));
    const tool = createGetContextTool({ engine });
    const args = tool.inputSchema.parse({ task: 'x', mentions: ['@nope/missing.py'] });
    const out = await tool.handler(args, { runId: 'r', services: {} } as unknown as ToolContext);
    expect(out).toContain('mention not found: @nope/missing.py');
  });
});
