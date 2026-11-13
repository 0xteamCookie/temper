// Pure view-model helpers for the Providers screen. No vscode imports.
import type { ProviderRow } from '../shared/providers';
import { CATALOG_PROVIDERS } from './catalog';
import type { ConfiguredProvider } from './admin';

/** Catalog providers first (connected or not), then every configured OpenAI-compatible provider. */
export function buildRows(
  configured: ConfiguredProvider[],
  served: readonly string[],
): ProviderRow[] {
  const count = (name: string, fallback: number) => {
    const n = served.filter((s) => s.startsWith(`${name}/`)).length;
    return served.length ? n : fallback;
  };
  const rows: ProviderRow[] = CATALOG_PROVIDERS.map((d) => {
    const hit = configured.find((p) => p.name === d.name && p.manifest.type === d.type);
    return {
      name: d.name,
      label: d.label,
      kind: 'catalog',
      connected: !!hit,
      modelCount: hit ? count(d.name, hit.manifest.models?.length ?? 0) : 0,
    };
  });
  const catalogNames = new Set(CATALOG_PROVIDERS.map((d) => d.name));
  for (const p of configured) {
    if (catalogNames.has(p.name) && p.manifest.type !== 'custom') continue;
    rows.push({
      name: p.name,
      label: p.name,
      kind: 'custom',
      connected: true,
      modelCount: count(p.name, p.manifest.models?.length ?? 0),
      baseUrl: p.manifest.base_url,
    });
  }
  return rows;
}

export interface CheckOutcome {
  expected: number;
  served: number;
  missing: string[];
}

/** Compare the manifest's models with what TrueForge serves (`provider/model`). */
export function compareServed(
  provider: ConfiguredProvider,
  served: readonly string[],
): CheckOutcome {
  const want = (provider.manifest.models ?? []).map((m) => `${provider.name}/${m.name}`);
  const have = new Set(served);
  const missing = want.filter((n) => !have.has(n));
  return { expected: want.length, served: want.length - missing.length, missing };
}

export function statusLabel(r: ProviderRow): string {
  return r.connected
    ? `Connected · ${r.modelCount} model${r.modelCount === 1 ? '' : 's'}`
    : 'Not connected';
}
