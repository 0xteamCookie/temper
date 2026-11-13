// Tiny safe markdown renderer: builds React elements only (never raw HTML).
import type { ReactNode } from 'react';

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*)/g;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const k = `${keyBase}-${n++}`;
    if (tok.startsWith('`')) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**') || tok.startsWith('__')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const nodes: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence (absent while streaming)
      nodes.push(
        <pre key={k++} className="md-code" data-lang={fence[1] || undefined}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const list = /^\s*([-*]|\d+\.)\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1]!);
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const mm = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        if (!mm) break;
        items.push(<li key={items.length}>{inline(mm[2]!, `l${k}-${items.length}`)}</li>);
        i++;
      }
      nodes.push(ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
      continue;
    }
    const head = /^#{1,6}\s+(.*)$/.exec(line);
    if (head) {
      nodes.push(
        <p key={k++} className="md-h">
          <strong>{inline(head[1]!, `h${k}`)}</strong>
        </p>,
      );
      i++;
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^\s*```/.test(lines[i]!) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]!) &&
      !/^#{1,6}\s/.test(lines[i]!)
    ) {
      para.push(lines[i++]!);
    }
    nodes.push(<p key={k++}>{inline(para.join('\n'), `p${k}`)}</p>);
  }
  return <div className="md">{nodes}</div>;
}
