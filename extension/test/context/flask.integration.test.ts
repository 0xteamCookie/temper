import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ContextEngine, createNodeReader, estimateTokens } from '../../src/context';
import type { LedgerSnapshot } from '../../src/shared/types';

const FLASK = 'C:/Projects/NOV-2026/flask';
const TASK_B =
  'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

function printLedger(title: string, snap: LedgerSnapshot): void {
  const rows = snap.entries.map((e) => {
    const why = e.reasons.map((r) => `${r.reason}: ${r.detail}`).join(' | ');
    return `${e.included ? '+' : '-'} ${e.id.padEnd(46)} ${e.representation.padEnd(8)} ${String(e.tokens).padStart(5)}t  ${e.score.toFixed(1).padStart(6)}  ${why}`;
  });
  console.log(`\n== ${title}: budget ${snap.budgetTokens}, used ${snap.usedTokens}, candidates ${snap.candidates}\n${rows.join('\n')}\n`);
}

describe.skipIf(!fs.existsSync(FLASK))('flask integration', () => {
  const engine = new ContextEngine(createNodeReader(FLASK));

  it('indexes Flask in under 2 s', async () => {
    const stats = await engine.init();
    console.log('index stats', JSON.stringify(stats));
    expect(stats.files).toBeGreaterThan(100);
    expect(stats.ms.total).toBeLessThan(2000);
    // Incremental update is cheap
    const t = performance.now();
    await engine.update('src/flask/cli.py');
    console.log('incremental update ms', (performance.now() - t).toFixed(1));
  });

  it('Task B: cli.py, test_cli.py and docs/cli.rst within 16k tokens, with reasons', async () => {
    const t = performance.now();
    const res = await engine.assemble({ task: TASK_B, runId: 'taskB', budgetTokens: 16000 });
    console.log('assemble ms', (performance.now() - t).toFixed(1));
    printLedger('Task B', res.snapshot);
    expect(estimateTokens(res.text)).toBeLessThanOrEqual(16000);
    expect(res.snapshot.usedTokens).toBeLessThanOrEqual(16000);
    const included = res.snapshot.entries.filter((e) => e.included);
    for (const p of ['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst']) {
      const hits = included.filter((e) => e.path === p);
      expect(hits.length, p).toBeGreaterThan(0);
      expect(hits.every((e) => e.reasons.length > 0)).toBe(true);
    }
    expect(res.text).toContain('### src/flask/cli.py');
    expect(res.text).toContain('## Repo map');
  });

  it('get_debug_flag ranks src/flask/helpers.py first', async () => {
    const res = await engine.assemble({ task: 'get_debug_flag', runId: 'dbg', budgetTokens: 8000 });
    printLedger('get_debug_flag', res.snapshot);
    expect(res.retrieval.candidates[0]?.path).toBe('src/flask/helpers.py');
    expect(res.snapshot.entries[0]?.path).toBe('src/flask/helpers.py');
  });
});
