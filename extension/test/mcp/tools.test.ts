import { beforeAll, describe, expect, it } from 'vitest';
import { findSymbolTool, listDirTool, NodeWorkspace, readFileTool, searchCodeTool } from '../../src/mcp';
import type { TemperTool, ToolContext } from '../../src/mcp';
import { runSearch } from '../../src/mcp/tools/searchCode';
import { makeFixtureRoot } from './helpers';

let root: string;
beforeAll(() => {
  root = makeFixtureRoot();
});
const mk = (overlay = new Map<string, string | null>()): ToolContext => ({
  workspace: new NodeWorkspace(root, overlay),
  runId: 'r1',
  services: { ripgrep: false },
});
const call = (t: TemperTool, args: Record<string, unknown>, ctx = mk()) => t.handler(t.inputSchema.parse(args), ctx);

describe('read_file', () => {
  it('numbers lines', async () => {
    const out = await call(readFileTool, { path: 'app/util.py' });
    expect(out).toContain('app/util.py (3 lines)');
    expect(out).toContain('  1| from .main import get_debug_flag');
  });
  it('caps at 400 lines with hint, and pages', async () => {
    const out = await call(readFileTool, { path: 'big.txt' });
    expect(out).toContain('lines 1-400 of 1000');
    expect(out).toContain('start_line=401');
    const p2 = await call(readFileTool, { path: 'big.txt', start_line: 998, end_line: 5000 });
    expect(p2).toContain('998| line 998');
    expect(p2).toContain('1000| line 1000');
    expect(p2).not.toContain('more lines');
  });
  it('suggests similar paths when missing', async () => {
    await expect(call(readFileTool, { path: 'main.py' })).rejects.toThrow(/app\/main\.py/);
  });
  it('rejects escapes and directories; honors overlay', async () => {
    await expect(call(readFileTool, { path: '../secrets' })).rejects.toThrow(/escapes/);
    await expect(call(readFileTool, { path: 'app' })).rejects.toThrow(/directory/);
    const ov = new Map([['app/new.py', 'x = 1\n']]);
    expect(await call(readFileTool, { path: 'app/new.py' }, mk(ov))).toContain('1| x = 1');
    expect(await call(readFileTool, { path: root.replace(/\\/g, '/') + '/app/util.py' })).toContain('util.py');
  });
});

describe('list_dir', () => {
  it('lists tree and excludes noise', async () => {
    const out = await call(listDirTool, {});
    expect(out).toContain('app/');
    expect(out).toContain('    main.py');
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('.git');
  });
  it('depth 1 summarises children; errors helpfully', async () => {
    expect(await call(listDirTool, { depth: 1 })).toMatch(/app\/ {2}\(\d+ items/);
    await expect(call(listDirTool, { path: 'nope' })).rejects.toThrow(/not found/);
    await expect(call(listDirTool, { path: 'README.md' })).rejects.toThrow(/is a file/);
  });
  it('shows overlay-created files', async () => {
    expect(await call(listDirTool, { path: 'app' }, mk(new Map([['app/fresh.py', '']])))).toContain('fresh.py');
  });
});

describe('search_code', () => {
  it('finds literal matches grouped by file, skipping excluded dirs', async () => {
    const out = await call(searchCodeTool, { query: 'get_debug_flag' });
    expect(out).toContain('app/main.py:7:');
    expect(out).toContain('app/util.py:1:');
    expect(out).toContain('README.md:2:');
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('.git/');
  });
  it('glob, regex, cap, no match, bad regex', async () => {
    expect(await call(searchCodeTool, { query: 'get_debug_flag', glob: '*.py' })).not.toContain('README');
    expect(await call(searchCodeTool, { query: 'def \\w+\\(', regex: true, glob: 'app/**' })).toContain('app/main.py:16:');
    expect(await call(searchCodeTool, { query: 'line', max_results: 3 })).toContain('capped at 3');
    expect(await call(searchCodeTool, { query: 'zzzqqq' })).toContain('No matches');
    await expect(call(searchCodeTool, { query: '(', regex: true })).rejects.toThrow(/Invalid regex/);
  });
  it('sees overlay edits', async () => {
    const out = await call(searchCodeTool, { query: 'uniq_overlay_token' }, mk(new Map([['app/util.py', 'uniq_overlay_token\n']])));
    expect(out).toContain('app/util.py:1');
  });
  it('rg path (if installed) agrees with node path', async () => {
    const ctx = mk();
    const lines = (s: string) => s.split('\n').filter((l) => /^\S+:\d+:/.test(l)).sort();
    const a = await runSearch(ctx, { query: 'get_debug_flag' }, { useRipgrep: false });
    const b = await runSearch(ctx, { query: 'get_debug_flag' }, { useRipgrep: true });
    expect(lines(b)).toEqual(lines(a));
  });
});

describe('find_symbol', () => {
  it('python function with signature, plus references', async () => {
    const out = await call(findSymbolTool, { name: 'get_debug_flag' });
    expect(out).toContain('app/main.py:7 function get_debug_flag() -> bool');
    expect(out).toContain('app/util.py:3:');
  });
  it('python class, methods, variables; not locals', async () => {
    expect(await call(findSymbolTool, { name: 'Service' })).toContain('app/main.py:13 class class Service(Base)');
    expect(await call(findSymbolTool, { name: 'Service.run' })).toContain('app/main.py:16 method Service.run(self, cmd: str, timeout: int = 5)');
    expect(await call(findSymbolTool, { name: 'stop' })).toContain('method Service.stop(self)');
    expect(await call(findSymbolTool, { name: 'DEBUG_FLAG' })).toContain('app/main.py:3 variable');
    expect(await call(findSymbolTool, { name: 'retries' })).toContain('variable retries: int = 3');
    expect(await call(findSymbolTool, { name: 'local' })).toContain('No definition');
  });
  it('typescript kinds', async () => {
    const f = (name: string, kind?: string) => call(findSymbolTool, { name, kind });
    expect(await f('User')).toContain('web/store.ts:1 interface');
    expect(await f('Id')).toContain('web/store.ts:2 type');
    expect(await f('Color')).toContain('web/store.ts:3 enum');
    expect(await f('MAX')).toContain('web/store.ts:4 variable');
    expect(await f('add')).toContain('web/store.ts:5 function');
    expect(await f('fetchUser')).toContain('web/store.ts:6 function fetchUser(id: Id)');
    expect(await f('Store')).toContain('web/store.ts:9 class');
    expect(await f('load')).toContain('web/store.ts:11 method Store.load(id: Id)');
    expect(await f('fetchUser', 'class')).toContain('No definition');
  });
  it('rejects bad names', async () => {
    await expect(call(findSymbolTool, { name: 'a b' })).rejects.toThrow(/valid identifier/);
  });
});
