import { randomUUID } from 'node:crypto';
import type { FailureKind, ModelHealth, ModelUsage, RunEvent, RunMetrics, RunMode } from '../shared/types';
import { mergeUsage } from '../shared/usage';
import type { AgentSpec, TrueForgeClientLike } from './client';
import { sessionMetadata } from './namedAgent';
import type { AgentRef } from './namedAgent';
import { classifyFailure, describeFailure, isFallbackEligible, isRetryable, ModelUnavailableError } from './errors';
import { consumeTurn, TurnRunner } from './turnRunner';

export interface RouterConfig {
  /** TrueForge model names, in fallback order. */
  chain: string[];
  /** Retries on the same model for rateLimit/server failures before falling back. */
  retries: number;
  fallbackEnabled: boolean;
  /** Base for exponential backoff between retries (ms). Default 1000. */
  baseDelayMs?: number;
}

export interface RouterOptions extends RouterConfig {
  client: TrueForgeClientLike;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RunRequest {
  mode: RunMode;
  /** Builds the agent spec for a TrueForge model name. */
  buildSpec: (model: string) => AgentSpec;
  /** Registered TrueForge agent to create sessions by name; omit for inline specs. */
  agent?: AgentRef;
  prompt: string;
  signal?: AbortSignal;
  /** True once the turn has staged/applied anything that a replay could duplicate. */
  hasSideEffects: () => boolean;
  onEvent: (ev: RunEvent) => void;
  /** Per-mode preferred model; tried first, then the rest of the chain. */
  pick?: string;
  runId?: string;
  previousTurnId?: string;
  /**
   * Follow-up message: post the turn to this session on the first attempt (TrueForge keeps its history).
   * Falling back to another model starts a new session, since a session's model is fixed.
   */
  session?: { id: string; model?: string };
  /** Called once per attempt as soon as the turn id is known; needed to send approvals via client.approve. */
  onTurn?: (info: { sessionId: string; turnId: string; model: string }) => void;
}

export interface RunResult {
  status: 'done' | 'error' | 'cancelled';
  runId: string;
  /** Model that produced the final outcome. */
  model?: string;
  sessionId?: string;
  turnId?: string;
}

export interface ModelHealthEntry {
  health: ModelHealth;
  lastError?: string;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(finish, ms);
    function finish() {
      clearTimeout(t);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Add usage from earlier failed attempts to a done event's metrics. */
function withSpent(ev: Extract<RunEvent, { kind: 'done' }>, spent: ModelUsage[]): Extract<RunEvent, { kind: 'done' }> {
  if (spent.length === 0) return ev;
  const usage = mergeUsage([...spent, ...(ev.metrics?.usage ?? [])]);
  const sum = (f: (u: ModelUsage) => number | undefined) => usage.reduce((n, u) => n + (f(u) ?? 0), 0);
  const metrics: RunMetrics = {
    ...ev.metrics,
    usage,
    inputTokens: sum((u) => u.inputTokens),
    outputTokens: sum((u) => u.outputTokens),
    cacheReadTokens: sum((u) => u.cacheReadTokens),
    cacheWriteTokens: sum((u) => u.cacheWriteTokens),
    reasoningTokens: sum((u) => u.reasoningTokens),
  };
  return { ...ev, metrics };
}

interface Attempt {
  model: string;
  kind: FailureKind;
  message: string;
}

export class ModelRouter {
  private cfg: RouterConfig;
  private readonly client: TrueForgeClientLike;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly health = new Map<string, ModelHealthEntry>();

  constructor(opts: RouterOptions) {
    this.client = opts.client;
    this.sleep = opts.sleep ?? defaultSleep;
    this.cfg = { chain: opts.chain, retries: opts.retries, fallbackEnabled: opts.fallbackEnabled, baseDelayMs: opts.baseDelayMs };
  }

  /** Apply changed settings (chain, retries, fallback toggle). */
  setConfig(patch: Partial<RouterConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  getHealth(): Record<string, ModelHealthEntry> {
    return Object.fromEntries(this.health);
  }

  private mark(model: string, health: ModelHealth, lastError?: string): void {
    this.health.set(model, { health, lastError });
  }

  private order(pick?: string): string[] {
    const chain = this.cfg.chain;
    return pick ? [pick, ...chain.filter((m) => m !== pick)] : [...chain];
  }

  async run(req: RunRequest): Promise<RunResult> {
    const runId = req.runId ?? randomUUID();
    const { signal } = req;
    // Usage burned by failed attempts (a fallback can switch models mid-run) is folded into the final done event.
    const spent: ModelUsage[] = [];
    const emit = (ev: RunEvent) => req.onEvent(ev.kind === 'done' ? withSpent(ev, spent) : ev);
    let models = this.order(req.pick);
    if (req.session) {
      const m = req.session.model;
      const first = m && models.includes(m) ? m : models[0];
      if (first) models = [first, ...models.filter((x) => x !== first)];
    }
    const tried: Attempt[] = [];

    const finish = (status: RunResult['status'], extra: Partial<RunResult> = {}, message?: string): RunResult => {
      emit({ kind: 'done', runId, status, ...(message !== undefined ? { message } : {}) });
      return { status, runId, ...extra };
    };

    if (models.length === 0) {
      return finish('error', {}, 'No model is configured. Add a model to the Temper model chain or choose one in the model picker.');
    }

    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi]!;
      const maxAttempts = 1 + Math.max(0, this.cfg.retries);
      let last: Attempt | undefined;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal?.aborted) return finish('cancelled', { model }, 'Cancelled');

        const outcome = await this.attemptOnce(model, req, runId, emit, mi === 0 && !!req.session);
        if (outcome.type === 'done') {
          this.mark(model, 'ok');
          emit(outcome.done);
          return { status: 'done', runId, model, sessionId: outcome.sessionId, turnId: outcome.turnId };
        }
        if (outcome.type === 'cancelled') {
          emit(outcome.done);
          return { status: 'cancelled', runId, model, sessionId: outcome.sessionId, turnId: outcome.turnId };
        }
        // failure
        if (outcome.usage) spent.push(...outcome.usage);
        last = { model, kind: outcome.kind, message: outcome.message };
        this.mark(model, 'failing', outcome.message);

        if (!isFallbackEligible(outcome.kind)) {
          // mcp / other: our bug or unknown. Surface as is, never fall back.
          tried.push(last);
          return finish('error', { model, sessionId: outcome.sessionId, turnId: outcome.turnId }, outcome.message);
        }
        const canRetry = isRetryable(outcome.kind) && attempt + 1 < maxAttempts && !req.hasSideEffects();
        if (!canRetry) break;
        const delayMs = (this.cfg.baseDelayMs ?? 1000) * 2 ** attempt;
        emit({ kind: 'retry', runId, model, attempt: attempt + 1, delayMs, reason: outcome.message });
        await this.sleep(delayMs, signal);
      }

      if (signal?.aborted) return finish('cancelled', { model }, 'Cancelled');
      tried.push(last!);

      const next = models[mi + 1];
      const sideEffects = req.hasSideEffects();
      if (next && this.cfg.fallbackEnabled && !sideEffects) {
        emit({ kind: 'fallback', runId, from: model, to: next, reason: `${describeFailure(last!.kind)}: ${last!.message}` });
        continue;
      }
      let why = '';
      if (next && sideEffects) why = ' Not falling back because the agent had already staged changes.';
      else if (next && !this.cfg.fallbackEnabled) why = ' Model fallback is turned off.';
      return finish('error', { model }, this.summarize(tried) + why);
    }

