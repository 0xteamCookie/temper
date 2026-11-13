import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeFileSystem } from '../../src/changeset';
import { DEFAULT_SETTINGS } from '../../src/config/settings';
import { NodeWorkspace } from '../../src/mcp';
import { RunController } from '../../src/host/runController';
import type { ReviewPresentation, RunUi } from '../../src/host/runController';
import { bundledSpec } from '../../src/host/specs';
import type { HostMessage } from '../../src/shared/messages';
import type { ApprovalDecision, FileChange, RunEvent } from '../../src/shared/types';
import type { AgentSpec, RawEvent, StreamOptions, TrueForgeClientLike } from '../../src/trueforge';

let root: string;
const ORIGINAL = 'def a():\n    return 1\n\n\ndef b():\n    return 2\n';

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'temper-run-'));
  writeFileSync(path.join(root, 'app.py'), ORIGINAL);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const disk = () => readFileSync(path.join(root, 'app.py'), 'utf8');

/** Plays a turn: stages an edit, asks to submit, waits for the verdict, then runs the tool like TrueForge would. */
class FakeTrueForge implements TrueForgeClientLike {
  approvals: ApprovalDecision[] = [];
  cancelled: string[] = [];
  toolResult = '';
  stageEdits = true;
  hangAfterApproval = false;
  controller!: RunController;
  private verdict?: (d: ApprovalDecision) => void;
  private cancelHook?: () => void;

  async createSession(_spec: AgentSpec) {
    return { id: 's1' };
  }
  async *streamTurn(_sid: string, _text: string, _opts: StreamOptions = {}): AsyncIterable<RawEvent> {
    const cs = this.controller.active!.changeset;
    if (this.stageEdits) {
      const r = await cs.stage('app.py', '    return 1', '    return 10', 'bump a');
      if (!r.ok) throw new Error(r.message);
      const r2 = await cs.stage('app.py', '    return 2', '    return 20', 'bump b');
      if (!r2.ok) throw new Error(r2.message);
    }
    yield { type: 'turn.created', id: 'e1', turnId: 't1' };
    yield { type: 'model.message', id: 'm1', threadId: 'main', model: { name: 'm/x' } };
    yield { type: 'model.message.delta', id: 'm1', toolCalls: [{ toolInfo: { type: 'mcp', name: 'submit_changeset', serverId: 'temper', serverName: 'temper' }, index: 0, id: 'c1', type: 'function', function: { name: 'submit_changeset', arguments: '' } }] };
    yield { type: 'model.message.delta', id: 'm1', toolCalls: [{ index: 0, function: { arguments: '{"summary":"bump values"}' } }] };
    yield { type: 'model.message.delta', id: 'm1', finishReason: 'tool_calls' };
    const waiting = new Promise<ApprovalDecision | 'cancelled'>((resolve) => {
      this.verdict = resolve;
      this.cancelHook = () => resolve('cancelled');
    });
    yield { type: 'tool.approval_required', id: 'e2', threadId: 'main', toolCalls: [{ id: 'c1', sourceEventId: 'm1' }] };
    yield { type: 'turn.update', id: 'e3', state: { status: 'paused' } };
    const decision = await waiting;
    if (decision === 'cancelled') {
      yield { type: 'turn.done', id: 'e9', state: { status: 'cancelled', reason: 'client-cancelled', metrics: {} } };
      return;
    }
    yield { type: 'turn.update', id: 'e4', state: { status: 'running' } };
    if (decision.status === 'allow') {
      try {
        this.toolResult = await this.controller.active!.applySubmitted('bump values');
      } catch (e) {
        this.toolResult = `ERROR ${(e as Error).message}`;
      }
    } else this.toolResult = `denied: ${decision.reason}`;
    yield { type: 'tool.response', id: 'e5', toolCallId: 'c1', threadId: 'main', content: this.toolResult };
    yield { type: 'turn.done', id: 'e6', state: { status: 'done', metrics: {} } };
  }
  async *subscribe(): AsyncIterable<RawEvent> {}
  async approve(_s: string, _t: string, _th: string, _id: string, decision: ApprovalDecision) {
    this.approvals.push(decision);
    this.verdict?.(decision);
  }
  async cancel(sid: string) {
    this.cancelled.push(sid);
    this.cancelHook?.();
  }
}

