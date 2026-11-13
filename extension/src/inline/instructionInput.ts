import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatTitle, HISTORY_PREFIX, pushHistory, stripItemPrefix, TYPED_PREFIX } from './instructionModel';

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

export interface PromptOptions {
  /** Inline-edit model name shown in the title. */
  model?: string;
  /** "Continue in chat" button: the picker is closed and nothing runs. */
  onContinueInChat?: (text: string, editor: vscode.TextEditor, range: vscode.Range) => void;
  /** "Change model" button: the picker is closed and nothing runs. */
  onChangeModel?: () => void;
}

/** Adds an instruction to the persisted inline history. */
export async function addToHistory(store: HistoryStore | undefined, instruction: string): Promise<void> {
  if (!store) return;
  await store.update(HISTORY_KEY, pushHistory(store.get<string[]>(HISTORY_KEY, []), instruction));
}

/** Ctrl+Alt+K prompt. Pass `context.globalState` (or workspaceState) to persist instruction history. */
export async function promptInstruction(store?: HistoryStore, opts: PromptOptions = {}): Promise<InstructionResult | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('Temper: open a file and select some code first.');
    return undefined;
  }
  const sel = editor.selection;
  // A selection ending at column 0 of a later line does not include that line.
  const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
  const range = new vscode.Range(sel.start.line, 0, endLine, editor.document.lineAt(endLine).range.end.character);
  const history = store?.get<string[]>(HISTORY_KEY, []) ?? [];

  const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
  qp.title = formatTitle(path.basename(editor.document.uri.fsPath), range.start.line + 1, range.end.line + 1, opts.model);
  qp.placeholder = 'Describe the change (Enter to run). Recent instructions are listed below.';
  qp.matchOnDescription = false;
  const continueBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('comment-discussion'), tooltip: 'Continue in chat' };
  const modelBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('server-process'), tooltip: 'Change model' };
  qp.buttons = [continueBtn, modelBtn];
  const refresh = () => {
    const typed = qp.value.trim();
    const items: vscode.QuickPickItem[] = [];
    if (typed) items.push({ label: TYPED_PREFIX + typed, description: 'Enter to run', alwaysShow: true });
    if (history.length) items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
    for (const h of history) if (h !== typed) items.push({ label: HISTORY_PREFIX + h, alwaysShow: true });
    qp.items = items;
    const first = items[0];
    if (typed && first) qp.activeItems = [first];
  };
  refresh();

  const instruction = await new Promise<string | undefined>((resolve) => {
    qp.onDidChangeValue(refresh);
    qp.onDidTriggerButton((b) => {
      const typed = qp.value.trim();
      resolve(undefined);
      qp.hide();
      if (b === continueBtn) opts.onContinueInChat?.(typed, editor, range);
      else opts.onChangeModel?.();
    });
    qp.onDidAccept(() => {
      const pick = qp.selectedItems[0] ?? qp.activeItems[0];
      resolve(pick && pick.kind !== vscode.QuickPickItemKind.Separator ? stripItemPrefix(pick.label) : qp.value.trim() || undefined);
      qp.hide();
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (!instruction) return undefined;
  await addToHistory(store, instruction);
  return { instruction, range, file: editor.document.uri, editor };
}