    return finish('error', {}, this.summarize(tried));
  }

  private summarize(tried: Attempt[]): string {
    if (tried.length === 1) {
      const t = tried[0]!;
      return `Model ${t.model} failed (${describeFailure(t.kind)}): ${t.message}`;
    }
    const parts = tried.map((t) => `${t.model} (${describeFailure(t.kind)}: ${t.message})`);
    return `All ${tried.length} models failed. Tried ${parts.join('; ')}`;
  }

  /** One session + turn on one model. Intercepts the terminal event so the caller decides what to emit. */
  private async attemptOnce(
    model: string,
    req: RunRequest,
    runId: string,
    emit: (ev: RunEvent) => void,
    reuse = false,
  ): Promise<
    | { type: 'done'; done: Extract<RunEvent, { kind: 'done' }>; sessionId: string; turnId?: string }
    | { type: 'cancelled'; done: Extract<RunEvent, { kind: 'done' }>; sessionId?: string; turnId?: string }
    | { type: 'failure'; kind: FailureKind; message: string; sessionId?: string; turnId?: string; usage?: ModelUsage[] }
  > {
    const { signal } = req;
    let sessionId: string;
    try {
      sessionId = reuse
        ? req.session!.id
        : (
            await this.client.createSession(
              req.buildSpec(model),
              req.agent,
              sessionMetadata(req.mode),
            )
          ).id;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof ModelUnavailableError) return { type: 'failure', kind: 'unknownModel', message };
      return { type: 'failure', kind: classifyFailure(message), message };
    }
    if (signal?.aborted) {
      if (!reuse) this.client.cancel(sessionId).catch(() => undefined);
      return { type: 'cancelled', done: { kind: 'done', runId, status: 'cancelled', message: 'Cancelled' }, sessionId };
    }

    emit({ kind: 'runStart', runId, mode: req.mode, model, sessionId });

    let captured: Extract<RunEvent, { kind: 'done' }> | undefined;
    let notified = false;
    const runner: TurnRunner = new TurnRunner(runId, (ev) => {
      if (!notified && runner.turnId) {
        notified = true;
        req.onTurn?.({ sessionId, turnId: runner.turnId, model });
      }
      if (ev.kind === 'done') captured = ev;
      else emit(ev);
    }, model);

    // Local controller so we can force-end the stream shortly after cancelling server side.
    const streamCtl = new AbortController();
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      this.client.cancel(sessionId).catch(() => undefined);
      // The server answers with turn.done(cancelled); if it does not, stop waiting.
      forceTimer = setTimeout(() => streamCtl.abort(), 2000);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await consumeTurn({
        client: this.client,
        sessionId,
        text: req.prompt,
        runner,
        signal: streamCtl.signal,
        previousTurnId: req.previousTurnId,
        resumeDelayMs: 250,
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (forceTimer) clearTimeout(forceTimer);
    }

    const turnId = runner.turnId;
    if (signal?.aborted || captured?.status === 'cancelled') {
      return {
        type: 'cancelled',
        done: { ...(captured ?? { kind: 'done', runId, status: 'cancelled' as const }), status: 'cancelled', message: captured?.message ?? 'Cancelled' },
        sessionId,
        turnId,
      };
    }
    if (!captured) return { type: 'failure', kind: 'other', message: 'The TrueForge stream ended without a result.', sessionId, turnId };
    if (captured.status === 'done') return { type: 'done', done: captured, sessionId, turnId };
    const message = captured.message ?? 'Unknown error';
    return { type: 'failure', kind: classifyFailure(message), message, sessionId, turnId, usage: captured.metrics?.usage };
  }
}
