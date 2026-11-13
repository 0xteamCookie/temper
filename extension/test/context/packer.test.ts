import { describe, expect, it } from 'vitest';
import { ContextEngine, estimateTokens, pack, parseMention, parseMentions, resolveBudget, Retriever, WorkspaceIndex } from '../../src/context';
import { memReader, TOY } from './helpers';

describe('budget', () => {
  it('adaptive default is 25% of context clamped to 4k..48k; explicit wins', () => {
    expect(resolveBudget({ contextLength: 64000 })).toBe(16000);
    expect(resolveBudget({ contextLength: 8000 })).toBe(4000);
    expect(resolveBudget({ contextLength: 1_000_000 })).toBe(48000);
    expect(resolveBudget({ contextLength: 64000, budgetTokens: 1234 })).toBe(1234);
  });
  it('token estimate is within a sane range of chars/4', () => {
    const s = 'def get_debug_flag(self, x=1):\n    return x + 1\n'.repeat(50);
    const e = estimateTokens(s);
    expect(e).toBeGreaterThan(s.length / 8);
    expect(e).toBeLessThan(s.length / 2);
  });
});

describe('mentions', () => {
  it('parses @path and @symbol', () => {
    expect(parseMentions('look at @src/app/cli.py and @symbol:run_command, then @helpers.py.')).toEqual([
      { kind: 'file', value: 'src/app/cli.py' },
      { kind: 'symbol', value: 'run_command' },
      { kind: 'file', value: 'helpers.py' },
    ]);
    expect(parseMentions('mail me@example.com')).toEqual([]);
    expect(parseMention('@run_command')).toEqual({ kind: 'symbol', value: 'run_command' });
  });
});

describe('pack invariants', () => {
  it('never exceeds the budget and always includes mentions', async () => {
    const idx = new WorkspaceIndex(memReader(TOY));
    await idx.build();
    const r = new Retriever(idx);
    const res = r.retrieve('add a debug option to the run command', {
      mentions: [
        { kind: 'file', value: 'src/app/cli.py' },
        { kind: 'symbol', value: 'get_debug_flag' },
      ],
      pinned: [],
      evicted: [],
    });
    for (const budget of [300, 500, 800, 1500, 4000, 16000]) {
      const p = pack(idx, res.candidates, { runId: 'r', task: 't', budgetTokens: budget, queryTerms: res.queryTerms });
      expect(estimateTokens(p.text), `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(p.snapshot.usedTokens).toBeLessThanOrEqual(budget);
      expect(p.snapshot.budgetTokens).toBe(budget);
      if (budget >= 500) {
        const inc = p.snapshot.entries.filter((e) => e.included);
        expect(inc.some((e) => e.path === 'src/app/cli.py' && e.reasons.some((x) => x.reason === 'mention')), `mention cli @${budget}`).toBe(true);
        expect(inc.some((e) => e.path === 'src/app/helpers.py'), `symbol mention @${budget}`).toBe(true);
      }
    }
  });

  it('tiers: full for top, headers carry reasons', async () => {
    const eng = new ContextEngine(memReader(TOY));
    const res = await eng.assemble({ task: 'fix run_command debug handling', runId: 'r1', budgetTokens: 4000 });
    expect(res.text).toMatch(/^### src\/app\/cli\.py \(lines \d+-\d+\).* — defines `run_command`/m);
    expect(res.text).toContain('## Repo map');
    expect(res.snapshot.entries.some((e) => e.representation === 'full')).toBe(true);
    for (const e of res.snapshot.entries) expect(e.reasons.length).toBeGreaterThan(0);
  });

  it('pin and evict affect the next retrieval; agent reads appear in the ledger', async () => {
    const eng = new ContextEngine(memReader(TOY));
    const events: string[] = [];
    eng.ledger.onDidChange((e) => events.push(e.type));
    await eng.assemble({ task: 'run_command', runId: 'a', budgetTokens: 4000 });
    eng.ledger.evict('src/app/cli.py');
    eng.ledger.pin('README.md');
    const res = await eng.assemble({ task: 'run_command', runId: 'b', budgetTokens: 4000 });
    const cli = res.snapshot.entries.filter((e) => e.path === 'src/app/cli.py');
    expect(cli.length).toBeGreaterThan(0);
    expect(cli.every((e) => !e.included && e.evicted)).toBe(true);
    const readme = res.snapshot.entries.find((e) => e.path === 'README.md');
    expect(readme).toMatchObject({ included: true, pinned: true });
    eng.noteAgentRead('b', { path: 'src/app/helpers.py', tool: 'read_file', content: 'def x(): pass' });
    const snap = eng.ledger.get('b');
    expect(snap?.entries.some((e) => e.path === 'src/app/helpers.py' && e.reasons.some((r) => r.reason === 'agent'))).toBe(true);
    expect(events).toEqual(expect.arrayContaining(['snapshot', 'pins', 'agentRead']));
  });
});
