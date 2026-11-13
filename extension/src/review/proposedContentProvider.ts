// Virtual documents for review diffs.
// Pattern after Cline's VscodeDiffContentProvider.ts + openMultiFileDiff.ts (Apache-2.0,
// cline/cline @ 72b3d7140553a733242126e51a7c2e87efe75c64), modified by Temper authors:
// content is held in a keyed store (not base64 in the URI query) so it can be updated live and
// onDidChange can refresh open diffs; the query carries the runId.
import * as vscode from 'vscode';

export const PROPOSED_SCHEME = 'temper-proposed';
export const ORIGINAL_SCHEME = 'temper-original';

export class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly docs = new Map<string, string>();

  static key(scheme: string, path: string, runId: string): string {
    return `${scheme}:${path.replace(/^\/+/, '')}?${runId}`;
  }

  static proposedUri(runId: string, path: string): vscode.Uri {
    return vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: '/' + path.replace(/^\/+/, ''), query: runId });
  }

  static originalUri(runId: string, path: string): vscode.Uri {
    return vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: '/' + path.replace(/^\/+/, ''), query: runId });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(ProposedContentProvider.key(uri.scheme, uri.path, uri.query)) ?? '';
  }

  /** Store content for a file and refresh any open diff showing it. */
  update(runId: string, path: string, original: string, proposed: string): void {
    const pairs: Array<[vscode.Uri, string]> = [
      [ProposedContentProvider.originalUri(runId, path), original],
      [ProposedContentProvider.proposedUri(runId, path), proposed],
    ];
    for (const [uri, text] of pairs) {
      const k = ProposedContentProvider.key(uri.scheme, uri.path, uri.query);
      if (this.docs.get(k) !== text) {
        this.docs.set(k, text);
        this.emitter.fire(uri);
      }
    }
  }

  clear(runId: string): void {
    const suffix = `?${runId}`;
    for (const k of [...this.docs.keys()]) if (k.endsWith(suffix)) this.docs.delete(k);
  }

  dispose(): void {
    this.docs.clear();
    this.emitter.dispose();
  }
}

/** Shared instance; the integrator registers it via `registerReviewProviders`. */
export const proposedContent = new ProposedContentProvider();

export function registerReviewProviders(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposedContent),
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, proposedContent),
  );
}
