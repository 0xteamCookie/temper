import * as vscode from 'vscode';
import { InlineDiffCodeLensProvider } from './codeLensProvider';
import { INLINE_COMMANDS } from './lensModel';
import { getSession, hasActiveSessions, onDidChangeActive } from './sessionRegistry';

export const INLINE_ACTIVE_CONTEXT_KEY = 'temper.inlineDiffActive';

function activeSession() {
  const ed = vscode.window.activeTextEditor;
  return ed ? { ed, session: getSession(ed.document.uri.toString()) } : undefined;
}

/**
 * Registers the CodeLens provider, the temper.inline.* commands and the `temper.inlineDiffActive`
 * context key. Call once from activate(); push the result onto context.subscriptions.
 */
export function registerInlineDiff(): vscode.Disposable {
  const setCtx = (v: boolean) => void vscode.commands.executeCommand('setContext', INLINE_ACTIVE_CONTEXT_KEY, v);
  setCtx(hasActiveSessions());
  const C = INLINE_COMMANDS;
  return vscode.Disposable.from(
    vscode.languages.registerCodeLensProvider({ scheme: '*' }, new InlineDiffCodeLensProvider()),
    onDidChangeActive(setCtx),
    vscode.commands.registerCommand(C.acceptHunk, (uri: string, id: string) => getSession(uri)?.decide(id, 'accept')),
    vscode.commands.registerCommand(C.rejectHunk, (uri: string, id: string) => getSession(uri)?.decide(id, 'reject')),
    vscode.commands.registerCommand(C.resetHunk, (uri: string, id: string) => getSession(uri)?.decide(id, 'pending')),
    vscode.commands.registerCommand(C.acceptAll, (uri?: string) => {
      (uri ? getSession(uri) : activeSession()?.session)?.decideAll('accept');
    }),
    vscode.commands.registerCommand(C.rejectAll, (uri?: string) => {
      (uri ? getSession(uri) : activeSession()?.session)?.decideAll('reject');
    }),
    vscode.commands.registerCommand(C.acceptAtCursor, () => decideAtCursor('accept')),
    vscode.commands.registerCommand(C.rejectAtCursor, () => decideAtCursor('reject')),
    vscode.commands.registerCommand(C.cancel, () => activeSession()?.session?.cancel()),
    vscode.commands.registerCommand(C.openSideBySide, (uri?: string) =>
      (uri ? getSession(uri) : activeSession()?.session)?.openSideBySide(),
    ),
  );
}

function decideAtCursor(d: 'accept' | 'reject'): void {
  const a = activeSession();
  if (!a?.session) return;
  const id = a.session.hunkAtLine(a.ed.selection.active.line);
  if (id) a.session.decide(id, d);
}
