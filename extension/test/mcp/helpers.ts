import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/** Copies fixtures/ws to a temp dir and adds the directories that must be excluded from tools. */
export function makeFixtureRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'temper-mcp-'));
  cpSync(path.join(__dirname, 'fixtures', 'ws'), dir, { recursive: true });
  mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'get_debug_flag secret\n');
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  writeFileSync(path.join(dir, '.git', 'HEAD'), 'get_debug_flag ref\n');
  return dir;
}
