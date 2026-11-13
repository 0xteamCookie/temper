// Named-agent sessions: Temper registers its agents in TrueForge and creates sessions by name so the
// Sessions page shows which agent ran. TrueForge has no per-session model override, so the agent's
// manifest is updated to the model being tried before each session. Any failure falls back to an
// inline spec, so a run is never blocked by the registry.
import type { AgentSpec } from './client';
import { ModelUnavailableError } from './errors';

export interface AgentRef {
  name: string;
  description: string;
}

export interface NamedAgentApi {
  /** Create the agent, or update it when it already exists. */
  upsertAgent(name: string, description: string, manifest: AgentSpec): Promise<void>;
  createSessionByName(name: string): Promise<{ id: string }>;
  createSessionInline(spec: AgentSpec): Promise<{ id: string }>;
}

export async function createSessionPreferNamed(
  api: NamedAgentApi,
  ref: AgentRef | undefined,
  spec: AgentSpec,
  log?: (line: string) => void,
): Promise<{ id: string }> {
  if (!ref) return api.createSessionInline(spec);
  try {
    await api.upsertAgent(ref.name, ref.description, spec);
    return await api.createSessionByName(ref.name);
  } catch (e) {
    // A model TrueForge rejects would fail inline too; report it as is.
    if (e instanceof ModelUnavailableError) throw e;
    log?.(`Could not use the named agent '${ref.name}' (${e instanceof Error ? e.message : String(e)}); using an inline spec instead.`);
    return api.createSessionInline(spec);
  }
}

/** Metadata Temper stamps on the sessions it creates; History filters on it (inline edits stay hidden). */
export function sessionMetadata(mode: 'agent' | 'inline'): Record<string, string> {
  return { app: 'temper', mode };
}
