import * as vscode from 'vscode';
import type { FileChange, HunkDecision } from '../shared/types';
import { contentForDecisions } from './effectiveContent';

/**
 * Apply the accepted hunks of `change` to the open document through a WorkspaceEdit, so the
 * result lands in the editor's undo stack (Ctrl+Z reverts it). Pending hunks are NOT applied.
 * The document is left dirty (unsaved) unless `save` is true. Returns false if nothing changed
 * or the edit was refused.
 */
export async function applyAcceptedToDocument(
  uri: vscode.Uri,
  change: FileChange,
  decisions: Record<string, HunkDecision>,
  opts: { save?: boolean } = {},
): Promise<boolean> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const text = contentForDecisions(change, decisions, { pendingAs: 'reject' });
  if (text === doc.getText()) return false;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
  const ok = await vscode.workspace.applyEdit(edit);
  if (ok && opts.save) await doc.save();
  return ok;
}
