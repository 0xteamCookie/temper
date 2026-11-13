import * as vscode from 'vscode';
import { getSession, onDidChangeLenses } from './sessionRegistry';

/** Emits the CodeLens model of whichever InlineDiffSession owns the document. */
export class InlineDiffCodeLensProvider implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses = onDidChangeLenses;

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const session = getSession(document.uri.toString());
    if (!session) return [];
    return session.lenses().map((l) => {
      const range = new vscode.Range(l.line, 0, l.line, 0);
      const command: vscode.Command = { title: l.title, command: l.command, arguments: l.args, tooltip: l.tooltip };
      return new vscode.CodeLens(range, command);
    });
  }
}
