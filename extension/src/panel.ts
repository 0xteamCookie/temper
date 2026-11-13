import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from './shared/messages';

/** What the panel needs from the extension host: it routes every WebviewMessage to `handle`. */
export interface PanelBackend {
  /** Called when a webview attaches; `post` sends a message to it. */
  attach(post: (m: HostMessage) => void): vscode.Disposable;
  handle(msg: WebviewMessage): void;
}

function isWebviewMessage(m: unknown): m is WebviewMessage {
  return !!m && typeof m === 'object' && typeof (m as { type?: unknown }).type === 'string';
}

/** Webview build output, relative to the extension root (see webview-ui/vite.config.ts). */
const WEBVIEW_DIST = ['dist', 'webview'] as const;

export class TemperPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'temper.panel';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backend: PanelBackend,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const root = vscode.Uri.joinPath(this.extensionUri, ...WEBVIEW_DIST);
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = this.renderHtml(view.webview, root);
    const attached = this.backend.attach((m) => void view.webview.postMessage(m));
    const received = view.webview.onDidReceiveMessage((m: unknown) => {
      if (isWebviewMessage(m)) this.backend.handle(m);
    });
    view.onDidDispose(() => {
      attached.dispose();
      received.dispose();
    });
  }

  private renderHtml(webview: vscode.Webview, root: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', 'index.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', 'index.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${style.toString()}" />
    <title>Temper</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${script.toString()}"></script>
  </body>
</html>`;
  }
}
