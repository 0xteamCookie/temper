import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findSymbolTool, listDirTool, NodeWorkspace, readFileTool, searchCodeTool } from '../../src/mcp';
import type { TemperTool } from '../../src/mcp';

const FLASK = 'C:/Projects/NOV-2026/flask';
const ctx = { workspace: new NodeWorkspace(FLASK), runId: 'f', services: { ripgrep: false } };

async function timed(t: TemperTool, args: Record<string, unknown>): Promise<string> {
  const t0 = performance.now();
  const out = await t.handler(t.inputSchema.parse(args), ctx);
  console.log(`[flask] ${t.name} ${JSON.stringify(args)} -> ${(performance.now() - t0).toFixed(0)}ms, ${out.length} chars`);
  return out;
}

describe.skipIf(!existsSync(FLASK))('real Flask checkout', () => {
  it('find_symbol get_debug_flag -> src/flask/helpers.py', async () => {
    expect(await timed(findSymbolTool, { name: 'get_debug_flag' })).toMatch(/src\/flask\/helpers\.py:\d+ function get_debug_flag/);
  });
  it('search_code "def run_command" -> src/flask/cli.py', async () => {
    expect(await timed(searchCodeTool, { query: 'def run_command' })).toContain('src/flask/cli.py:');
  });
  it('find_symbol method', async () => {
    expect(await timed(findSymbolTool, { name: 'Flask.run' })).toMatch(/src\/flask\/app\.py:\d+ method Flask\.run\(/);
  });
  it('list_dir and read_file', async () => {
    expect(await timed(listDirTool, {})).toContain('src/');
    expect(await timed(readFileTool, { path: 'src/flask/app.py', start_line: 1, end_line: 20 })).toContain('1|');
  });
});
