import { describe, expect, it } from 'vitest';
import { buildSpec, bundledSpec, manifestOf } from '../../src/host/specs';

describe('agent specs', () => {
  it('bundled specs carry the ${MODEL} placeholder and reference the temper MCP server', () => {
    for (const mode of ['agent', 'inline'] as const) {
      const t = bundledSpec(mode);
      expect(JSON.stringify(t)).toContain('${MODEL}');
      const servers = t.mcp_servers as { name: string; require_approval_for_tools: string[] }[];
      expect(servers[0]!.name).toBe('temper');
      expect(servers[0]!.require_approval_for_tools).toContain('submit_changeset');
    }
  });

  it('substitutes the model everywhere and does not mutate the template', () => {
    const t = bundledSpec('agent');
    const before = JSON.stringify(t);
    const spec = buildSpec(t, 'anthropic/sonnet', { reviewMode: 'endOfRun' });
    expect(spec.model.name).toBe('anthropic/sonnet');
    expect(JSON.stringify(spec)).not.toContain('${MODEL}');
    expect(JSON.stringify(t)).toBe(before);
  });

  it('perEdit review also gates propose_edit and create_file', () => {
    const spec = buildSpec(bundledSpec('inline'), 'm/x', { reviewMode: 'perEdit' });
    const gated = (spec.mcp_servers as { require_approval_for_tools: string[] }[])[0]!.require_approval_for_tools;
    expect(gated).toEqual(expect.arrayContaining(['submit_changeset', 'propose_edit', 'create_file']));
    const plain = buildSpec(bundledSpec('inline'), 'm/x', { reviewMode: 'endOfRun' });
    expect((plain.mcp_servers as { require_approval_for_tools: string[] }[])[0]!.require_approval_for_tools).toEqual(['submit_changeset']);
  });

  it('accepts a bare spec and rejects junk', () => {
    expect(manifestOf({ model: { name: 'x' } })).toEqual({ model: { name: 'x' } });
    expect(() => manifestOf({ nope: 1 })).toThrow();
  });
});
