import { useEffect, useRef, useState } from 'react';
import type { Mention } from '../vscode';
import { postToHost } from '../vscode';

const TOKEN = /(^|\s)@([^\s@]*)$/;

export function Composer({
  running,
  suggestions,
  onSend,
  onClearSuggestions,
}: {
  running: boolean;
  suggestions?: { query: string; items: Mention[] };
  onSend: (text: string, mentions: Mention[]) => void;
  onClearSuggestions: () => void;
}) {
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);

  const items = query !== null && suggestions && suggestions.query === query ? suggestions.items : [];
  const listOpen = items.length > 0;

  useEffect(() => setActive(0), [suggestions]);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const onChange = (value: string, caret: number) => {
    setText(value);
    const m = TOKEN.exec(value.slice(0, caret));
    if (m) {
      setQuery(m[2]!);
      postToHost({ type: 'mention.query', query: m[2]! });
    } else {
      setQuery(null);
      onClearSuggestions();
    }
  };

  const pick = (item: Mention) => {
    const el = ta.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(TOKEN, '$1');
    setText(before + text.slice(caret));
    setMentions((cur) => (cur.some((c) => c.kind === item.kind && c.value === item.value) ? cur : [...cur, item]));
    setQuery(null);
    onClearSuggestions();
    el?.focus();
  };

  const send = () => {
    const t = text.trim();
    if (!t || running) return;
    onSend(t, mentions);
    setText('');
    setMentions([]);
    setQuery(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (listOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % items.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + items.length) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(items[active]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault(); // marks the event handled so the global Esc-to-stop ignores it
        setQuery(null);
        onClearSuggestions();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {mentions.length > 0 && (
        <div className="chips" aria-label="Selected mentions">
          {mentions.map((m) => (
            <span key={m.kind + m.value} className="chip chip-mention">
              {m.kind === 'symbol' ? '#' : '@'}
              {m.value}
              <button
                type="button"
                className="chip-x"
                aria-label={`Remove mention ${m.value}`}
                onClick={() => setMentions(mentions.filter((x) => x !== m))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-row">
        {listOpen && (
          <ul className="suggest" role="listbox" aria-label="Mention suggestions">
            {items.map((it, i) => (
              <li key={it.kind + it.value} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  className={i === active ? 'active' : ''}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(it)}
                >
                  <span className="muted">{it.kind === 'symbol' ? '#' : '@'}</span> {it.value}
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ta}
          value={text}
          rows={2}
          placeholder="Ask Temper… (@ to add context, Shift+Enter for newline)"
          aria-label="Message"
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onKeyDown={onKeyDown}
        />
        {running ? (
          <button type="button" className="btn btn-stop" onClick={() => postToHost({ type: 'run.cancel' })} title="Stop (Esc)">
            Stop
          </button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={!text.trim()}>
            Send
          </button>
        )}
      </div>
    </form>
  );
}
