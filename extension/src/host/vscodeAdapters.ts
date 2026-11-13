// VS Code-backed adapters: a FileSystemPort that applies through WorkspaceEdit (native undo per
// file) and saves, reading unsaved editor buffers first.
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileSystemPort } from '../changeset';

export function workspaceRootPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export class VscodeFileSystem implements FileSystemPort {
  constructor(private readonly root: vscode.Uri) {}

  private uri(rel: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...rel.split('/'));
  }

  private openDoc(uri: vscode.Uri): vscode.TextDocument | undefined {
    const key = uri.toString();
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  }

  async read(rel: string): Promise<string | null> {
    const uri = this.uri(rel);
    const open = this.openDoc(uri);
    if (open && !open.isClosed) return open.getText();
    try {
      return await fsp.readFile(uri.fsPath, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null;
      throw e;
    }
  }

  async write(rel: string, content: string): Promise<void> {
    const uri = this.uri(rel);
    let exists = true;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      exists = false;
    }
    if (!exists) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
      const create = new vscode.WorkspaceEdit();
      create.createFile(uri, { ignoreIfExists: true });
      create.insert(uri, new vscode.Position(0, 0), content);
      if (!(await vscode.workspace.applyEdit(create))) throw new Error(`VS Code refused to create ${rel}.`);
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.getText() !== content) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), content);
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code refused to edit ${rel}.`);
      }
    }
    const saved = await vscode.workspace.openTextDocument(uri);
    if (saved.isDirty && !(await saved.save())) throw new Error(`Could not save ${rel}.`);
  }

  async delete(rel: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(this.uri(rel), { ignoreIfNotExists: true });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code refused to delete ${rel}.`);
  }
}
