// TrueForge integration: SDK client, turn normalization, error classification, and model routing.
// Pure TypeScript (no `vscode` imports).
export { TrueForgeClient } from './client';
export type { AgentSpec, ProviderManifest, RawEvent, StreamOptions, TrueForgeClientLike } from './client';
export { TurnRunner, consumeTurn, unwrapToolContent } from './turnRunner';
export type { ConsumeOptions } from './turnRunner';
export {
  ModelUnavailableError,
  TrueForgeError,
  TrueForgeHttpError,
  TrueForgeUnreachableError,
  classifyFailure,
  describeFailure,
  isFallbackEligible,
  isRetryable,
} from './errors';
export { ModelRouter } from './router';
export type { ModelHealthEntry, RouterConfig, RouterOptions, RunRequest, RunResult } from './router';
