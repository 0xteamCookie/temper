import { useEffect, useRef, useState } from 'react';
import type { LedgerSnapshot } from '../../../src/shared/types';
import { Markdown } from '../markdown';
import type { Block, ChatItem, RunItem } from '../state';
import { postToHost } from '../vscode';
import { ContextCard } from './ContextCard';
import { categorize, fileTarget, plainTarget, summarizeTools } from './tools';
import { FileLink, fmtRange, fmtTokens, Icon, shortModel, Spinner, splitPath, summarizeArgs } from './ui';

type ToolBlock = Extract<Block, { type: 'tool' }>;

const PRESENT: Record<string, string> = {
  read: 'Reading',
  search: 'Searching',
  context: 'Gathering context',
  edit: 'Editing',
  run: 'Running',
  submit: 'Submitting for review',
  tools: 'Loading tools',
};

function useElapsed(startedAt: number, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);
  return Math.max(0, Math.round((now - startedAt) / 1000));
}

function StepRow({ b, live }: { b: ToolBlock; live: boolean }) {
  const [open, setOpen] = useState(false);
  const info = categorize(b.name);
  const file = fileTarget(info.cat, b.args);
  const label = info.cat === 'other' ? b.name : info.label;
  const plain = file ? '' : plainTarget(info.cat, b.args);
  const status = b.pending ? (live ? 'running' : 'stopped') : b.isError ? 'error' : 'ok';
  const statusText = status === 'running' ? 'running' : status === 'stopped' ? 'did not finish' : status === 'error' ? 'failed' : 'done';
  return (
    <div className={`step step-${status}`}>
      <div className="step-row">
        <button type="button" className="step-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title="Show details">
          <Icon name={info.icon} className="muted" />
          <span className="step-label">{label}</span>
          {!file && plain && <span className="mono ellipsis step-target">{plain}</span>}
        </button>
        {file && (
          <FileLink
            path={file.path}
            line={file.line}
            className="ellipsis grow"
            label={`${splitPath(file.path).base}${file.line ? `:${file.line}` : ''}`}
          />
        )}
        {!file && !plain && <span className="grow" />}
        <span className={`step-status step-status-${status}`} role="img" aria-label={statusText} title={statusText}>
          {status === 'running' ? <Spinner /> : <Icon name={status === 'error' ? 'error' : status === 'stopped' ? 'circle-slash' : 'check'} />}
        </span>
      </div>
      {open && (
        <div className="step-detail">
          <pre>{typeof b.args === 'string' ? b.args : JSON.stringify(b.args, null, 2)}</pre>
          {b.content !== undefined && <pre className={b.isError ? 'err' : ''}>{b.content}</pre>}
        </div>
      )}
    </div>
  );
}

function StepsGroup({ tools, growing, live }: { tools: ToolBlock[]; growing: boolean; live: boolean }) {
  const [manual, setManual] = useState<boolean | undefined>(undefined);
  const finished = !growing;
  const open = manual ?? !finished;
  const { text, failed } = summarizeTools(tools);
  const current = [...tools].reverse().find((t) => t.pending) ?? tools[tools.length - 1]!;
  const info = categorize(current.name);
  const file = fileTarget(info.cat, current.args);
  const target = file ? splitPath(file.path).base : plainTarget(info.cat, current.args);
  return (
    <div className="steps">
      <button type="button" className="steps-head" aria-expanded={open} onClick={() => setManual(!open)}>
        {finished ? (
          <span className={failed ? 'err-text' : 'ok-text'}>
            <Icon name={failed ? 'error' : 'check'} />
          </span>
        ) : (
          <span className="accent-text">
            <Spinner />
          </span>
        )}
        {finished ? (
          <span className={`ellipsis steps-summary${failed ? ' err-text' : ''}`}>
            {text}
            {failed > 0 ? ` · ${failed} failed` : ''}
          </span>
        ) : (
          <span className="ellipsis steps-summary">
            {PRESENT[info.cat] ?? 'Running'} <span className="mono">{target}</span>
          </span>
        )}
        <span className="muted nowrap small">{tools.length}</span>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
      </button>
      {open && (
        <div className="steps-body">
          {tools.map((t) => (
            <StepRow key={t.key} b={t} live={live} />
          ))}
        </div>
      )}
    </div>
  );
}

function SubagentBlock({
  b,
  children,
  live,
}: {
  b: Extract<Block, { type: 'subagent' }>;
  children: Block[];
  live: boolean;
}) {
  const [manual, setManual] = useState<boolean | undefined>(undefined);
  const running = b.phase === 'start' && live;
  const open = manual ?? running;
  const tools = children.filter((c): c is ToolBlock => c.type === 'tool');
  const { text, failed } = summarizeTools(tools);
  return (
    <div className="steps subagent">
      <button type="button" className="steps-head" aria-expanded={open} onClick={() => setManual(!open)}>
        <span className={running ? 'accent-text' : failed ? 'err-text' : 'ok-text'}>
          <Icon name="organization" />
        </span>
        <span className="ellipsis steps-summary">
          {b.title}
          {!running && tools.length > 0 && <span className="muted"> · {text}</span>}
        </span>
        {running ? <Spinner /> : <span className="muted nowrap small">{b.status ?? 'done'}</span>}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
      </button>
      {open && <div className="steps-body">{renderBlocks(children, () => [], running, live, undefined)}</div>}
    </div>
  );
}

