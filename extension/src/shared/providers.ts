// Contracts for the Providers screen. Dependency-free (shared by host, tests and webview).

export interface ProviderRow {
  /** Stable key: the TrueForge provider name (e.g. "anthropic", "openrouter"). */
  name: string;
  label: string;
  kind: 'catalog' | 'custom';
  connected: boolean;
  modelCount: number;
  baseUrl?: string;
}

/** Outcome line shown under the list (what was done, or what was checked). */
export interface ProviderResult {
  /** Provider name, or 'server' for the TrueForge start/health actions. */
  scope: string;
  level: 'info' | 'error';
  text: string;
  /** A shell command the user can copy (shown for "Start TrueForge" when no script was found). */
  command?: string;
}

export interface ProviderPanelState {
  rows: ProviderRow[];
  /** Name of the provider with an action in flight, or null. */
  busy: string | null;
  result?: ProviderResult;
  /** Set when the provider list could not be loaded from TrueForge. */
  error?: string;
}
