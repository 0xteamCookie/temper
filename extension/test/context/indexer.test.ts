import { describe, expect, it } from 'vitest';
import { WorkspaceIndex } from '../../src/context';
import type { WorkspaceReader } from '../../src/context';
import { memReader, TOY } from './helpers';

async function build(files = TOY): Promise<WorkspaceIndex> {
  const idx = new WorkspaceIndex(memReader(files));
  await idx.build();
  return idx;
}

describe('WorkspaceIndex', () => {
  it('extracts python symbols with signatures, docs and ranges', async () => {
    const idx = await build();
    const def = idx.definitions('run_command', true)[0];
    expect(def).toMatchObject({ kind: 'function', path: 'src/app/cli.py', line: 12, startLine: 11 });
    expect(def?.doc).toBe('Run the development server.');
    expect(def?.decorator).toBe('@click.command("run")');
    const m = idx.definitions('list_commands', true)[0];
    expect(m).toMatchObject({ kind: 'method', parent: 'Group' });
  });

  it('skips binaries and builds chunks per def/class/method', async () => {
    const idx = await build();
    expect(idx.file('assets/logo.png')).toBeUndefined();
    const ids = idx.file('src/app/cli.py')?.chunks.map((c) => c.symbol);
    expect(ids).toEqual(expect.arrayContaining(['Group', 'Group.list_commands', 'run_command', 'main']));
  });

  it('resolves imports, importers and references', async () => {
    const idx = await build();
    expect(idx.importsOf('src/app/cli.py')).toContain('src/app/helpers.py');
    expect(idx.importersOf('src/app/cli.py')).toEqual(expect.arrayContaining(['src/app/__init__.py', 'tests/test_cli.py']));
    expect(idx.referencesTo('get_debug_flag')).toContain('src/app/cli.py');
  });

  it('pairs tests and docs with source by name', async () => {
    const idx = await build();
    expect(idx.testsFor('src/app/cli.py')[0]).toMatchObject({ path: 'tests/test_cli.py', via: 'name' });
    expect(idx.docsFor('src/app/cli.py')[0]).toMatchObject({ path: 'docs/cli.rst', via: 'name' });
    expect(idx.codeForDoc('docs/cli.rst')[0]?.path).toBe('src/app/cli.py');
  });

  it('updates incrementally (change, add, delete)', async () => {
    const files: Record<string, string> = { ...TOY };
    const live: WorkspaceReader = {
      root: '/mem',
      listFiles: () => Promise.resolve(Object.keys(files)),
      readFile: (p) => Promise.resolve(files[p]),
    };
    const idx = new WorkspaceIndex(live);
    await idx.build();
    files['src/app/helpers.py'] = 'def brand_new_thing():\n    return 1\n';
    await idx.update('src/app/helpers.py');
    expect(idx.definitions('get_debug_flag')).toHaveLength(0);
    expect(idx.definitions('brand_new_thing')).toHaveLength(1);
    files['src/app/extra.py'] = 'def extra():\n    pass\n';
    await idx.update('src/app/extra.py');
    expect(idx.file('src/app/extra.py')).toBeDefined();
    delete files['src/app/extra.py'];
    await idx.update('src/app/extra.py');
    expect(idx.file('src/app/extra.py')).toBeUndefined();
    expect(idx.bm25.size).toBe(idx.chunks.size);
  });

  it('respects excludes and size limit; SymbolSource overrides the built-in extractor', async () => {
    const idx = new WorkspaceIndex(memReader({ 'node_modules/x/a.py': 'def a(): pass', 'big.py': 'x = 1\n'.repeat(100), 'ok.py': 'def z(): pass' }), {
      maxFileBytes: 50,
      symbolSources: [
        {
          name: 'fake',
          symbols: (p) => (p === 'ok.py' ? [{ name: 'LspSym', kind: 'function', path: p, line: 1, startLine: 1, endLine: 1, signature: 'LspSym()' }] : undefined),
        },
      ],
    });
    await idx.build();
    expect([...idx.files.keys()]).toEqual(['ok.py']);
    expect(idx.definitions('LspSym')).toHaveLength(1);
    expect(idx.definitions('z')).toHaveLength(0);
  });
});
