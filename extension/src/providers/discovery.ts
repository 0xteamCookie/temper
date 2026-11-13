// Model discovery: calls a provider's model-LIST endpoint only (never inference), with the user's key held
// in memory for the duration of the call. Errors are scrubbed of keys. No vscode imports.
import type { DiscoveredModel, ProviderDef } from './catalog';
import { scrubSecrets } from './scrub';

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const num = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 ? v : undefined);
const MAX_PAGES = 10;
const TIMEOUT_MS = 15_000;

export interface DiscoverInput {
  def: ProviderDef;
  key?: string;
  /** Base URL to list from (custom providers: the manifest base URL; catalog: def.listBase). */
  baseUrl?: string;
}

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  secrets: string[],
): Promise<unknown> {
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    // eslint-disable-next-line preserve-caught-error -- the cause is dropped on purpose; it could carry a key
    throw new Error(
      `Cannot reach ${new URL(url).host}: ${scrubSecrets(e instanceof Error ? e.message : String(e), secrets)}`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = '';
    try {
      const j = obj(JSON.parse(text));
      detail = String(obj(j.error).message ?? j.error ?? j.message ?? '');
    } catch {
      /* body is not JSON */
    }
    const hint = res.status === 401 || res.status === 403 ? ' (the key was rejected)' : '';
    throw new Error(
      scrubSecrets(
        `${new URL(url).host} answered HTTP ${res.status}${hint}${detail ? `: ${detail.slice(0, 120)}` : ''}`,
        secrets,
      ),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).host} did not return JSON`);
  }
}

const bearer = (key?: string): Record<string, string> =>
  key ? { authorization: `Bearer ${key}` } : {};

/** OpenAI-style list: `{data:[...]}` or a bare array (Together). */
function openaiRows(json: unknown): Json[] {
  const rows = Array.isArray(json) ? json : obj(json).data;
  return Array.isArray(rows) ? (rows as Json[]) : [];
}

export async function discoverModels(
  input: DiscoverInput,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<DiscoveredModel[]> {
  const { def, key } = input;
  const base = (input.baseUrl ?? def.baseUrl ?? def.listBase ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('No base URL to list models from.');
  const secrets = key ? [key] : [];

  if (def.list === 'anthropic') {
    const headers = { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' };
    const out: DiscoveredModel[] = [];
    let after: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const q = new URLSearchParams({ limit: '100', ...(after ? { after_id: after } : {}) });
      const page = obj(await getJson(fetchImpl, `${base}/models?${q}`, headers, secrets));
      for (const m of (Array.isArray(page.data) ? page.data : []) as Json[]) {
        out.push({
          id: String(m.id),
          context: num(m.max_input_tokens),
          maxOutput: num(m.max_tokens),
          tools: true,
        });
      }
      after = page.has_more === true && typeof page.last_id === 'string' ? page.last_id : undefined;
      if (!after) break;
    }
    return out;
  }

  if (def.list === 'gemini') {
    const headers = { 'x-goog-api-key': key ?? '' };
    const out: DiscoveredModel[] = [];
    let token: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const q = new URLSearchParams({ pageSize: '100', ...(token ? { pageToken: token } : {}) });
      const page = obj(await getJson(fetchImpl, `${base}/models?${q}`, headers, secrets));
      for (const m of (Array.isArray(page.models) ? page.models : []) as Json[]) {
        const methods = Array.isArray(m.supportedGenerationMethods)
          ? (m.supportedGenerationMethods as unknown[])
          : [];
        if (!methods.includes('generateContent')) continue;
        out.push({
          id: String(m.name).replace(/^models\//, ''),
          context: num(m.inputTokenLimit),
          maxOutput: num(m.outputTokenLimit),
          tools: true,
        });
      }
      token =
        typeof page.nextPageToken === 'string' && page.nextPageToken
          ? page.nextPageToken
          : undefined;
      if (!token) break;
    }
    return out;
  }

  const rows = openaiRows(await getJson(fetchImpl, `${base}/models`, bearer(key), secrets));
  return rows.map((m) => {
    const params = m.supported_parameters;
    return {
      id: String(m.id),
      context:
        num(m.context_length) ?? num(m.context_window) ?? num(obj(m.top_provider).context_length),
      maxOutput: num(m.max_completion_tokens) ?? num(obj(m.top_provider).max_completion_tokens),
      // OpenRouter reports capabilities; for the rest "unknown" must not disqualify a model.
      tools: Array.isArray(params) ? params.includes('tools') : undefined,
    };
  });
}
