import * as vscode from 'vscode';
import { PricingService } from './service';
import type { PriceOverrides } from './resolve';

export { PricingService } from './service';
export { resolvePrice, resolveContext } from './resolve';
export type { PriceOverrides } from './resolve';

/** Read `temper.pricing.*` straight from VS Code settings (kept out of config/settings.ts on purpose). */
export function readPricingConfig(): { fetch: boolean; overrides: PriceOverrides } {
  const cfg = vscode.workspace.getConfiguration('temper');
  const raw = cfg.get<Record<string, unknown>>('pricing.overrides') ?? {};
  const overrides: PriceOverrides = {};
  for (const [name, v] of Object.entries(raw)) {
    const o = v as {
      input?: unknown;
      output?: unknown;
      cacheRead?: unknown;
      cacheWrite?: unknown;
    } | null;
    if (!o || typeof o.input !== 'number' || typeof o.output !== 'number') continue;
    overrides[name] = {
      input: o.input,
      output: o.output,
      ...(typeof o.cacheRead === 'number' ? { cacheRead: o.cacheRead } : {}),
      ...(typeof o.cacheWrite === 'number' ? { cacheWrite: o.cacheWrite } : {}),
    };
  }
  return { fetch: cfg.get<boolean>('pricing.fetch') ?? true, overrides };
}

export function createPricingService(
  context: vscode.ExtensionContext,
  log: (line: string) => void,
): PricingService {
  return new PricingService(context.globalStorageUri.fsPath, readPricingConfig, undefined, log);
}
