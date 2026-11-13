// Registry of live inline diff sessions, keyed by document URI string. Kept free of a
// value import of InlineDiffSession so the session, CodeLens provider and commands can all use it.
import * as vscode from 'vscode';
import type { HunkDecision } from '../shared/types';
import type { LensSpec } from './lensModel';

export interface InlineSessionHandle {
  readonly uri: string;
  lenses(): LensSpec[];
  decide(hunkId: string, decision: HunkDecision): void;
  decideAll(decision: HunkDecision): void;
  hunkAtLine(line: number): string | undefined;
  cancel(): void;
  openSideBySide(): Promise<void>;
}

const sessions = new Map<string, InlineSessionHandle>();
const activeEmitter = new vscode.EventEmitter<boolean>();
const lensEmitter = new vscode.EventEmitter<void>();

export const onDidChangeActive = activeEmitter.event;
export const onDidChangeLenses = lensEmitter.event;

export function registerSession(s: InlineSessionHandle): void {
  // Only one session per document: a newer one supersedes (cancels) the older.
  sessions.get(s.uri)?.cancel();
  sessions.set(s.uri, s);
  activeEmitter.fire(true);
  lensEmitter.fire();
}

export function unregisterSession(s: InlineSessionHandle): void {
  if (sessions.get(s.uri) === s) {
    sessions.delete(s.uri);
    activeEmitter.fire(sessions.size > 0);
    lensEmitter.fire();
  }
}

export function getSession(uri: string): InlineSessionHandle | undefined {
  return sessions.get(uri);
}

export function refreshLenses(): void {
  lensEmitter.fire();
}

export function hasActiveSessions(): boolean {
  return sessions.size > 0;
}
