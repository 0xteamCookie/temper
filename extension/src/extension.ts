import * as vscode from 'vscode';
import { TemperHost } from './host/temperHost';
import { registerInlineDiff } from './inline';
import { TemperPanelProvider } from './panel';
import { registerReviewProviders } from './review';

export function activate(context: vscode.ExtensionContext): void {
  const host = new TemperHost(context);
  const provider = new TemperPanelProvider(context.extensionUri, host);

  const cmd = (id: string, fn: (...args: never[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await (fn as (...a: unknown[]) => unknown)(...args);
        } catch (e) {
          void vscode.window.showErrorMessage(`Temper: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    );

  context.subscriptions.push(
    host,
    vscode.window.registerWebviewViewProvider(TemperPanelProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    registerReviewProviders(),
    registerInlineDiff(),
  );

  cmd('temper.openPanel', () => vscode.commands.executeCommand('workbench.view.extension.temper'));
  cmd('temper.cancel', () => host.cancel());
  cmd('temper.undoLastChange', () => host.undoLast());
  cmd('temper.selectModel', () => host.selectModel());
  cmd('temper.inlineEdit', () => host.inlineEdit());
  cmd('temper.openSession', () => host.openSession());
  cmd('temper.showLog', () => host.showLog());

  // Never block activation on TrueForge or the tool server.
  void host.init().catch((e) => {
    void vscode.window.showErrorMessage(`Temper failed to start: ${e instanceof Error ? e.message : String(e)}`);
  });
}

export function deactivate(): void {}
