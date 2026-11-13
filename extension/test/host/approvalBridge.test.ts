import { describe, expect, it } from 'vitest';
import { ApprovalBridge, DENY_ALL_REASON } from '../../src/host/approvalBridge';
import type { ReviewSubject } from '../../src/host/approvalBridge';
import type { ApprovalDecision, FileChange, Hunk, HunkDecision } from '../../src/shared/types';

function hunk(id: string, decision: HunkDecision = 'pending'): Hunk {
  return { id, path: 'a.py', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: '@@', lines: [], flags: [], decision };
}

class Subject implements ReviewSubject {
  hunks: Hunk[];
  constructor(ids: string[]) {
    this.hunks = ids.map((i) => hunk(i));
  }
  files(): FileChange[] {
    return [{ path: 'a.py', kind: 'modify', original: '', proposed: '', hunks: this.hunks }];
  }
  setDecision(id: string, d: HunkDecision) {
    const h = this.hunks.find((x) => x.id === id);
    if (h) h.decision = d;
    return !!h;
  }
  setAll(d: HunkDecision) {
    this.hunks.forEach((h) => (h.decision = d));
  }
}

class FakeClient {
  calls: { toolCallId: string; decision: ApprovalDecision }[] = [];
  fail = false;
  async approve(_s: string, _t: string, _th: string, toolCallId: string, decision: ApprovalDecision) {
    if (this.fail) throw new Error('network down');
    this.calls.push({ toolCallId, decision });
  }
}
const target = { sessionId: 's', turnId: 't', threadId: 'main', toolCallId: 'c1' };

describe('ApprovalBridge', () => {
  it('allows when at least one hunk is accepted, counting undecided as rejected', async () => {
    const c = new FakeClient();
    const b = new ApprovalBridge(c);
    const s = new Subject(['h1', 'h2', 'h3']);
    const p = b.open(target, s);
    expect(b.state).toBe('awaiting');
    b.decide('h1', 'accept');
    b.decide('h2', 'reject');
    await b.submit();
    expect(await p).toEqual({ kind: 'allow', accepted: 1, rejected: 2, userReason: undefined });
    expect(c.calls).toEqual([{ toolCallId: 'c1', decision: { status: 'allow' } }]);
    expect(b.state).toBe('idle');
  });

  it('denies with the default reason when nothing is accepted', async () => {
    const c = new FakeClient();
    const b = new ApprovalBridge(c);
    const p = b.open(target, new Subject(['h1']));
    b.decideAll('reject');
    await b.submit();
    expect(await p).toEqual({ kind: 'deny', reason: DENY_ALL_REASON });
    expect(c.calls[0]!.decision).toEqual({ status: 'deny', reason: DENY_ALL_REASON });
  });

  it('uses the typed reason on deny', async () => {
    const c = new FakeClient();
    const b = new ApprovalBridge(c);
    const p = b.open(target, new Subject(['h1']));
    await b.submit('  use a different name  ');
    expect(await p).toEqual({ kind: 'deny', reason: 'use a different name' });
  });

  it('sends exactly one approval even if submit is called twice', async () => {
    const c = new FakeClient();
    const b = new ApprovalBridge(c);
    const p = b.open(target, new Subject(['h1']));
    b.decideAll('accept');
    await Promise.all([b.submit(), b.submit()]);
    await p;
    expect(c.calls).toHaveLength(1);
  });

  it('ignores decisions and submit when idle', async () => {
    const c = new FakeClient();
    const b = new ApprovalBridge(c);
    b.decide('h1', 'accept');
    await b.submit();
    expect(c.calls).toHaveLength(0);
  });

  it('abort resolves as aborted without sending anything', async () => {
    const c = new FakeClient();
    const b = new ApprovalBridge(c);
    const p = b.open(target, new Subject(['h1']));
    b.abort();
    expect(await p).toEqual({ kind: 'aborted' });
    expect(c.calls).toHaveLength(0);
    expect(b.state).toBe('idle');
  });

  it('a new open supersedes a stale one', async () => {
    const b = new ApprovalBridge(new FakeClient());
    const first = b.open(target, new Subject(['h1']));
    const second = b.open({ ...target, toolCallId: 'c2' }, new Subject(['h1']));
    expect(await first).toEqual({ kind: 'aborted' });
    b.decideAll('accept');
    await b.submit();
    expect((await second).kind).toBe('allow');
  });

  it('reports a failed approval call as an error outcome', async () => {
    const c = new FakeClient();
    c.fail = true;
    const b = new ApprovalBridge(c);
    const p = b.open(target, new Subject(['h1']));
    b.decideAll('accept');
    await b.submit();
    expect(await p).toEqual({ kind: 'error', message: 'network down' });
  });

  it('requireAll turns a partial acceptance into a deny', async () => {
    const c = new FakeClient();
    const b = new ApprovalBridge(c);
    const p = b.open(target, new Subject(['h1', 'h2']), { requireAll: true });
    b.decide('h1', 'accept');
    await b.submit();
    const o = await p;
    expect(o.kind).toBe('deny');
    expect(c.calls[0]!.decision.status).toBe('deny');
  });

  it('no target: nothing is sent but the outcome is computed (standalone review)', async () => {
    const c = new FakeClient();
    const b = new ApprovalBridge(c);
    const p = b.open(undefined, new Subject(['h1']));
    b.decideAll('accept');
    await b.submit();
    expect((await p).kind).toBe('allow');
    expect(c.calls).toHaveLength(0);
  });

  it('fires hooks: origin on decisions, beforeSend before the approval', async () => {
    const order: string[] = [];
    const c = new FakeClient();
    const orig = c.approve.bind(c);
    c.approve = async (...a) => {
      order.push('approve');
      return orig(...a);
    };
    const b = new ApprovalBridge(c, {
      onDecisionsChanged: (_f, origin) => order.push(`changed:${origin}`),
      beforeSend: () => order.push('beforeSend'),
    });
    const p = b.open(target, new Subject(['h1']));
    b.decide('h1', 'accept', 'editor');
    b.decideAll('accept');
    await b.submit();
    await p;
    expect(order).toEqual(['changed:editor', 'changed:webview', 'beforeSend', 'approve']);
  });
});
