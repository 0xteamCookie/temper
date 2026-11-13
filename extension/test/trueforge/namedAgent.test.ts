import { describe, expect, it } from 'vitest';
import { ModelUnavailableError, TrueForgeHttpError } from '../../src/trueforge';
import { createSessionPreferNamed } from '../../src/trueforge/namedAgent';
import type { NamedAgentApi } from '../../src/trueforge/namedAgent';

const spec = { model: { name: 'p/m1' } };
const ref = { name: 'temper-agent', description: 'd' };

function fake(opts: { upsertFails?: Error; byNameFails?: Error } = {}) {
  const calls: string[] = [];
  const api: NamedAgentApi = {
    async upsertAgent(name, _d, manifest) {
      calls.push(`upsert:${name}:${manifest.model.name}`);
      if (opts.upsertFails) throw opts.upsertFails;
    },
    async createSessionByName(name) {
      calls.push(`byName:${name}`);
      if (opts.byNameFails) throw opts.byNameFails;
      return { id: 's-named' };
    },
    async createSessionInline() {
      calls.push('inline');
      return { id: 's-inline' };
    },
  };
  return { api, calls };
}

describe('createSessionPreferNamed', () => {
  it('upserts with the model being tried, then creates by name', async () => {
    const { api, calls } = fake();
    expect(await createSessionPreferNamed(api, ref, spec)).toEqual({ id: 's-named' });
    expect(calls).toEqual(['upsert:temper-agent:p/m1', 'byName:temper-agent']);
  });

  it('uses an inline spec when no agent is given', async () => {
    const { api, calls } = fake();
    expect(await createSessionPreferNamed(api, undefined, spec)).toEqual({ id: 's-inline' });
    expect(calls).toEqual(['inline']);
  });

  it('falls back inline and logs when the upsert fails', async () => {
    const { api, calls } = fake({ upsertFails: new TrueForgeHttpError('nope', 500, {}) });
    const log: string[] = [];
    expect(await createSessionPreferNamed(api, ref, spec, (l) => log.push(l))).toEqual({ id: 's-inline' });
    expect(calls).toEqual(['upsert:temper-agent:p/m1', 'inline']);
    expect(log).toHaveLength(1);
  });

  it('falls back inline when creating by name fails', async () => {
    const { api } = fake({ byNameFails: new Error('boom') });
    expect(await createSessionPreferNamed(api, ref, spec)).toEqual({ id: 's-inline' });
  });

  it('does not mask an unavailable model', async () => {
    const { api, calls } = fake({ byNameFails: new ModelUnavailableError('no such model') });
    await expect(createSessionPreferNamed(api, ref, spec)).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(calls).not.toContain('inline');
  });
});
