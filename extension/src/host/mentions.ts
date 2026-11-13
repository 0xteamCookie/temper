// @mention suggestions for the panel: workspace files and symbols (top 20).
import * as vscode from 'vscode';
import type { Mention } from '../shared/messages';

const EXCLUDE = '**/{node_modules,.git,.venv,venv,dist,out,build,__pycache__,.mypy_cache,.pytest_cache}/**';

function globEscape(s: string): string {
  return s.replace(/[\\{}[\]*?]/g, '\\$&');
}

export async function mentionSuggestions(query: string, limit = 20): Promise<Mention[]> {
  const q = query.trim().replace(/^@/, '');
  const items: Mention[] = [];
  const seen = new Set<string>();
  const add = (m: Mention): void => {
    const k = `${m.kind}:${m.value}`;
    if (!seen.has(k) && items.length < limit) {
      seen.add(k);
      items.push(m);
    }
  };

  const filesP: Thenable<vscode.Uri[]> = vscode.workspace.findFiles(q ? `**/*${globEscape(q)}*` : '**/*', EXCLUDE, 60);
  const symbolsP: Thenable<vscode.SymbolInformation[] | undefined> = q
    ? vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', q)
    : Promise.resolve(undefined);
  const [files, symbols] = await Promise.all([
    Promise.resolve(filesP).catch(() => [] as vscode.Uri[]),
    Promise.resolve(symbolsP).catch(() => undefined),
  ]);

  const rels = files
    .map((u) => vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/'))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  const fileQuota = symbols && symbols.length ? Math.ceil(limit * 0.6) : limit;
  for (const r of rels.slice(0, fileQuota)) add({ kind: 'file', value: r });
  for (const s of symbols ?? []) add({ kind: 'symbol', value: s.name });
  for (const r of rels.slice(fileQuota)) add({ kind: 'file', value: r });
  return items;
}
