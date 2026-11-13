// Builds TrueForge model-provider manifests from discovered models. Pure; no vscode imports.
import { fmtTokens } from '../shared/format';
import type { DiscoveredModel, ProviderDef } from './catalog';

export const REDACTED_KEY = '***REDACTED***';
const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_OUTPUT = 8192;

export interface CatalogModel {
  model_id: string;
  name?: string;
  properties?: Record<string, unknown>;
}

export interface ManifestModel {
  model_id: string;
  name: string;
  properties: Record<string, unknown>;
}

export interface ProviderManifestBody {
  type: string;
  name?: string;
  base_url?: string;
  auth?: { api_key: string };
  models: ManifestModel[];
}

/** TrueForge resource names: lowercase letters, digits and hyphens only. */
export function toResourceName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/** One model entry: discovery data, overridden by TrueForge catalog data when the id is known there. */
export function buildModelEntry(
  rec: DiscoveredModel,
  catalog: CatalogModel[],
  used: Set<string>,
  preferName?: string,
): ManifestModel {
  const cat = catalog.find((m) => m.model_id === rec.id);
  const properties: Record<string, unknown> = {};
  if (rec.context) properties.context_length = rec.context;
  if (rec.maxOutput) properties.max_output_tokens = rec.maxOutput;
  Object.assign(properties, cat?.properties);
  properties.context_length ||= DEFAULT_CONTEXT;
  properties.max_output_tokens ||= DEFAULT_MAX_OUTPUT;
  const base = toResourceName(preferName || cat?.name || rec.id) || 'model';
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
  used.add(name);
  return { model_id: rec.id, name, properties };
}

export interface BuildInput {
  def: ProviderDef;
  /** Real key, or REDACTED_KEY to keep the stored one (edit). Empty = no auth block. */
  apiKey: string;
  /** Resolved base URL (custom providers). */
  baseUrl?: string;
  /** Provider name for custom providers (ignored for catalog ones). */
  name?: string;
  models: DiscoveredModel[];
  catalog?: CatalogModel[];
  /** Existing TrueForge model names by model_id, kept on edit so the fallback chain keeps working. */
  keepNames?: ReadonlyMap<string, string>;
}

export function buildManifest(input: BuildInput): ProviderManifestBody {
  const { def, apiKey, baseUrl, models, catalog = [], keepNames } = input;
  if (models.length === 0) throw new Error('Pick at least one model.');
  const used = new Set<string>();
  const entries = models.map((m) => buildModelEntry(m, catalog, used, keepNames?.get(m.id)));
  const auth = apiKey ? { auth: { api_key: apiKey } } : {};
  if (def.kind === 'custom') {
    const name = toResourceName(input.name || def.name);
    if (!name) throw new Error('A provider name is required.');
    if (!baseUrl) throw new Error('A base URL is required.');
    return {
      type: 'custom',
      name,
      base_url: baseUrl.replace(/\/+$/, ''),
      ...auth,
      models: entries,
    };
  }
  return { type: def.type, ...auth, models: entries };
}

const NON_CHAT =
  /embed|whisper|tts|speech|guard|moderation|rerank|dall-e|image|audio|transcri|orpheus|safeguard/i;

/** Which discovered models to preselect: tool-capable chat models, catalog-known first, then biggest context. */
export function suggestModels(
  found: DiscoveredModel[],
  catalogIds: ReadonlySet<string>,
  max = 5,
): Set<string> {
  const ok = found.filter((m) => m.tools !== false && !NON_CHAT.test(m.id));
  const rank = (m: DiscoveredModel) => (catalogIds.has(m.id) ? 1 : 0);
  ok.sort((a, b) => rank(b) - rank(a) || (b.context ?? 0) - (a.context ?? 0));
  return new Set(ok.slice(0, max).map((m) => m.id));
}

/** QuickPick label parts for a model. */
export function describeModel(m: DiscoveredModel): { description: string; detail?: string } {
  const bits = [
    m.context ? `${fmtTokens(m.context)} context` : undefined,
    m.tools === false ? 'no tool calling' : undefined,
  ].filter((x): x is string => !!x);
  return { description: bits.join(' · ') };
}
