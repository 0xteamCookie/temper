import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineTool, NodeWorkspace, readOnlyTools, startMcpServer } from '../../src/mcp';
import type { RunningMcpServer, ToolCallResult } from '../../src/mcp';
import { makeFixtureRoot } from './helpers';

const calls: Array<{ name: string; result: ToolCallResult; ms: number }> = [];
let srv: RunningMcpServer;
let client: Client;

const boom = defineTool({
  name: 'boom',
  description: 'Always throws',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: false, destructiveHint: true },
  async handler() {
    throw new Error('kaboom');
  },
});

beforeAll(async () => {
  srv = await startMcpServer({
    tools: [...readOnlyTools, boom],
    workspace: new NodeWorkspace(makeFixtureRoot()),
    runId: 'run-1',
    services: { ripgrep: false },
    onToolCall: (name, _a, result, ms) => calls.push({ name, result, ms }),
    port: 0,
  });
  client = new Client({ name: 't', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(srv.url)));
});
afterAll(async () => {
  await client.close();
  await srv.stop();
});

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

describe('mcp server e2e', () => {
  it('binds 127.0.0.1 on a random port', () => {
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });
  it('lists tools with descriptions and annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['boom', 'find_symbol', 'list_dir', 'read_file', 'search_code']);
    const rf = tools.find((t) => t.name === 'read_file')!;
    expect(rf.description).toMatch(/line numbers/);
    expect(rf.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'boom')!.annotations?.destructiveHint).toBe(true);
  });
  it('calls tools', async () => {
    const r = await client.callTool({ name: 'find_symbol', arguments: { name: 'get_debug_flag' } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('app/main.py:7 function');
    expect(text(await client.callTool({ name: 'read_file', arguments: { path: 'README.md' } }))).toContain('1| # readme');
  });
  it('returns tool errors as isError results', async () => {
    const miss = await client.callTool({ name: 'read_file', arguments: { path: 'nope.py' } });
    expect(miss.isError).toBe(true);
    expect(text(miss)).toContain('File not found');
    const boomRes = await client.callTool({ name: 'boom', arguments: {} });
    expect(boomRes.isError).toBe(true);
    expect(text(boomRes)).toContain('kaboom');
  });
  it('survives invalid arguments and raw garbage', async () => {
    const bad = await client.callTool({ name: 'read_file', arguments: { path: 5 } }).catch((e: unknown) => e);
    expect(bad instanceof Error || (bad as { isError?: boolean }).isError).toBeTruthy();
    const garbage = await fetch(srv.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{not json',
    });
    expect(garbage.status).toBe(400);
    expect((await fetch(srv.url, { method: 'GET' })).status).toBe(405);
    expect((await client.callTool({ name: 'list_dir', arguments: {} })).isError).toBeFalsy();
  });
  it('invokes onToolCall', () => {
    expect(calls.some((c) => c.name === 'boom' && c.result.isError)).toBe(true);
    expect(calls.every((c) => c.ms >= 0)).toBe(true);
  });
});
