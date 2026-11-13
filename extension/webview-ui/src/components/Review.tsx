import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileChange, Hunk, HunkDecision } from '../../../src/shared/types';
import { postToHost } from '../vscode';
import { Icon, IconButton, splitPath } from './ui';

interface DiffRow {
  kind: 'add' | 'del' | 'ctx';
  oldN?: number;
  newN?: number;
  text: string;
}

function toRows(h: Hunk): DiffRow[] {
  let o = h.oldStart;
  let n = h.newStart;
  return h.lines.map((l) => {
    if (l.startsWith('+')) return { kind: 'add', newN: n++, text: l };
    if (l.startsWith('-')) return { kind: 'del', oldN: o++, text: l };
    return { kind: 'ctx', oldN: o++, newN: n++, text: l || ' ' };
  });
}

function Diff({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="diff" role="group" aria-label="Diff preview" tabIndex={0}>
      <div className="diff-in">
        {rows.map((r, i) => (
          <div key={i} className={`dl dl-${r.kind}`}>
            <span className="ln" aria-hidden="true">
              {r.oldN ?? ''}
            </span>
            <span className="ln" aria-hidden="true">
              {r.newN ?? ''}
            </span>
            <span className="tx">{r.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Flags({ h }: { h: Hunk }) {
  return (
    <>
      {h.flags.map((f, i) =>
        f.kind === 'unknownSymbol' ? (
          <div key={i} className="callout callout-bad" role="note">
            <Icon name="error" />
            <span className="grow">
              {f.symbols.map((s, j) => {
                const sug = f.suggestions[s]?.[0];
                return (
                  <span key={s}>
                    {j > 0 && ' '}
                    Unknown symbol <code>{s}</code>.{sug ? <> Did you mean <code>{sug}</code>?</> : null}
                  </span>
                );
              })}
            </span>
          </div>
        ) : (
          <div key={i} className="callout callout-warn" role="note">
            <Icon name="warning" />
            <span className="grow">
              {f.kind === 'outsideSelection' ? 'Outside the selected lines' : 'Outside the approved plan'}
              {f.detail ? `: ${f.detail}` : ''}
            </span>
          </div>
        ),
      )}
    </>
  );
}

const PREVIEW_LINES = 3;

function HunkView({
  h,
  current,
  onDecide,
  onFocusMe,
}: {
  h: Hunk;
  current: boolean;
  onDecide: (d: HunkDecision) => void;
  onFocusMe: () => void;
}) {
  const [full, setFull] = useState(false);
  const rows = useMemo(() => toRows(h), [h]);
  const decided = h.decision !== 'pending';
  const collapsed = decided && !full && rows.length > PREVIEW_LINES;
  const shown = collapsed ? rows.slice(0, PREVIEW_LINES) : rows;
  const ctx = /^@@[^@]*@@\s*(.*)$/.exec(h.header)?.[1];
  const range =
    h.newLines <= 1 ? `Line ${h.newStart}` : `Lines ${h.newStart}–${h.newStart + h.newLines - 1}`;
  return (
    <div
      className={`hunk hunk-${h.decision}${current ? ' cur' : ''}`}
      data-hunk-id={h.id}
      tabIndex={-1}
      onFocus={onFocusMe}
      aria-label={`${range}, ${h.decision === 'pending' ? 'undecided' : h.decision === 'accept' ? 'accepted' : 'rejected'}`}
    >
      <div className="hunk-head">
        <span className="hunk-range" title={h.header}>
          {range}
        </span>
        {ctx && <code className="ellipsis muted hunk-ctx">{ctx}</code>}
      </div>
      {h.rationale && (
        <div className="rationale">
          <Icon name="comment" className="muted" />
          <span>{h.rationale}</span>
        </div>
      )}
      <Flags h={h} />
      <Diff rows={shown} />
      {collapsed && (
        <button type="button" className="link-btn" onClick={() => setFull(true)}>
          Show diff ({rows.length} lines)
        </button>
      )}
      {decided && full && rows.length > PREVIEW_LINES && (
        <button type="button" className="link-btn" onClick={() => setFull(false)}>
          Hide diff
        </button>
      )}
      <div className="seg seg-decide" role="group" aria-label={`Decision for ${range}`}>
        <button
          type="button"
          className="seg-btn"
          aria-pressed={h.decision === 'accept'}
          data-kind="accept"
          onClick={() => onDecide(h.decision === 'accept' ? 'pending' : 'accept')}
        >
          <Icon name="check" />
          Accept
        </button>
        <button
          type="button"
          className="seg-btn"
          aria-pressed={h.decision === 'reject'}
          data-kind="reject"
          onClick={() => onDecide(h.decision === 'reject' ? 'pending' : 'reject')}
        >
          <Icon name="close" />
          Reject
        </button>
      </div>
    </div>
  );
}

function counts(c: FileChange) {
  let add = 0;
  let del = 0;
  for (const h of c.hunks)
    for (const l of h.lines) {
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
  return { add, del };
}

function File({
  c,
  open,
  onToggle,
  cur,
  onCur,
  onDecide,
}: {
  c: FileChange;
  open: boolean;
  onToggle: () => void;
  cur: string | undefined;
  onCur: (id: string) => void;
  onDecide: (ids: string[], d: HunkDecision) => void;
}) {
  const { add, del } = counts(c);
  const ids = c.hunks.map((h) => h.id);
  const { dir, base } = splitPath(c.path);
  return (
    <section className="file" aria-label={c.path}>
      <div className="file-head">
        <button type="button" className="file-toggle" aria-expanded={open} onClick={onToggle}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <Icon name="file" className="muted" />
          <span className="ellipsis" title={c.path}>
            <span className="muted">{dir}</span>
            <strong>{base}</strong>
          </span>
        </button>
        {c.kind === 'create' && <span className="chip chip-new">new</span>}
        <span className="nowrap small">
          <span className="add-text">+{add}</span> <span className="del-text">−{del}</span>
        </span>
        <span className="row-actions">
          <IconButton icon="diff" label={`Open diff for ${c.path}`} title="Open diff" onClick={() => postToHost({ type: 'review.openDiff', path: c.path })} />
          <IconButton icon="check-all" label={`Accept all hunks in ${c.path}`} title="Accept all in file" onClick={() => onDecide(ids, 'accept')} />
          <IconButton icon="close-all" label={`Reject all hunks in ${c.path}`} title="Reject all in file" onClick={() => onDecide(ids, 'reject')} />
        </span>
      </div>
      {open && (
        <div className="file-body">
          {c.hunks.map((h) => (
            <HunkView key={h.id} h={h} current={cur === h.id} onFocusMe={() => onCur(h.id)} onDecide={(d) => onDecide([h.id], d)} />
          ))}
        </div>
      )}
    </section>
  );
}

export function Review({
  changes,
  active,
  onDecide,
  onDecideAll,
}: {
  changes: FileChange[];
  active: boolean;
  onDecide: (ids: string[], d: HunkDecision) => void;
  onDecideAll: (d: HunkDecision) => void;
}) {
  const [reason, setReason] = useState('');
  const [cur, setCur] = useState<string | undefined>(undefined);
  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({});
  const root = useRef<HTMLDivElement>(null);

  const all = changes.flatMap((c) => c.hunks);
  const accepted = all.filter((h) => h.decision === 'accept').length;
  const rejected = all.filter((h) => h.decision === 'reject').length;
  const pending = all.length - accepted - rejected;
  const isOpen = (c: FileChange, i: number) => openFiles[c.path] ?? (changes.length <= 3 || i === 0);

  // Bring the view into keyboard focus when it becomes the visible one.
  useEffect(() => {
    if (active) root.current?.focus({ preventScroll: true });
  }, [active]);

  const decide = (ids: string[], d: HunkDecision) => {
    onDecide(ids, d);
    for (const id of ids) postToHost({ type: 'review.decide', hunkId: id, decision: d });
  };

  const submit = () => postToHost({ type: 'review.submit', reason: reason.trim() || undefined });

  const go = (delta: 1 | -1, fromId = cur) => {
    if (all.length === 0) return;
    const idx = fromId ? all.findIndex((h) => h.id === fromId) : -1;
    const next = all[Math.min(all.length - 1, Math.max(0, idx < 0 ? (delta === 1 ? 0 : all.length - 1) : idx + delta))]!;
    const file = changes.find((c) => c.hunks.some((h) => h.id === next.id))!;
    setOpenFiles((o) => ({ ...o, [file.path]: true }));
    setCur(next.id);
    requestAnimationFrame(() => {
      const el = root.current?.querySelector<HTMLElement>(`[data-hunk-id="${CSS.escape(next.id)}"]`);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: 'nearest' });
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select')) return;
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'Enter' && pending === 0) {
        e.preventDefault();
        submit();
      }
      return;
    }
    if (e.altKey) return;
    if (e.key === 'j') {
      e.preventDefault();
      go(1);
    } else if (e.key === 'k') {
      e.preventDefault();
      go(-1);
    } else if ((e.key === 'a' || e.key === 'r') && cur) {
      e.preventDefault();
      const d: HunkDecision = e.key === 'a' ? 'accept' : 'reject';
      const h = all.find((x) => x.id === cur);
      decide([cur], h?.decision === d ? 'pending' : d);
    }
  };

  const pct = (n: number) => (all.length ? `${(n / all.length) * 100}%` : '0%');

  return (
    <div className="review" ref={root} tabIndex={-1} onKeyDown={onKeyDown} aria-label="Review changes">
      <div className="review-top">
        <div className="review-title">
          <h2>Review changes</h2>
          <span className="muted small nowrap">
            {changes.length} file{changes.length === 1 ? '' : 's'} · {all.length} hunk{all.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="progress" aria-hidden="true">
          <span className="seg-ok" style={{ width: pct(accepted) }} />
          <span className="seg-bad" style={{ width: pct(rejected) }} />
        </div>
        <div className="progress-text small" role="status">
          <span className="ok-text">
            <Icon name="check" /> {accepted} accepted
          </span>
          <span className="bad-text">
            <Icon name="close" /> {rejected} rejected
          </span>
          <span className="muted">
            <Icon name="circle-large-outline" /> {pending} undecided
          </span>
        </div>
        <div className="review-actions">
          <button
            type="button"
            className="btn btn-primary"
            title="Accept every hunk and apply them now"
            onClick={() => {
              onDecideAll('accept');
              postToHost({ type: 'review.decideAll', decision: 'accept' });
              postToHost({ type: 'review.submit' });
            }}
          >
            Accept all &amp; apply
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onDecideAll('reject');
              postToHost({ type: 'review.decideAll', decision: 'reject' });
            }}
          >
            Reject all
          </button>
        </div>
      </div>
      <div className="review-files">
        {changes.map((c, i) => (
          <File
            key={c.path}
            c={c}
            open={isOpen(c, i)}
            onToggle={() => setOpenFiles((o) => ({ ...o, [c.path]: !isOpen(c, i) }))}
            cur={cur}
            onCur={setCur}
            onDecide={decide}
          />
        ))}
      </div>
      <div className="review-foot">
        {rejected > 0 && (
          <input
            type="text"
            value={reason}
            placeholder="Tell the agent why you rejected some hunks (optional)"
            aria-label="Feedback for the agent"
            onChange={(e) => setReason(e.target.value)}
          />
        )}
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={pending > 0}
          title={pending > 0 ? 'Accept or reject every hunk first' : undefined}
          onClick={submit}
        >
          {pending > 0
            ? `Decide ${pending} more hunk${pending === 1 ? '' : 's'}`
            : accepted === 0
              ? 'Reject all and send feedback'
              : `Apply ${accepted} of ${all.length} hunk${all.length === 1 ? '' : 's'}`}
        </button>
        <div className="kbd-hint muted small">
          <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> accept · <kbd>r</kbd> reject · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> apply
        </div>
      </div>
    </div>
  );
}
