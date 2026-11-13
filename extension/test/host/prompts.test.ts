import { describe, expect, it } from 'vitest';
import { buildInlinePrompt, composeAgentPrompt } from '../../src/host/prompts';

describe('composeAgentPrompt', () => {
  it('prepends mentions as @ lines, deduplicated', () => {
    const p = composeAgentPrompt('fix it', [
      { kind: 'file', value: 'src/a.py' },
      { kind: 'symbol', value: 'Foo' },
      { kind: 'file', value: 'src/a.py' },
    ]);
    expect(p).toBe('@src/a.py\n@symbol:Foo\n\nfix it');
  });
  it('returns the text unchanged without mentions', () => {
    expect(composeAgentPrompt('hi')).toBe('hi');
  });
});

describe('buildInlinePrompt', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`);
  it('includes path, range, numbered selection and +-20 lines of context', () => {
    const p = buildInlinePrompt({ path: 'a/b.py', instruction: 'rename', lines, startLine: 40, endLine: 42 });
    expect(p).toContain('File: a/b.py');
    expect(p).toContain('Selection: lines 40-42');
    expect(p).toContain('40| line40');
    expect(p).toContain('Context before (lines 20-39)');
    expect(p).toContain('Context after (lines 43-62)');
    expect(p).not.toContain('line19');
    expect(p).not.toContain('line63');
  });
  it('clamps at the file edges', () => {
    const p = buildInlinePrompt({ path: 'x', instruction: 'i', lines: ['a', 'b'], startLine: 1, endLine: 2 });
    expect(p).not.toContain('Context before');
    expect(p).not.toContain('Context after');
  });
});
