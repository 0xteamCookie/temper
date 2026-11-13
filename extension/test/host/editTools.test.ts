import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangesetStore, NodeFileSystem } from '../../src/changeset';
import { DEFAULT_SETTINGS } from '../../src/config/settings';
import type { TemperSettings } from '../../src/config/settings';
import { SimpleSymbolIndex } from '../../src/guards';
import { NodeWorkspace } from '../../src/mcp';
import type { TemperTool } from '../../src/mcp';
import { applySymbolFlags, createEditTools } from '../../src/host/editTools';
import type { EditToolRun } from '../../src/host/editTools';
import { ShadowWorktree } from '../../src/host/shadow';
import { StagingTracker } from '../../src/host/stagingTracker';

let root: string;
let shadow: ShadowWorktree | undefined;

const PY = 'def get_debug_flag():\n    return False\n\n\ndef run():\n    return get_debug_flag()\n';

function settings(over: { symbolCheck?: TemperSettings['guards']['symbolCheck']; allowlist?: string[]; shadow?: boolean } = {}): TemperSettings {
  return {
    ...DEFAULT_SETTINGS,
    guards: { ...DEFAULT_SETTINGS.guards, symbolCheck: over.symbolCheck ?? 'bounceThenWarn' },
    commands: { allowlist: over.allowlist ?? ['pytest', 'node'], runInShadowWorktree: over.shadow ?? true },
  };
}

function makeRun(s: TemperSettings): EditToolRun & { submitted: string[] } {
  const changeset = new ChangesetStore(new NodeFileSystem(root));
  const submitted: string[] = [];
  const run: EditToolRun & { submitted: string[] } = {
    runId: 'r1',
    workspaceRoot: root,
    changeset,
    settings: () => s,
    symbolIndex: async () => new SimpleSymbolIndex(['get_debug_flag', 'run']),
    shadow: () => (shadow ??= new ShadowWorktree(root, `edit${Date.now()}`)),
    symbolFlags: [],
    bounces: new Map(),
    submitted,
    applySubmitted: async (summary) => {
      submitted.push(summary);
      return 'Applied 1 hunk in app.py; rejected 0 (none).';
    },
  };
  return run;
}

function tool(run: EditToolRun, name: string): TemperTool {
  const t = createEditTools(() => run).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

const ctx = () => ({ workspace: new NodeWorkspace(root), runId: 'r1', services: {} });
const call = (t: TemperTool, args: Record<string, unknown>) => t.handler(args as never, ctx());

const BAD_EDIT = {
  path: 'app.py',
  old_string: '    return False',
  new_string: '    return fetch_remote_flag()',
  rationale: 'use remote',
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'temper-tools-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(path.join(root, 'app.py'), PY);
  mkdirSync(path.join(root, 'sub'));
  writeFileSync(path.join(root, 'sub', 'note.txt'), 'hello\n');
});

