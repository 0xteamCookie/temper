import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { ApprovalDecision, ModelInfo } from '../shared/types';
import {
  ModelUnavailableError,
  TrueForgeError,
  TrueForgeHttpError,
  TrueForgeUnreachableError,
} from './errors';

/** A raw TrueForge stream event as delivered by the SDK (camelCase keys). */
export type RawEvent = { type: string; id?: string; [key: string]: any };

/** Agent spec passed to TrueForge (inline spec; see agent/*.json). */
export type AgentSpec = Record<string, any> & { model: { name: string } };

export interface StreamOptions {
  signal?: AbortSignal;
  previousTurnId?: string;
}

/** The surface used by TurnRunner / ModelRouter; implemented by TrueForgeClient and by test fakes. */
export interface TrueForgeClientLike {
  createSession(spec: AgentSpec): Promise<{ id: string }>;
  streamTurn(sessionId: string, text: string, opts?: StreamOptions): AsyncIterable<RawEvent>;
  subscribe(sessionId: string, turnId: string, afterEventId?: string, signal?: AbortSignal): AsyncIterable<RawEvent>;
  approve(sessionId: string, turnId: string, threadId: string, toolCallId: string, decision: ApprovalDecision): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}

export interface ProviderManifest {
  type: string;
  name?: string;
  base_url?: string;
  auth?: { api_key?: string };
  models?: Array<{ model_id: string; name: string; properties?: Record<string, unknown> }>;
  [key: string]: unknown;
}

const HTTP_TIMEOUT_MS = 10_000;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Pull the server's error message out of an `{error:{message}}` body, if present. */
function bodyMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const err = (body as any).error;
    if (err && typeof err.message === 'string') return err.message;
    if (typeof (body as any).message === 'string') return (body as any).message;
  }
  return undefined;
}

/** Convert an SDK / fetch failure into a typed TrueForge error. */
function toTypedError(e: unknown, what: string): Error {
  if (e instanceof TrueForgeError) return e;
  const status: number | undefined = (e as any)?.statusCode ?? (e as any)?.status;
  if (typeof status === 'number') {
    const body = (e as any)?.body;
    return new TrueForgeHttpError(`${what} failed (${status}): ${bodyMessage(body) ?? errText(e)}`, status, body);
  }
  if ((e as any)?.name === 'AbortError') return e as Error;
  return new TrueForgeUnreachableError(`Cannot reach TrueForge (${what}): ${errText(e)}`, e);
}

export class TrueForgeClient implements TrueForgeClientLike {
  readonly baseUrl: string;
  private readonly sdk: TrueForge;