interface ReviewCtx {
  hasReview: boolean;
  onOpenReview: () => void;
}

/** Groups consecutive tool blocks into Steps; nests subagent children. */
function renderBlocks(
  blocks: Block[],
  childrenOf: (key: string) => Block[],
  growingTail: boolean,
  live: boolean,
  review: ReviewCtx | undefined,
) {
  const out: React.ReactNode[] = [];
  let tools: ToolBlock[] = [];
  const flush = (atEnd: boolean) => {
    if (tools.length) out.push(<StepsGroup key={`tg-${tools[0]!.key}`} tools={tools} growing={atEnd && growingTail} live={live} />);
    tools = [];
  };
  for (const b of blocks) {
    if (b.type === 'tool') {
      tools.push(b);
      continue;
    }
    flush(false);
    switch (b.type) {
      case 'text':
        out.push(<Markdown key={b.key} text={b.text} />);
        break;
      case 'subagent':
        out.push(
          <SubagentBlock key={b.key} b={b} live={live}>
            {childrenOf(b.key)}
          </SubagentBlock>,
        );
        break;
      case 'compaction':
        out.push(
          <div key={b.key} className="notice" role="status">
            <Icon name={b.phase === 'start' ? 'fold' : 'check'} />
            {b.phase === 'start' ? 'Compacting context…' : 'Context compacted'}
          </div>,
        );
        break;
      case 'approval':
        out.push(
          <div key={b.key} className="callout callout-accent" role="status">
            <Icon name="shield" />
            <span className="grow">
              Waiting for approval: <strong>{b.name}</strong> <span className="mono">{summarizeArgs(b.args, 50)}</span>
            </span>
            {review?.hasReview && (
              <button type="button" className="btn btn-sm" onClick={review.onOpenReview}>
                Review
              </button>
            )}
          </div>,
        );
        break;
      case 'banner':
        out.push(
          b.kind === 'fallback' ? (
            <div key={b.key} className="callout callout-warn" role="alert">
              <Icon name="arrow-swap" />
              <span className="grow">
                <strong className="mono">{b.from}</strong> failed ({b.reason}) → switched to <strong className="mono">{b.to}</strong>
              </span>
            </div>
          ) : (
            <div key={b.key} className="callout" role="status">
              <Icon name="refresh" />
              <span className="grow">
                Retrying <span className="mono">{b.from}</span> (attempt {b.attempt}) in {Math.round((b.delayMs ?? 0) / 100) / 10}s
                <span className="muted"> · {b.reason}</span>
              </span>
            </div>
          ),
        );
        break;
    }
  }
  flush(true);
  return out;
}

function Run({
  run,
  ledger,
  isLatest,
  onBudget,
  review,
  canUndo,
}: {
  run: RunItem;
  ledger?: LedgerSnapshot;
  isLatest: boolean;
  onBudget: (t: number) => void;
  review: ReviewCtx;
  canUndo: boolean;
}) {
  const top = run.blocks.filter((b) => !b.parent);
  const childrenOf = (key: string) => run.blocks.filter((b) => b.parent === key);
  const live = run.status === 'running' || run.status === 'paused';
  const elapsed = useElapsed(run.startedAt, run.status === 'running');
  const m = run.metrics;
  const isEdit = run.mode === 'inline';
  const status = run.status;
  const metrics = m
    ? [
        m.inputTokens != null && `${fmtTokens(m.inputTokens)} in`,
        m.outputTokens != null && `${fmtTokens(m.outputTokens)} out`,
        m.toolCalls != null && `${m.toolCalls} tool calls`,
        m.durationMs != null && `${Math.round(m.durationMs / 1000)}s`,
      ].filter(Boolean)
    : [];
  return (
    <article className="run" aria-label="Temper response" aria-busy={run.status === 'running'}>
      <div className="run-meta muted">
        <Icon name={isEdit ? 'edit' : 'robot'} />
        <span>{isEdit ? 'Edit' : 'Agent'}</span>
        <span aria-hidden="true">·</span>
        <span className="ellipsis" title={run.model}>
          {run.model ? shortModel(run.model) : '…'}
        </span>
        {run.status === 'running' && (
          <>
            <span aria-hidden="true">·</span>
            <span className="nowrap" aria-label={`${elapsed} seconds elapsed`}>
              {elapsed}s
            </span>
          </>
        )}
      </div>
      {isLatest && ledger && ledger.runId === run.runId && <ContextCard snapshot={ledger} live={live} onBudget={onBudget} />}
      {renderBlocks(top, childrenOf, live, live, review)}
      {status === 'paused' && (
        <div className="callout callout-accent" role="status">
          <Icon name="eye" />
          <span className="grow">Waiting for your review</span>
          {review.hasReview && (
            <button type="button" className="btn btn-sm btn-primary" onClick={review.onOpenReview}>
              Review
            </button>
          )}
        </div>
      )}
      {status === 'running' && (
        <div className="run-live accent-text" role="status">
          <Spinner /> Working…
        </div>
      )}
      {!live && (
        <footer className={`run-foot run-${status}`}>
          <div className="run-status">
            <Icon name={status === 'done' ? 'check' : status === 'cancelled' ? 'circle-slash' : 'error'} />
            <strong>{status === 'done' ? 'Done' : status === 'cancelled' ? 'Cancelled' : 'Error'}</strong>
            {run.message && <span className="muted"> — {run.message}</span>}
          </div>
          {metrics.length > 0 && <div className="muted small">{metrics.join(' · ')}</div>}
        </footer>
      )}
      {run.applied && (
        <div className="applied" role="status">
          <Icon name={run.applied.applied > 0 ? 'check' : 'close'} />
          <span className="grow">
            {run.applied.applied > 0
              ? `Applied ${run.applied.applied} hunk${run.applied.applied === 1 ? '' : 's'}${
                  run.applied.files ? ` in ${run.applied.files} file${run.applied.files === 1 ? '' : 's'}` : ''
                }`
              : 'No changes applied'}
            {run.applied.rejected > 0 && <span className="muted"> · {run.applied.rejected} rejected</span>}
          </span>
          {run.applied.applied > 0 && canUndo && isLatest && (
            <button type="button" className="link-btn" onClick={() => postToHost({ type: 'undo.last' })}>
              Undo
            </button>
          )}
        </div>
      )}
    </article>
  );
}

