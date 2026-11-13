import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ShadowWorktree, listProjectFiles, shadowEnv } from '../../src/host/shadow';

let root: string;
const shadows: ShadowWorktree[] = [];

function git(...args: string[]) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'temper-shadow-src-'));
  git('init', '-q');
  mkdirSync(path.join(root, 'src', 'pkg'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'pkg', 'a.py'), 'A = 1\n');
  writeFileSync(path.join(root, 'tracked.txt'), 'tracked\n');
  writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\nnode_modules/\n');
  writeFileSync(path.join(root, 'ignored.txt'), 'secret\n');
  writeFileSync(path.join(root, 'node_modules', 'x', 'i.js'), 'x\n');
  git('add', 'tracked.txt', '.gitignore');
  writeFileSync(path.join(root, 'untracked.txt'), 'untracked\n'); // -o picks it up
});

afterEach(async () => {
  for (const s of shadows.splice(0)) await s.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe('listProjectFiles', () => {
  it('lists tracked + untracked, excluding ignored files', async () => {
    const files = (await listProjectFiles(root)).sort();
    expect(files).toEqual(['.gitignore', 'src/pkg/a.py', 'tracked.txt', 'untracked.txt']);
  });

  it('falls back to the supplied walk outside a git repo', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'temper-nogit-'));
    try {
      const files = await listProjectFiles(plain, async () => ['x.py']);
      expect(files).toEqual(['x.py']);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('ShadowWorktree', () => {
  it('copies the project files, writes overlay files over them and cleans up', async () => {
    const s = new ShadowWorktree(root, `t${Date.now()}`);
    shadows.push(s);
    await s.sync([
      { path: 'src/pkg/a.py', content: 'A = 2\n' },
      { path: 'src/pkg/new/b.py', content: 'B = 1\n' },
    ]);
    expect(readFileSync(path.join(s.dir, 'tracked.txt'), 'utf8')).toBe('tracked\n');
    expect(readFileSync(path.join(s.dir, 'untracked.txt'), 'utf8')).toBe('untracked\n');
    expect(readFileSync(path.join(s.dir, 'src', 'pkg', 'a.py'), 'utf8')).toBe('A = 2\n');
    expect(readFileSync(path.join(s.dir, 'src', 'pkg', 'new', 'b.py'), 'utf8')).toBe('B = 1\n');
    expect(existsSync(path.join(s.dir, 'ignored.txt'))).toBe(false);
    expect(existsSync(path.join(s.dir, 'node_modules'))).toBe(false);
    // the real tree is untouched
    expect(readFileSync(path.join(root, 'src', 'pkg', 'a.py'), 'utf8')).toBe('A = 1\n');
    expect(existsSync(path.join(root, 'src', 'pkg', 'new'))).toBe(false);

    await s.dispose();
    expect(existsSync(s.dir)).toBe(false);
  });

  it('refuses overlay paths that escape the shadow directory', async () => {
    const s = new ShadowWorktree(root, `esc${Date.now()}`);
    shadows.push(s);
    await s.sync([{ path: '../escaped.txt', content: 'x' }]);
    expect(existsSync(path.join(path.dirname(s.dir), 'escaped.txt'))).toBe(false);
  });

  it('re-syncing overwrites earlier overlay content', async () => {
    const s = new ShadowWorktree(root, `re${Date.now()}`);
    shadows.push(s);
    await s.sync([{ path: 'tracked.txt', content: 'v1' }]);
    await s.sync([{ path: 'tracked.txt', content: 'v2' }]);
    expect(readFileSync(path.join(s.dir, 'tracked.txt'), 'utf8')).toBe('v2');
  });
});

describe('shadowEnv', () => {
  it('prefixes PATH with the workspace venv and points PYTHONPATH at the shadow', () => {
    const win = shadowEnv({ Path: 'C:\\bin', PYTHONPATH: 'old' }, 'C:\\ws', 'C:\\tmp\\sh', 'win32');
    expect(win.Path?.startsWith(path.join('C:\\ws', '.venv', 'Scripts') + ';')).toBe(true);
    expect(win.PYTHONPATH?.split(';')).toEqual([path.join('C:\\tmp\\sh', 'src'), 'C:\\tmp\\sh', 'old']);
    const posix = shadowEnv({ PATH: '/usr/bin' }, '/ws', '/tmp/sh', 'linux');
    expect(posix.PATH?.startsWith(path.join('/ws', '.venv', 'bin') + ':')).toBe(true);
    expect(posix.PYTHONPATH).toBe([path.join('/tmp/sh', 'src'), '/tmp/sh'].join(':'));
  });

  it('leaves PYTHONPATH alone without a shadow', () => {
    expect(shadowEnv({ PATH: 'x' }, '/ws', undefined, 'linux').PYTHONPATH).toBeUndefined();
  });
});
