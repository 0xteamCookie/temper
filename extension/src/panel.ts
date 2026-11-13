import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/** Webview build output, relative to the extension root (see webview-ui/vite.config.ts). */
const WEBVIEW_DIST = ['dist', 'webview'] as const;

export class TemperPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'temper.panel';

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const root = vscode.Uri.joinPath(this.extensionUri, ...WEBVIEW_DIST);
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = this.renderHtml(view.webview, root);
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