afterEach(async () => {
  await shadow?.dispose();
  shadow = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('propose_edit', () => {
  it('stages a valid edit without touching disk', async () => {
    const run = makeRun(settings());
    const out = await call(tool(run, 'propose_edit'), {
      path: 'app.py',
      old_string: '    return False',
      new_string: '    return True',
      rationale: 'flip',
    });
    expect(out).toContain('Staged edit to app.py');
    expect(run.changeset.isEmpty()).toBe(false);
    expect(await run.changeset.read('app.py')).toContain('return True');
    expect(PY).toContain('return False');
  });

  it('bounceThenWarn: first unknown-symbol edit bounces and is not staged, the repeat is staged with a flag', async () => {
    const run = makeRun(settings({ symbolCheck: 'bounceThenWarn' }));
    const t = tool(run, 'propose_edit');
    await expect(call(t, BAD_EDIT)).rejects.toThrow(/fetch_remote_flag/);
    expect(run.changeset.isEmpty()).toBe(true);

    const out = await call(t, BAD_EDIT);
    expect(out).toContain('Warning: unresolved symbols fetch_remote_flag');
    expect(run.changeset.isEmpty()).toBe(false);
    expect(run.symbolFlags).toHaveLength(1);

    applySymbolFlags(run.changeset, run.symbolFlags);
    const hunk = run.changeset.files()[0]!.hunks[0]!;
    expect(hunk.flags).toEqual([expect.objectContaining({ kind: 'unknownSymbol', symbols: ['fetch_remote_flag'] })]);
  });

  it('bounce: always bounces', async () => {
    const run = makeRun(settings({ symbolCheck: 'bounce' }));
    const t = tool(run, 'propose_edit');
    await expect(call(t, BAD_EDIT)).rejects.toThrow(/do not exist/);
    await expect(call(t, BAD_EDIT)).rejects.toThrow(/do not exist/);
    expect(run.changeset.isEmpty()).toBe(true);
  });

  it('warn: stages immediately and flags', async () => {
    const run = makeRun(settings({ symbolCheck: 'warn' }));
    await call(tool(run, 'propose_edit'), BAD_EDIT);
    expect(run.changeset.isEmpty()).toBe(false);
    expect(run.symbolFlags[0]?.symbols).toEqual(['fetch_remote_flag']);
  });

  it('off: no check at all', async () => {
    const run = makeRun(settings({ symbolCheck: 'off' }));
    const out = await call(tool(run, 'propose_edit'), BAD_EDIT);
    expect(out).not.toContain('Warning');
    expect(run.symbolFlags).toHaveLength(0);
  });

  it('suggests close names when bouncing', async () => {
    const run = makeRun(settings());
    await expect(
      call(tool(run, 'propose_edit'), { ...BAD_EDIT, new_string: '    return get_debug_flg()' }),
    ).rejects.toThrow(/did you mean: get_debug_flag/);
  });

  it('returns the matcher error when old_string is not found', async () => {
    const run = makeRun(settings({ symbolCheck: 'off' }));
    await expect(call(tool(run, 'propose_edit'), { ...BAD_EDIT, old_string: 'nothing like this' })).rejects.toThrow();
  });

  it('errors without an active run', async () => {
    const t = createEditTools(() => undefined).find((x) => x.name === 'propose_edit')!;
    await expect(call(t, BAD_EDIT)).rejects.toThrow(/No Temper run/);
  });
});

describe('create_file and submit_changeset', () => {
  it('stages a new file and refuses to overwrite an existing one', async () => {
    const run = makeRun(settings());
    const t = tool(run, 'create_file');
    expect(await call(t, { path: 'new/mod.py', content: 'X = 1\n', rationale: 'new' })).toContain('Staged new file new/mod.py');
    await expect(call(t, { path: 'app.py', content: 'x', rationale: 'dup' })).rejects.toThrow(/already exists/);
  });

  it('submit_changeset is destructive-hinted and delegates to the run', async () => {
    const run = makeRun(settings());
    await run.changeset.stage('app.py', '    return False', '    return True', 'flip');
    const t = tool(run, 'submit_changeset');
    expect(t.annotations.destructiveHint).toBe(true);
    expect(await call(t, { summary: 'done' })).toMatch(/Applied 1 hunk/);
    expect(run.submitted).toEqual(['done']);
  });

  it('run_command is read-only from the harness perspective', () => {
    expect(tool(makeRun(settings()), 'run_command').annotations.readOnlyHint).toBe(true);
  });
});

describe('same-batch propose_edit + submit_changeset', () => {
  const EDIT = { path: 'app.py', old_string: '    return False', new_string: '    return run', rationale: 'flip' };

  it('submit waits for an in-flight propose_edit before inspecting the changeset', async () => {
    const run = makeRun(settings());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    run.symbolIndex = async () => {
      await gate; // holds propose_edit before it can stage
      return new SimpleSymbolIndex(['get_debug_flag', 'run']);
    };
    const seenAtApply: boolean[] = [];
    run.applySubmitted = async (summary) => {
      seenAtApply.push(run.changeset.isEmpty());
      run.submitted.push(summary);
      return 'Applied 1 hunk in app.py; rejected 0 (none).';
    };
    const edit = call(tool(run, 'propose_edit'), EDIT);
    const submit = call(tool(run, 'submit_changeset'), { summary: 'flip it' });
    await new Promise((r) => setTimeout(r, 50));
    expect(run.submitted).toEqual([]); // submit has not run ahead of the edit
    release();
    expect(await edit).toContain('Staged edit');
    expect(await submit).toMatch(/Applied 1 hunk/);
    expect(seenAtApply).toEqual([false]);
  });

  it('returns an actionable error at once when nothing is staged and nothing is in flight', async () => {
    const run = makeRun(settings());
    const t0 = Date.now();
    await expect(call(tool(run, 'submit_changeset'), { summary: 'x' })).rejects.toThrow(/Nothing is staged.*propose_edit/);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(run.submitted).toEqual([]);
  });

  it('a failed in-flight edit releases the waiter, which then reports nothing staged', async () => {
    const run = makeRun(settings({ symbolCheck: 'off' }));
    const edit = call(tool(run, 'propose_edit'), { ...EDIT, old_string: 'no such text' });
    const submit = call(tool(run, 'submit_changeset'), { summary: 'x' });
    await expect(edit).rejects.toThrow();
    await expect(submit).rejects.toThrow(/Nothing is staged/);
  });
});

describe('StagingTracker', () => {
  it('settles immediately when idle, waits for begin/end pairs, and times out', async () => {
    const t = new StagingTracker();
    expect(await t.settle(10)).toBe(true);
    t.begin('a');
    t.begin('b');
    let done = false;
    const w = t.settle(1000).then((v) => ((done = v), v));
    t.end('a');
    await Promise.resolve();
    expect(done).toBe(false);
    t.end('b');
    expect(await w).toBe(true);
    t.begin('stuck');
    expect(await t.settle(20)).toBe(false);
    t.clear();
    expect(await t.settle(20)).toBe(true);
  });
  it('track() registers synchronously and releases on failure', async () => {
    const t = new StagingTracker();
    const p = t.track(() => Promise.reject(new Error('boom')));
    expect(t.pending).toBe(1);
    await expect(p).rejects.toThrow('boom');
    expect(t.pending).toBe(0);
  });
});

describe('run_command', () => {
  it('refuses commands that are not allowlisted', async () => {
    const t = tool(makeRun(settings()), 'run_command');
    await expect(call(t, { command: 'rm -rf .' })).rejects.toThrow(/not allowed/);
  });

  it.each(['pytest; rm -rf .', 'pytest && ls', 'pytest | cat', 'pytest > x', 'pytest $(id)', 'pytest `id`'])('refuses shell operators: %s', async (command) => {
    const t = tool(makeRun(settings()), 'run_command');
    await expect(call(t, { command })).rejects.toThrow(/Shell operators/);
  });

  it('runs inside the shadow copy, which contains the staged edits, and leaves the workspace alone', async () => {
    const run = makeRun(settings({ symbolCheck: 'off' }));
    await call(tool(run, 'propose_edit'), { path: 'sub/note.txt', old_string: 'hello', new_string: 'staged-hello', rationale: 'x' });
    const script = "process.stdout.write(require('fs').readFileSync('sub/note.txt','utf8') + '::' + process.cwd())";
    const out = await call(tool(run, 'run_command'), { command: `node -e "${script}"` });
    expect(out).toContain('Exit code 0');
    expect(out).toContain('staged-hello');
    expect(out).toContain('temper-shadow-');
    expect(out).toContain('isolated copy');
    expect(await new NodeFileSystem(root).read('sub/note.txt')).toBe('hello\n');
  });

  it('reports a non-zero exit code with output instead of failing', async () => {
    const run = makeRun(settings());
    const out = await call(tool(run, 'run_command'), { command: `node -e "process.exitCode=3,process.stderr.write('boom')"` });
    expect(out).toContain('Exit code 3');
    expect(out).toContain('boom');
  });

  it('tail-truncates long output', async () => {
    const run = makeRun(settings());
    const out = await call(tool(run, 'run_command'), { command: `node -e "console.log('a'.repeat(30000)+'THE-END')"` });
    expect(out).toContain('THE-END');
    expect(out.length).toBeLessThan(9000);
    expect(out).toContain('truncated');
  });

  it('runs in the real workspace when the shadow worktree is disabled', async () => {
    const run = makeRun(settings({ shadow: false }));
    const out = await call(tool(run, 'run_command'), { command: `node -e "process.stdout.write(process.cwd())"` });
    expect(out).toContain('[workspace]');
    expect(out.toLowerCase()).toContain(path.basename(root).toLowerCase());
  });
});
