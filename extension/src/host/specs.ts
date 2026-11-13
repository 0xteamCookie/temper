// Agent spec loading and ${MODEL} substitution. The bundled specs are JSON files in /agent that
// esbuild inlines; users may point temper.trueforge.agent / inlineAgent at their own spec file.
import { promises as fsp } from 'node:fs';
import type { AgentSpec } from '../trueforge';
import agentFile from '../../../agent/temper-agent.json';
import inlineFile from '../../../agent/temper-inline.json';
import type { RunMode } from '../shared/types';
import type { ReviewMode } from '../config/settings';

export const MCP_SERVER_NAME = 'temper';

/** Spec files wrap the inline agent spec as `{name, description, manifest}`; accept a bare spec too. */
export function manifestOf(file: unknown): Record<string, unknown> {
  if (file && typeof file === 'object') {
    const f = file as Record<string, unknown>;
    if (f.manifest && typeof f.manifest === 'object') return f.manifest as Record<string, unknown>;
    if (f.model) return f;
  }
  throw new Error('Agent spec has no "manifest" (or "model") section.');
}

/** Registry identity of each mode's agent (the bundled files' name and description). */
export function agentRef(mode: RunMode): { name: string; description: string } {
  const f = (mode === 'agent' ? agentFile : inlineFile) as { name: string; description: string };
  return { name: f.name, description: f.description };
}

export function bundledSpec(mode: RunMode): Record<string, unknown> {
  return manifestOf(mode === 'agent' ? agentFile : inlineFile);
}

/** Load the user's spec file when a path is configured; otherwise the bundled one. */
export async function loadSpecTemplate(mode: RunMode, customPath: string): Promise<Record<string, unknown>> {
  const p = customPath.trim();
  if (!p) return bundledSpec(mode);
  let text: string;
  try {
    text = await fsp.readFile(p, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read the agent spec "${p}": ${(e as Error).message}`, { cause: e });
  }
  try {
    return manifestOf(JSON.parse(text));
  } catch (e) {
    throw new Error(`The agent spec "${p}" is not valid: ${(e as Error).message}`, { cause: e });
  }
}

function substitute(value: unknown, model: string): unknown {
  if (typeof value === 'string') return value.split('${MODEL}').join(model);
  if (Array.isArray(value)) return value.map((v) => substitute(v, model));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, model)]));
  }
  return value;
}

export interface BuildSpecOptions {
  reviewMode: ReviewMode;
}

/** Fill in the model and adjust approval gating for the review mode. Does not mutate the template. */
export function buildSpec(template: Record<string, unknown>, model: string, opts: BuildSpecOptions): AgentSpec {
  const spec = substitute(structuredClone(template), model) as Record<string, unknown> & { mcp_servers?: { name?: string; require_approval_for_tools?: string[] }[] };
  spec.model = { ...(spec.model ?? {}), name: model };
  if (opts.reviewMode === 'perEdit' && Array.isArray(spec.mcp_servers)) {
    for (const s of spec.mcp_servers) {
      if (s?.name !== MCP_SERVER_NAME) continue;
      const gated = new Set<string>(s.require_approval_for_tools ?? []);
      gated.add('propose_edit');
      gated.add('create_file');
      s.require_approval_for_tools = [...gated];
    }
  }
  return spec as AgentSpec;
}