const EXAMPLES = [
  'Add a `flask config` command that prints the app config with secrets masked',
  'Explain how FlaskGroup registers commands',
];

function EmptyState({ onExample }: { onExample: (text: string) => void }) {
  return (
    <div className="empty">
      <h2>Ask Temper to change your code</h2>
      <ul className="tips">
        <li>
          <Icon name="mention" />
          <span>Type @ to add files or symbols</span>
        </li>
        <li>
          <Icon name="selection" />
          <span>Select code to edit it in place (Ctrl+Alt+K) or attach it here</span>
        </li>
        <li>
          <Icon name="shield" />
          <span>Nothing touches disk until you accept each hunk</span>
        </li>
      </ul>
      <div className="muted small">Try one of these</div>
      <ul className="examples">
        {EXAMPLES.map((t) => (
          <li key={t}>
            <button type="button" className="example" onClick={() => onExample(t.replace(/`/g, ''))}>
              <Icon name="sparkle" />
              <span>{t.replace(/`/g, '')}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Chat({
  items,
  ledger,
  onBudget,
  onExample,
  hasReview,
  onOpenReview,
  canUndo,
}: {
  items: ChatItem[];
  ledger?: LedgerSnapshot;
  onBudget: (t: number) => void;
  onExample: (text: string) => void;
  hasReview: boolean;
  onOpenReview: () => void;
  canUndo: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = endRef.current?.closest('.scroll');
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: 'end' });
  });
  const lastRun = [...items].reverse().find((i): i is RunItem => i.kind === 'run');
  const review: ReviewCtx = { hasReview, onOpenReview };
  return (
    <div className="chat" role="log" aria-live="polite" aria-label="Conversation">
      {items.length === 0 && <EmptyState onExample={onExample} />}
      {items.map((it) =>
        it.kind === 'user' ? (
          <article key={it.id} className="user-msg" aria-label="You">
            <div className="user-text">{it.text}</div>
            {(it.mentions.length > 0 || it.selection) && (
              <div className="chips">
                {it.mode === 'edit' && (
                  <span className="chip">
                    <Icon name="edit" />
                    Edit
                  </span>
                )}
                {it.selection && (
                  <span className="chip" title={`${it.selection.path}:${it.selection.startLine}-${it.selection.endLine}`}>
                    <Icon name="selection" />
                    <span className="ellipsis">
                      {splitPath(it.selection.path).base} {fmtRange(it.selection.startLine, it.selection.endLine)}
                    </span>
                  </span>
                )}
                {it.mentions.map((m) => (
                  <span key={m.kind + m.value} className="chip" title={m.value}>
                    <Icon name={m.kind === 'symbol' ? 'symbol-method' : 'file'} />
                    <span className="ellipsis">{m.kind === 'file' ? splitPath(m.value).base : m.value}</span>
                  </span>
                ))}
              </div>
            )}
          </article>
        ) : (
          <Run
            key={it.runId}
            run={it}
            ledger={ledger}
            isLatest={it === lastRun}
            onBudget={onBudget}
            review={review}
            canUndo={canUndo}
          />
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}
