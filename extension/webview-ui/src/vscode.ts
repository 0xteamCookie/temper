// Typed wrapper around the VS Code webview API, with a dev-harness fallback.
// Outside VS Code (no acquireVsCodeApi) messages go to a mock handler instead.
import type { HostMessage, WebviewMessage, Mention } from '../../src/shared/messages';

export type { HostMessage, WebviewMessage, Mention };

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const isVsCode = typeof acquireVsCodeApi === 'function';

let api: VsCodeApi | undefined;
let mockHandler: ((m: WebviewMessage) => void) | undefined;

function getApi(): VsCodeApi | undefined {
  // acquireVsCodeApi may only be called once per webview.
  if (!api && isVsCode) api = acquireVsCodeApi();
  return api;
}

/** Dev harness only: receive what the UI would send to the extension host. */
export function setMockHandler(fn: (m: WebviewMessage) => void): void {
  mockHandler = fn;
}

export function postToHost(message: WebviewMessage): void {
  const a = getApi();
  if (a) a.postMessage(message);
  else mockHandler?.(message);
}

export function onHostMessage(handler: (message: HostMessage) => void): () => void {
  const listener = (event: MessageEvent<HostMessage>) => {
    if (event.data && typeof event.data === 'object' && 'type' in event.data) handler(event.data);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
