import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../markdown';
import type { Block, ChatItem, RunItem } from '../state';
import { summarizeArgs } from './ui';

function ToolRow({ b }: { b: Extract<Block, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const state = b.pending ? 'running' : b.isError ? 'error' : 'ok';
  return (
    <div className={`tool tool-${state}`}>
      <button className="tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {b.pending ? (
          <span className="spinner" role="status" aria-label="running" />
        ) : (
          <span className="tool-mark" aria-label={b.isError ? 'failed' : 'done'}>
            {b.isError ? '✕' : '✓'}
          </span>
        )}
        <span className="tool-name">{b.name}</span>
        <span className="tool-args ellipsis">{summarizeArgs(b.args)}</span>
      </button>
      {open && (
        <div className="tool-detail">
          <pre>{typeof b.args === 'string' ? b.args : JSON.stringify(b.args, null, 2)}</pre>
          {b.content !== undefined && <pre className={b.isError ? 'err' : ''}>{b.content}</pre>}
        </div>
      )}
    </div>
  );
}

function ToolGroup({ tools }: { tools: Extract<Block, { type: 'tool' }>[] }) {
  const [open, setOpen] = useState(true);
  const pending = tools.filter((t) => t.pending).length;
  const errors = tools.filter((t) => t.isError).length;
  return (
    <div className="timeline">
      <button className="timeline-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chev" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        Tools · {tools.length}
        {pending > 0 && <span className="muted"> · {pending} running</span>}
        {errors > 0 && <span className="err-text"> · {errors} failed</span>}
      </button>
      {open && tools.map((t) => <ToolRow key={t.key} b={t} />)}
    </div>
  );
}

function SubagentBlock({ b, children }: { b: Extract<Block, { type: 'subagent' }>; children: Block[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="subagent">
      <button className="subagent-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chev" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="ellipsis">{b.title}</span>
        {b.phase === 'start' ? (
          <span className="spinner" role="status" aria-label="running" />
        ) : (
          <span className="muted">{b.status ?? 'done'}</span>
        )}
      </button>
      {open && <div className="subagent-body">{renderBlocks(children, () => [])}</div>}
    </div>
  );
}

/** Groups consecutive tool blocks into one timeline; nests subagent children. */
function renderBlocks(blocks: Block[], childrenOf: (key: string) => Block[]) {
  const out: React.ReactNode[] = [];
  let tools: Extract<Block, { type: 'tool' }>[] = [];
  const flush = () => {
    if (tools.length) out.push(<ToolGroup key={`tg-${tools[0]!.key}`} tools={tools} />);
    tools = [];
  };
  for (const b of blocks) {
    if (b.type === 'tool') {
      tools.push(b);
      continue;
    }
    flush();
    switch (b.type) {
      case 'text':
        out.push(<Markdown key={b.key} text={b.text} />);
        break;
      case 'subagent':
        out.push(
          <SubagentBlock key={b.key} b={b}>
            {childrenOf(b.key)}
          </SubagentBlock>,
        );
        break;
      case 'compaction':
        out.push(
          <div key={b.key} className="notice" role="status">
            {b.phase === 'start' ? 'Compacting context…' : 'Context compacted'}
          </div>,
        );
        break;
      case 'approval':
        out.push(
          <div key={b.key} className="notice notice-warn" role="status">
            Waiting for approval: <strong>{b.name}</strong> {summarizeArgs(b.args)}
          </div>,
        );
        break;
      case 'banner':
        out.push(
          <div key={b.key} className={`banner banner-${b.tone}`} role={b.tone === 'warn' ? 'alert' : 'status'}>
            <span>{b.text}</span>
            {b.detail && <span className="muted"> — {b.detail}</span>}
          </div>,
        );
        break;
    }
  }
  flush();
  return out;
}

function Run({ run }: { run: RunItem }) {
  const top = run.blocks.filter((b) => !b.parent);
  const childrenOf = (key: string) => run.blocks.filter((b) => b.parent === key);
  const live = run.status === 'running' || run.status === 'paused';
  const m = run.metrics;
  return (
    <article className="msg msg-assistant" aria-label="Assistant response" aria-busy={run.status === 'running'}>
      <div className="msg-meta muted">
        {run.mode} · {run.model || '…'}
      </div>
      {renderBlocks(top, childrenOf)}
      {live && (
        <div className={`status status-${run.status}`} role="status">
          {run.status === 'paused' ? (
            'Waiting for your review'
          ) : (
            <>
              <span className="spinner" aria-hidden="true" /> Working…
            </>
          )}
        </div>
      )}
      {!live && (
        <footer className={`run-foot run-${run.status}`}>
          <strong>{run.status === 'done' ? 'Done' : run.status === 'cancelled' ? 'Cancelled' : 'Error'}</strong>
          {run.message && <span> — {run.message}</span>}
          {m && (
            <span className="muted">
              {' '}
              ·{' '}
              {[
                m.inputTokens != null && `${m.inputTokens} in`,
                m.outputTokens != null && `${m.outputTokens} out`,
                m.toolCalls != null && `${m.toolCalls} tool calls`,
                m.durationMs != null && `${(m.durationMs / 1000).toFixed(1)}s`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </footer>
      )}
    </article>
  );
}

export function Chat({ items }: { items: ChatItem[] }) {
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
  return (
    <div className="chat" role="log" aria-live="polite" aria-label="Conversation">
      {items.length === 0 && <p className="muted empty">Ask Temper to change your code. Use @ to add files or symbols as context.</p>}
      {items.map((it) =>
        it.kind === 'user' ? (
          <article key={it.id} className="msg msg-user" aria-label="You">
            <div className="user-text">{it.text}</div>
            {it.mentions.length > 0 && (
              <div className="chips">
                {it.mentions.map((m) => (
                  <span key={m.kind + m.value} className="chip chip-mention">
                    {m.kind === 'symbol' ? '#' : '@'}
                    {m.value}
                  </span>
                ))}
              </div>
            )}
          </article>
        ) : (
          <Run key={it.runId} run={it} />
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}
