import type { ReactNode } from 'react';

export function Dot({ tone, label }: { tone: 'ok' | 'bad' | 'unknown'; label: string }) {
  return <span className={`dot dot-${tone}`} role="img" aria-label={label} title={label} />;
}

export function Section({
  id,
  title,
  open,
  onToggle,
  badge,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section" id={`sec-${id}`} aria-labelledby={`sec-h-${id}`}>
      <h2 id={`sec-h-${id}`}>
        <button className="sec-toggle" aria-expanded={open} aria-controls={`sec-body-${id}`} onClick={onToggle}>
          <span className="chev" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span>{title}</span>
          {badge !== undefined && <span className="badge">{badge}</span>}
        </button>
      </h2>
      {open && (
        <div className="sec-body" id={`sec-body-${id}`}>
          {children}
        </div>
      )}
    </section>
  );
}

export function summarizeArgs(args: unknown, max = 60): string {
  let s: string;
  if (args == null) s = '';
  else if (typeof args === 'string') s = args;
  else if (typeof args === 'object') {
    const o = args as Record<string, unknown>;
    const pref = ['path', 'file', 'file_path', 'command', 'query', 'pattern', 'url', 'name'];
    const key = pref.find((k) => typeof o[k] === 'string') ?? Object.keys(o).find((k) => typeof o[k] === 'string');
    s = key ? String(o[key]) : JSON.stringify(args);
  } else s = String(args);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function fmtTokens(n: number): string {
  return n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
}
