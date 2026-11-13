import { useState } from 'react';
import type { FileChange, Hunk, HunkDecision } from '../../../src/shared/types';
import { postToHost } from '../vscode';

function DiffPreview({ lines }: { lines: string[] }) {
  return (
    <pre className="diff" aria-label="Diff preview">
      {lines.map((l, i) => (
        <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx'}>
          {l || ' '}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

function Flags({ h }: { h: Hunk }) {
  return (
    <span className="chips">
      {h.flags.map((f, i) =>
        f.kind === 'unknownSymbol' ? (
          <span key={i} className="badge-flag flag-red" role="note">
            {f.symbols
              .map((s) => {
                const sug = f.suggestions[s]?.[0];
                return `Unknown symbol: ${s}${sug ? ` (did you mean ${sug}?)` : ''}`;
              })
              .join('; ')}
          </span>
        ) : (
          <span key={i} className="badge-flag flag-amber" title={f.detail} role="note">
            Outside scope
            <span className="sr-only">: {f.kind === 'outsideSelection' ? 'outside selection' : 'outside plan'}</span>
          </span>
        ),
      )}
    </span>
  );
}

function HunkView({ h, onDecide }: { h: Hunk; onDecide: (d: HunkDecision) => void }) {
  return (
    <div className={`hunk hunk-${h.decision}`}>
      <div className="hunk-head">
        <code className="hunk-header ellipsis" title={h.header}>
          {h.header}
        </code>
      </div>
      {h.rationale && <div className="rationale">{h.rationale}</div>}
      {h.flags.length > 0 && <Flags h={h} />}
      <DiffPreview lines={h.lines} />
      <div className="seg" role="group" aria-label={`Decision for ${h.header}`}>
        <button className="btn btn-sm" aria-pressed={h.decision === 'accept'} data-kind="accept" onClick={() => onDecide(h.decision === 'accept' ? 'pending' : 'accept')}>
          Accept
        </button>
        <button className="btn btn-sm" aria-pressed={h.decision === 'reject'} data-kind="reject" onClick={() => onDecide(h.decision === 'reject' ? 'pending' : 'reject')}>
          Reject
        </button>
      </div>
    </div>
  );
}

function counts(c: FileChange) {
  let add = 0;
  let del = 0;
  for (const h of c.hunks) for (const l of h.lines) {
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
  return { add, del };
}

function File({ c, onDecide }: { c: FileChange; onDecide: (ids: string[], d: HunkDecision) => void }) {
  const [open, setOpen] = useState(true);
  const { add, del } = counts(c);
  const ids = c.hunks.map((h) => h.id);
  return (
    <div className="file">
      <div className="file-head">
        <button className="file-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="chev" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="ellipsis" title={c.path}>
            {c.path}
          </span>
        </button>
        <span className="chip">{c.kind}</span>
        <span className="add-text">+{add}</span>
        <span className="del-text">−{del}</span>
      </div>
      <div className="file-actions">
        <button className="btn btn-sm" onClick={() => postToHost({ type: 'review.openDiff', path: c.path })}>
          Open diff
        </button>
        <button className="btn btn-sm" onClick={() => onDecide(ids, 'accept')}>
          Accept all
        </button>
        <button className="btn btn-sm" onClick={() => onDecide(ids, 'reject')}>
          Reject all
        </button>
      </div>
      {open &&
        c.hunks.map((h) => <HunkView key={h.id} h={h} onDecide={(d) => onDecide([h.id], d)} />)}
    </div>
  );
}

export function Review({
  changes,
  onDecide,
  onDecideAll,
}: {
  changes: FileChange[];
  onDecide: (ids: string[], d: HunkDecision) => void;
  onDecideAll: (d: HunkDecision) => void;
}) {
  const [reason, setReason] = useState('');
  const all = changes.flatMap((c) => c.hunks);
  const accepted = all.filter((h) => h.decision === 'accept').length;
  const pending = all.filter((h) => h.decision === 'pending').length;

  const decide = (ids: string[], d: HunkDecision) => {
    onDecide(ids, d);
    for (const id of ids) postToHost({ type: 'review.decide', hunkId: id, decision: d });
  };
  return (
    <div className="review">
      <div className="review-toolbar">
        <span className="muted">
          {all.length} hunks in {changes.length} files{pending ? ` · ${pending} undecided` : ''}
        </span>
        <span className="spacer" />
        <button
          className="btn btn-sm"
          onClick={() => {
            onDecideAll('accept');
            postToHost({ type: 'review.decideAll', decision: 'accept' });
          }}
        >
          Accept all
        </button>
        <button
          className="btn btn-sm"
          onClick={() => {
            onDecideAll('reject');
            postToHost({ type: 'review.decideAll', decision: 'reject' });
          }}
        >
          Reject all
        </button>
      </div>
      {changes.map((c) => (
        <File key={c.path} c={c} onDecide={decide} />
      ))}
      <div className="review-foot">
        <input
          type="text"
          value={reason}
          placeholder="Reason / feedback for the agent (optional)"
          aria-label="Review reason"
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          className="btn btn-primary"
          onClick={() => postToHost({ type: 'review.submit', reason: reason.trim() || undefined })}
        >
          Apply accepted ({accepted})
        </button>
      </div>
    </div>
  );
}
