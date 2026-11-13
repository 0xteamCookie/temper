import * as vscode from 'vscode';
import { TemperPanelProvider } from './panel';

const STUB_COMMANDS = [
  'temper.inlineEdit',
  'temper.cancel',
  'temper.undoLastChange',
  'temper.selectModel',
] as const;

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TemperPanelProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TemperPanelProvider.viewType, provider),
  );

  for (const command of STUB_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        void vscode.window.showInformationMessage(`Temper: ${command} is not implemented yet.`);
      }),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('temper.openPanel', () =>
      vscode.commands.executeCommand('workbench.view.extension.temper'),
    ),
  );
}

export function deactivate(): void {}
