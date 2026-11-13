import type { FailureKind } from '../shared/types';

/** Base class for errors raised by the TrueForge layer. */
export class TrueForgeError extends Error {
  readonly status?: number;
  readonly body?: unknown;
  constructor(message: string, opts?: { status?: number; body?: unknown; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'TrueForgeError';
    this.status = opts?.status;
    this.body = opts?.body;
  }
}

/** Session creation was rejected with 422: the model/provider is not configured in TrueForge. */
export class ModelUnavailableError extends TrueForgeError {
  readonly model?: string;
  constructor(message: string, opts?: { model?: string; body?: unknown }) {
    super(message, { status: 422, body: opts?.body });
    this.name = 'ModelUnavailableError';
    this.model = opts?.model;
  }
}

/** The TrueForge server itself could not be reached (not the model provider). */
export class TrueForgeUnreachableError extends TrueForgeError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'TrueForgeUnreachableError';
  }
}

/** The TrueForge server answered with an unexpected HTTP status. */
export class TrueForgeHttpError extends TrueForgeError {
  constructor(message: string, status: number, body?: unknown) {
    super(message, { status, body });
    this.name = 'TrueForgeHttpError';
  }
}

function kindFromStatus(status: number): FailureKind {
  if (status === 422) return 'unknownModel';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rateLimit';
  if (status >= 500 && status <= 599) return 'server';
  return 'model';
}

/**
 * Classify a failure from a `turn.done` error message (string-matched, there is no
 * structured code) or from an HTTP status at session creation.
 * Formats verified against TrueForge 0.185.0, see notes/07-spike-results.md section 7.
 */
export function classifyFailure(input: string | number | undefined | null): FailureKind {
  if (typeof input === 'number') {
    const k = kindFromStatus(input);
    return k === 'model' ? 'other' : k;
  }
  const message = input ?? '';
  if (message.includes('[MCP Error]')) return 'mcp';
  if (/Unknown model\b/i.test(message) && !message.includes('[Model Error]')) return 'unknownModel';
  if (message.includes('[Model Error]')) {
    if (/Cannot connect/i.test(message)) return 'unreachable';
    const m = /Request failed \((\d{3})\)/.exec(message);
    if (m) return kindFromStatus(Number(m[1]));
    return 'model';
  }
  return 'other';
}

/** Kinds that are worth retrying on the same model before falling back. */
export function isRetryable(kind: FailureKind): boolean {
  return kind === 'rateLimit' || kind === 'server';
}

/** Kinds that may trigger a fallback to the next model in the chain. */
export function isFallbackEligible(kind: FailureKind): boolean {
  return kind !== 'mcp' && kind !== 'other';
}

const LABELS: Record<FailureKind, string> = {
  unknownModel: 'model not configured in TrueForge',
  unreachable: 'provider unreachable',
  auth: 'authentication failed',
  rateLimit: 'rate limited',
  server: 'provider server error',
  model: 'model error',
  mcp: 'tool server error',
  other: 'error',
};

export function describeFailure(kind: FailureKind): string {
  return LABELS[kind];
}
