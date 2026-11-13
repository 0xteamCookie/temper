import * as vscode from 'vscode';
import { formatTitle, pushHistory } from './instructionModel';

export interface InstructionResult {
  instruction: string;
  /** Selection at the time the prompt was opened (expanded to whole lines for the edit scope). */
  range: vscode.Range;
  file: vscode.Uri;
  editor: vscode.TextEditor;
}

export interface HistoryStore {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

const HISTORY_KEY = 'temper.inline.history';



/** Ctrl+Alt+K prompt. Pass `context.globalState` (or workspaceState) to persist instruction history. */
export async function promptInstruction(store?: HistoryStore): Promise<InstructionResult | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('Temper: open a file and select some code first.');
    return undefined;
  }
  const sel = editor.selection;
  // A selection ending at column 0 of a later line does not include that line.
  const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
  const range = new vscode.Range(sel.start.line, 0, endLine, editor.document.lineAt(endLine).range.end.character);
  let history = store?.get<string[]>(HISTORY_KEY, []) ?? [];

  const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
  qp.title = formatTitle(range.start.line + 1, range.end.line + 1);
  qp.placeholder = 'Describe the change (Enter to run). Recent instructions are listed below.';
  qp.matchOnDescription = false;
  const refresh = () => {
    const typed = qp.value.trim();
    const items: vscode.QuickPickItem[] = [];
    if (typed) items.push({ label: typed, description: 'run', alwaysShow: true });
    if (history.length) items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
    for (const h of history) if (h !== typed) items.push({ label: h, alwaysShow: true });
    qp.items = items;
    const first = items[0];
    if (typed && first) qp.activeItems = [first];
  };
  refresh();

  const instruction = await new Promise<string | undefined>((resolve) => {
    qp.onDidChangeValue(refresh);
    qp.onDidAccept(() => {
      const pick = qp.selectedItems[0] ?? qp.activeItems[0];
      resolve(pick && pick.kind !== vscode.QuickPickItemKind.Separator ? pick.label : qp.value.trim() || undefined);
      qp.hide();
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!instruction) return undefined;
  history = pushHistory(history, instruction);
  await store?.update(HISTORY_KEY, history);
  return { instruction, range, file: editor.document.uri, editor };
}