  /** `baseUrl` is the server root (e.g. http://127.0.0.1:8790), not `.../api/v1`. */
  constructor(opts: { baseUrl: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.sdk = new TrueForge({ baseUrl: this.baseUrl });
  }

  /* ---------------- plain HTTP (wire is snake_case JSON) ---------------- */

  private async http<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (e) {
      throw new TrueForgeUnreachableError(`Cannot reach TrueForge at ${this.baseUrl}: ${errText(e)}`, e);
    }
    const text = await res.text();
    let data: any = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.status, data };
  }

  private failHttp(what: string, status: number, data: unknown): never {
    throw new TrueForgeHttpError(`${what} failed (${status}): ${bodyMessage(data) ?? JSON.stringify(data)}`, status, data);
  }

  async health(): Promise<{ ok: boolean; error?: string }> {
    try {
      const { status } = await this.http('GET', '/api/v1/models');
      return status >= 200 && status < 300 ? { ok: true } : { ok: false, error: `HTTP ${status}` };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const { status, data } = await this.http('GET', '/api/v1/models');
    if (status !== 200) this.failHttp('List models', status, data);
    const rows: any[] = Array.isArray(data?.data) ? data.data : [];
    return rows.map((m) => ({
      name: String(m.name),
      provider: String(m.provider?.name ?? String(m.name).split('/')[0] ?? ''),
      contextLength: typeof m.properties?.context_length === 'number' ? m.properties.context_length : undefined,
      health: 'unknown' as const,
    }));
  }

  async ensureMcpServer(name: string, url: string, description: string): Promise<void> {
    const { status, data } = await this.http('PUT', '/api/v1/settings/mcp-servers', {
      manifest: { type: 'remote', name, url, description },
    });
    if (status < 200 || status >= 300) this.failHttp(`Register MCP server '${name}'`, status, data);
  }

  /** Create the provider, or replace it when it already exists (409). */
  async registerProvider(manifest: ProviderManifest): Promise<void> {
    const path = '/api/v1/settings/model-providers';
    const post = await this.http('POST', path, { manifest });
    if (post.status >= 200 && post.status < 300) return;
    if (post.status !== 409) this.failHttp('Register model provider', post.status, post.data);
    const put = await this.http('PUT', path, { manifest });
    if (put.status < 200 || put.status >= 300) this.failHttp('Update model provider', put.status, put.data);
  }

  /* ---------------- sessions and turns (SDK) ---------------- */

  async createSession(spec: AgentSpec): Promise<{ id: string }> {
    try {
      const res: any = await this.sdk.sessions.create({ agent: { spec } } as any);
      const id = res?.data?.id ?? res?.id;
      if (!id) throw new TrueForgeError('TrueForge returned no session id');
      return { id };
    } catch (e) {
      const status = (e as any)?.statusCode;
      if (status === 422) {
        const msg = bodyMessage((e as any)?.body) ?? errText(e);
        throw new ModelUnavailableError(msg, { model: spec?.model?.name, body: (e as any)?.body });
      }
      throw toTypedError(e, 'Create session');
    }
  }

  async *streamTurn(sessionId: string, text: string, opts: StreamOptions = {}): AsyncIterable<RawEvent> {
    let stream: AsyncIterable<RawEvent>;
    try {
      const req: any = { input: [{ type: 'user.message', content: text }], stream: true };
      if (opts.previousTurnId) req.previousTurnId = opts.previousTurnId;
      stream = (await this.sdk.sessions.createTurnStream(sessionId, req, { abortSignal: opts.signal })) as any;
    } catch (e) {
      if (opts.signal?.aborted) return;
      throw toTypedError(e, 'Start turn');
    }
    yield* this.guard(stream, opts.signal);
  }

  async *subscribe(sessionId: string, turnId: string, afterEventId?: string, signal?: AbortSignal): AsyncIterable<RawEvent> {
    let stream: AsyncIterable<RawEvent>;
    try {
      const req: any = afterEventId ? { afterEventId } : {};
      stream = (await this.sdk.sessions.subscribeToTurn(sessionId, turnId, req, { abortSignal: signal })) as any;
    } catch (e) {
      if (signal?.aborted) return;
      throw toTypedError(e, 'Subscribe to turn');
    }
    yield* this.guard(stream, signal);
  }

  /** Iterate an SDK stream; an abort ends it silently, other failures become typed errors. */
  private async *guard(stream: AsyncIterable<RawEvent>, signal?: AbortSignal): AsyncGenerator<RawEvent> {
    try {
      for await (const ev of stream) yield ev;
    } catch (e) {
      if (signal?.aborted) return;
      throw toTypedError(e, 'Turn stream');
    }
  }

  async approve(sessionId: string, turnId: string, threadId: string, toolCallId: string, decision: ApprovalDecision): Promise<void> {
    try {
      await this.sdk.sessions.createTurnEvents(sessionId, turnId, {
        events: [{ type: 'user.tool_approval', threadId, toolCallId, approval: decision }],
      } as any);
    } catch (e) {
      throw toTypedError(e, 'Send approval');
    }
  }

  async cancel(sessionId: string): Promise<void> {
    try {
      await this.sdk.sessions.cancel(sessionId, {} as any);
    } catch (e) {
      throw toTypedError(e, 'Cancel');
    }
  }
}