class FakeUi implements RunUi {
  posts: HostMessage[] = [];
  events: RunEvent[] = [];
  notes: string[] = [];
  opened: ReviewPresentation[] = [];
  closed = 0;
  partialAsked = 0;
  wantPartial = false;
  confirmUndo = true;
  /** Called when the editor review opens, like a user acting on it. */
  onOpen: (p: ReviewPresentation) => void = () => {};
  event(ev: RunEvent) {
    this.events.push(ev);
  }
  post(m: HostMessage) {
    this.posts.push(m);
  }
  notify(_k: 'info' | 'warn' | 'error', t: string) {
    this.notes.push(t);
  }
  openReview(p: ReviewPresentation) {
    this.opened.push(p);
    setTimeout(() => this.onOpen(p), 0);
  }
  updateReview() {}
  closeReview() {
    this.closed++;
  }
  async askPartialReview() {
    this.partialAsked++;
    return this.wantPartial;
  }
  async confirm() {
    return this.confirmUndo;
  }
  of<T extends HostMessage['type']>(t: T) {
    return this.posts.filter((m): m is Extract<HostMessage, { type: T }> => m.type === t);
  }
}

function setup() {
  const client = new FakeTrueForge();
  const ui = new FakeUi();
  const controller = new RunController({
    client,
    ui,
    getSettings: () => DEFAULT_SETTINGS,
    getModels: () => ({ chain: ['m/x'], agentModel: 'm/x', inlineModel: 'm/x' }),
    workspaceRoot: root,
    workspace: new NodeWorkspace(root),
    fsPort: new NodeFileSystem(root),
    loadSpec: async () => bundledSpec('agent'),
  });
  client.controller = controller;
  return { client, ui, controller };
}

