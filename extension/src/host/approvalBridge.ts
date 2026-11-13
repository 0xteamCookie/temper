// Approval -> review bridge. A TrueForge turn is paused on an approval; the user decides hunks in the
// panel or the editor; the first submit sends exactly one approve(allow|deny) back. Pure state machine
// (no vscode), driven by RunController and unit-tested with a fake client.
import type { ApprovalDecision, FileChange, HunkDecision } from '../shared/types';

export interface ReviewSubject {
  files(): FileChange[];
  setDecision(hunkId: string, decision: HunkDecision): boolean;
  setAll(decision: HunkDecision): void;
}

export interface ApprovalTarget {
  sessionId: string;
  turnId: string;
  threadId: string;
  toolCallId: string;
}

export interface BridgeClient {
  approve(sessionId: string, turnId: string, threadId: string, toolCallId: string, decision: ApprovalDecision): Promise<void>;
}

export type DecisionOrigin = 'webview' | 'editor';

export type BridgeOutcome =
  | { kind: 'allow'; accepted: number; rejected: number; userReason?: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string };

export interface BridgeHooks {
  /** Decisions changed; `origin` says who changed them so the other surface can be refreshed. */
  onDecisionsChanged?(files: FileChange[], origin: DecisionOrigin): void;
  /** About to send the approval: close editor review UI first (applying edits would otherwise cancel it). */
  beforeSend?(outcome: BridgeOutcome): void;
}

export const DENY_ALL_REASON = 'User rejected all proposed hunks; ask what to change.';

export function countDecisions(files: FileChange[]): { accepted: number; rejected: number; pending: number } {
  let accepted = 0;
  let rejected = 0;
  let pending = 0;
  for (const f of files) {
    for (const h of f.hunks) {
      if (h.decision === 'accept') accepted++;
      else if (h.decision === 'reject') rejected++;
      else pending++;
    }
  }
  return { accepted, rejected, pending };
}

export class ApprovalBridge {
  private current?: {
    target: ApprovalTarget | undefined;
    subject: ReviewSubject;
    requireAll: boolean;
    resolve(o: BridgeOutcome): void;
  };

  constructor(
    private readonly client: BridgeClient,
    private readonly hooks: BridgeHooks = {},
  ) {}

  get state(): 'idle' | 'awaiting' {
    return this.current ? 'awaiting' : 'idle';
  }

  /** Wait for the user's decision on `subject`; resolves after the approval has been sent (or on abort). */
  open(target: ApprovalTarget | undefined, subject: ReviewSubject, opts: { requireAll?: boolean } = {}): Promise<BridgeOutcome> {
    if (this.current) this.finish({ kind: 'aborted' }); // a new approval supersedes a stale one
    return new Promise<BridgeOutcome>((resolve) => {
      this.current = { target, subject, requireAll: opts.requireAll === true, resolve };
    });
  }

  decide(hunkId: string, decision: HunkDecision, origin: DecisionOrigin = 'webview'): void {
    const c = this.current;
    if (!c) return;
    if (c.subject.setDecision(hunkId, decision)) this.hooks.onDecisionsChanged?.(c.subject.files(), origin);
  }

  decideAll(decision: HunkDecision, origin: DecisionOrigin = 'webview'): void {
    const c = this.current;
    if (!c) return;
    c.subject.setAll(decision);
    this.hooks.onDecisionsChanged?.(c.subject.files(), origin);
  }

  /** Send the verdict. Undecided hunks count as not accepted. Ignored when nothing awaits a decision. */
  async submit(reason?: string): Promise<void> {
    const c = this.current;
    if (!c) return;
    this.current = undefined; // closes the window for a double submit
    const { accepted, rejected, pending } = countDecisions(c.subject.files());
    const userReason = reason?.trim() || undefined;
    let outcome: BridgeOutcome;
    let decision: ApprovalDecision;
    if (accepted > 0 && c.requireAll && rejected + pending > 0) {
      const total = accepted + rejected + pending;
      const text =
        userReason ?? `Only ${accepted} of ${total} hunks were accepted; propose a narrower edit that can be accepted in full.`;
      decision = { status: 'deny', reason: text };
      outcome = { kind: 'deny', reason: text };
    } else if (accepted > 0) {
      decision = { status: 'allow' };
      outcome = { kind: 'allow', accepted, rejected: rejected + pending, userReason };
    } else {
      const text = userReason ?? DENY_ALL_REASON;
      decision = { status: 'deny', reason: text };
      outcome = { kind: 'deny', reason: text };
    }
    try {
      this.hooks.beforeSend?.(outcome);
    } catch {
      /* UI teardown must not block the verdict */
    }
    try {
      if (c.target) await this.client.approve(c.target.sessionId, c.target.turnId, c.target.threadId, c.target.toolCallId, decision);
    } catch (e) {
      c.resolve({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      return;
    }
    c.resolve(outcome);
  }

  /** Cancel or supersede without sending anything (the turn is being cancelled server side). */
  abort(): void {
    this.finish({ kind: 'aborted' });
  }

  private finish(o: BridgeOutcome): void {
    const c = this.current;
    this.current = undefined;
    c?.resolve(o);
  }
}