describe('RunController approval flow', () => {
  it('accepted hunks are applied through the submit_changeset handler, with a checkpoint', async () => {
    const { client, ui, controller } = setup();
    ui.onOpen = (p) => {
      const first = p.files[0]!.hunks;
      expect(first.length).toBeGreaterThan(0);
      p.handlers.onDecideAll('accept');
      p.handlers.onSubmit();
    };
    const result = await controller.start({ mode: 'agent', prompt: 'bump' });
    expect(result?.status).toBe('done');
    expect(client.approvals).toEqual([{ status: 'allow' }]);
    expect(client.toolResult).toMatch(/^Applied \d+ hunks? in app\.py; rejected 0/);
    expect(disk()).toBe(ORIGINAL.replace('return 1', 'return 10').replace('return 2', 'return 20'));
    expect(ui.of('review.open')).toHaveLength(2); // initial + editor-origin decision sync
    expect(ui.of('review.closed').at(-1)).toMatchObject({ applied: expect.any(Number), rejected: 0 });
    expect(ui.of('checkpoints.update').at(-1)).toMatchObject({ canUndo: true });
    expect(controller.isRunning).toBe(false);
  });

  it('applies only the accepted hunks and reports the rest as rejected', async () => {
    const { client, ui, controller } = setup();
    ui.onOpen = (p) => {
      const hunks = p.files[0]!.hunks;
      expect(hunks.length).toBe(1); // both edits are within 3 lines of context here
      p.handlers.onDecideAll('accept');
      p.handlers.onSubmit();
    };
    // widen the file so the two edits become two hunks
    writeFileSync(path.join(root, 'app.py'), ORIGINAL.replace('def b', Array.from({ length: 12 }, (_, i) => `# pad ${i}`).join('\n') + '\n\n\ndef b'));
    ui.onOpen = (p) => {
      const hunks = p.files[0]!.hunks;
      expect(hunks).toHaveLength(2);
      p.handlers.onDecide(hunks[0]!.id, 'accept');
      p.handlers.onDecide(hunks[1]!.id, 'reject');
      p.handlers.onSubmit('second one is wrong');
    };
    await controller.start({ mode: 'agent', prompt: 'bump' });
    expect(client.toolResult).toBe('Applied 1 hunk in app.py; rejected 1 (second one is wrong).');
    expect(disk()).toContain('return 10');
    expect(disk()).toContain('return 2\n');
    expect(disk()).not.toContain('return 20');
  });

  it('rejecting everything sends deny with the default reason and writes nothing', async () => {
    const { client, ui, controller } = setup();
    ui.onOpen = (p) => {
      p.handlers.onDecideAll('reject');
      p.handlers.onSubmit();
    };
    await controller.start({ mode: 'agent', prompt: 'bump' });
    expect(client.approvals).toEqual([{ status: 'deny', reason: 'User rejected all proposed hunks; ask what to change.' }]);
    expect(disk()).toBe(ORIGINAL);
    expect(ui.of('review.closed').at(-1)).toMatchObject({ applied: 0 });
    expect(controller.canUndo().canUndo).toBe(false);
  });

  it('webview decisions reach the bridge', async () => {
    const { client, ui, controller } = setup();
    ui.onOpen = () => {
      controller.decideAll('accept');
      controller.submitReview();
    };
    await controller.start({ mode: 'agent', prompt: 'bump' });
    expect(client.approvals[0]).toEqual({ status: 'allow' });
    expect(disk()).toContain('return 10');
  });

  it('an empty changeset is denied without opening a review', async () => {
    const { client, ui, controller } = setup();
    client.stageEdits = false;
    await controller.start({ mode: 'agent', prompt: 'nothing' });
    expect(client.approvals[0]).toMatchObject({ status: 'deny', reason: expect.stringContaining('Nothing is staged') });
    expect(ui.opened).toHaveLength(0);
  });

  it('cancel during review aborts the turn, leaves the workspace untouched and offers partial review (default discard)', async () => {
    const { client, ui, controller } = setup();
    ui.onOpen = () => controller.cancel();
    const result = await controller.start({ mode: 'agent', prompt: 'bump' });
    expect(result?.status).toBe('cancelled');
    expect(client.cancelled).toEqual(['s1']);
    expect(client.approvals).toHaveLength(0);
    expect(disk()).toBe(ORIGINAL);
    await new Promise((r) => setTimeout(r, 10));
    expect(ui.partialAsked).toBe(1);
    expect(controller.active).toBeUndefined();
  });

  it('partial review after cancel applies the accepted hunks without TrueForge', async () => {
    const { ui, controller } = setup();
    ui.wantPartial = true;
    let phase = 0;
    ui.onOpen = (p) => {
      if (phase++ === 0) return controller.cancel();
      p.handlers.onDecideAll('accept');
      p.handlers.onSubmit();
    };
    await controller.start({ mode: 'agent', prompt: 'bump' });
    await new Promise((r) => setTimeout(r, 50));
    expect(disk()).toContain('return 10');
    expect(controller.canUndo().canUndo).toBe(true);
  });

  it('undo restores the original contents', async () => {
    const { ui, controller } = setup();
    ui.onOpen = (p) => {
      p.handlers.onDecideAll('accept');
      p.handlers.onSubmit();
    };
    await controller.start({ mode: 'agent', prompt: 'bump' });
    expect(disk()).not.toBe(ORIGINAL);
    await controller.undoLast();
    expect(disk()).toBe(ORIGINAL);
    expect(controller.canUndo().canUndo).toBe(false);
  });

  it('undo asks before discarding edits made after the agent change', async () => {
    const { ui, controller } = setup();
    ui.onOpen = (p) => {
      p.handlers.onDecideAll('accept');
      p.handlers.onSubmit();
    };
    await controller.start({ mode: 'agent', prompt: 'bump' });
    writeFileSync(path.join(root, 'app.py'), disk() + '# my own edit\n');
    ui.confirmUndo = false;
    await controller.undoLast();
    expect(disk()).toContain('# my own edit');
    ui.confirmUndo = true;
    await controller.undoLast();
    expect(disk()).toBe(ORIGINAL);
  });

  it('refuses a second concurrent run', async () => {
    const { ui, controller } = setup();
    ui.onOpen = (p) => {
      void controller.start({ mode: 'agent', prompt: 'again' }).then((r) => expect(r).toBeUndefined());
      p.handlers.onDecideAll('reject');
      p.handlers.onSubmit();
    };
    await controller.start({ mode: 'agent', prompt: 'bump' });
    expect(ui.notes.some((n) => /already in progress/.test(n))).toBe(true);
  });

  it('the submit_changeset handler refuses to apply without a recorded user verdict', async () => {
    const { client, controller, ui } = setup();
    // user rejects; the (mis-behaving) harness still calls the tool afterwards
    ui.onOpen = (p) => {
      p.handlers.onDecideAll('reject');
      p.handlers.onSubmit();
    };
    await controller.start({ mode: 'agent', prompt: 'bump' });
    expect(client.toolResult).toMatch(/^denied/);
    expect(disk()).toBe(ORIGINAL);
  });

  it('forwards every run event to the UI, including done', async () => {
    const { ui, controller } = setup();
    ui.onOpen = (p) => {
      p.handlers.onDecideAll('accept');
      p.handlers.onSubmit();
    };
    await controller.start({ mode: 'agent', prompt: 'bump' });
    const kinds = ui.events.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['runStart', 'toolCall', 'approval', 'toolResult', 'done']));
    expect((ui.events as FileChange[] | RunEvent[]).at(-1)).toMatchObject({ kind: 'done', status: 'done' });
  });
});

