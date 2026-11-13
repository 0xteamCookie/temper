import { useEffect, useRef, useState } from 'react';
import type { ComposerMode, EditorSelection } from '../../../src/shared/messages';
import type { ModelInfo } from '../../../src/shared/types';
import type { Mention } from '../vscode';
import { postToHost } from '../vscode';
import { Icon, IconButton, ModelPicker, fmtRange, splitPath } from './ui';

const TOKEN = /(^|\s)@([^\s@]*)$/;
const MAX_LINES = 10;

export interface ComposerFocus {
  nonce: number;
  selection?: EditorSelection;
  mode?: ComposerMode;
  text?: string;
}

function selLabel(s: EditorSelection): string {
  return `${splitPath(s.path).base} ${fmtRange(s.startLine, s.endLine)}`;
}

export function Composer({
  running,
  reviewPending,
  suggestions,
  selection,
  focus,
  models,
  agentModel,
  inlineModel,
  onSend,
  onClearSuggestions,
  onPickModel,
  onManageModels,
}: {
  running: boolean;
  /** A review is open: a new message would cancel the paused turn, so sending waits. */
  reviewPending: boolean;
  suggestions?: { query: string; items: Mention[] };
  selection: EditorSelection | null;
  focus?: ComposerFocus;
  models: ModelInfo[];
  agentModel: string;
  inlineModel: string;
  onSend: (text: string, mentions: Mention[], mode: ComposerMode, selection?: EditorSelection) => void;
  onClearSuggestions: () => void;
  onPickModel: (mode: 'agent' | 'inline', name: string) => void;
  onManageModels: () => void;
}) {
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<ComposerMode>('agent');
  const [included, setIncluded] = useState(true);
  const [pinned, setPinned] = useState<EditorSelection | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  // The pinned selection wins; otherwise the live editor selection when the eye is on.
  const effective: EditorSelection | null = pinned ?? (selection && included ? selection : null);

  const items = query !== null && suggestions && suggestions.query === query ? suggestions.items : [];
  const listOpen = items.length > 0;

  useEffect(() => setActive(0), [suggestions]);

  // Editing a selection needs one; fall back to Agent when it goes away.
  useEffect(() => {
    if (mode === 'edit' && !effective) setMode('agent');
  }, [mode, effective]);

  // A fresh selection re-enables the eye.
  useEffect(() => {
    if (!selection) setIncluded(true);
  }, [selection]);

  // "Add selection to chat" / example prompts.
  const lastNonce = useRef(0);
  useEffect(() => {
    if (!focus || focus.nonce === lastNonce.current) return;
    lastNonce.current = focus.nonce;
    if (focus.selection) setPinned(focus.selection);
    if (focus.mode) setMode(focus.mode);
    if (focus.text !== undefined) setText(focus.text);
    ta.current?.focus();
  }, [focus]);

  // Auto-grow 2 -> 10 lines.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
    el.style.height = `${Math.min(el.scrollHeight, lh * MAX_LINES)}px`;
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

  const insertAt = () => {
    const el = ta.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const sep = before && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${sep}@${text.slice(caret)}`;
    setText(next);
    setQuery('');
    postToHost({ type: 'mention.query', query: '' });
    requestAnimationFrame(() => {
      el?.focus();
      const pos = before.length + sep.length + 1;
      el?.setSelectionRange(pos, pos);
    });
  };

  const canSend = !!text.trim() && !running && !reviewPending && (mode !== 'edit' || !!effective);

  const send = () => {
    const t = text.trim();
    if (!canSend) return;
    onSend(t, mentions, mode, effective ?? undefined);
    setText('');
    setMentions([]);
    setPinned(null);
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

  const editDisabled = !effective;
  const hasChips = !!pinned || !!selection || mentions.length > 0;
  const modelValue = mode === 'edit' ? inlineModel : agentModel;

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {listOpen && (
        <ul className="suggest" role="listbox" aria-label="Mention suggestions">
          {items.map((it, i) => {
            const { dir, base } = splitPath(it.value);
            return (
              <li
                key={it.kind + it.value}
                role="option"
                aria-selected={i === active}
                className={`opt${i === active ? ' active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(it)}
              >
                <Icon name={it.kind === 'symbol' ? 'symbol-method' : 'file'} />
                <span className="ellipsis">
                  {it.kind === 'file' ? (
                    <>
                      <span className="muted">{dir}</span>
                      <strong>{base}</strong>
                    </>
                  ) : (
                    <strong>{it.value}</strong>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="composer-box">
        {hasChips && (
          <div className="chips composer-chips" aria-label="Context for this message">
            {pinned ? (
              <span className="chip chip-accent" title={`${pinned.path}:${pinned.startLine}-${pinned.endLine}`}>
                <Icon name="selection" />
                <span className="ellipsis">{selLabel(pinned)}</span>
                <IconButton icon="close" label="Remove pinned selection" className="chip-x" onClick={() => setPinned(null)} />
              </span>
            ) : (
              selection && (
                <span
                  className={`chip${included ? ' chip-accent' : ' chip-off'}`}
                  title={`${selection.path}:${selection.startLine}-${selection.endLine}`}
                >
                  <Icon name="selection" />
                  <span className="ellipsis">{selLabel(selection)}</span>
                  <IconButton
                    icon={included ? 'eye' : 'eye-closed'}
                    label={included ? 'Selection included. Click to exclude' : 'Selection excluded. Click to include'}
                    pressed={included}
                    className="chip-x"
                    onClick={() => setIncluded(!included)}
                  />
                </span>
              )
            )}
            {mentions.map((m) => (
              <span key={m.kind + m.value} className="chip" title={m.value}>
                <Icon name={m.kind === 'symbol' ? 'symbol-method' : 'file'} />
                <span className="ellipsis">{m.kind === 'file' ? splitPath(m.value).base : m.value}</span>
                <IconButton
                  icon="close"
                  label={`Remove mention ${m.value}`}
                  className="chip-x"
                  onClick={() => setMentions(mentions.filter((x) => x !== m))}
                />
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          value={text}
          rows={2}
          placeholder={
            mode === 'edit' ? 'Describe the edit to the selected lines' : 'Describe a change, or ask about the code. @ to add context'
          }
          aria-label="Message"
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <div className="composer-bar">
          <IconButton icon="mention" label="Add file or symbol (@)" onClick={insertAt} />
          <div className="seg" role="group" aria-label="Mode">
            <button
              type="button"
              className="seg-btn"
              aria-pressed={mode === 'agent'}
              title="Agent: explore the repo and propose changes for review"
              onClick={() => setMode('agent')}
            >
              <Icon name="robot" />
              <span className="seg-label">Agent</span>
            </button>
            <button
              type="button"
              className="seg-btn"
              aria-pressed={mode === 'edit'}
              disabled={editDisabled}
              title={editDisabled ? 'Select code in the editor first' : 'Edit: change only the selected lines'}
              onClick={() => setMode('edit')}
            >
              <Icon name="edit" />
              <span className="seg-label">Edit</span>
            </button>
          </div>
          <ModelPicker
            variant="compact"
            label={mode === 'edit' ? 'Inline edit model' : 'Agent model'}
            models={models}
            value={modelValue}
            placement="up"
            onPick={(name) => {
              onPickModel(mode === 'edit' ? 'inline' : 'agent', name);
              postToHost({ type: 'models.pick', mode: mode === 'edit' ? 'inline' : 'agent', name });
            }}
            onManage={onManageModels}
          />
          <span className="spacer" />
          {running ? (
            <button
              type="button"
              className="send send-stop"
              aria-label="Stop"
              title="Stop (Esc)"
              onClick={() => postToHost({ type: 'run.cancel' })}
            >
              <Icon name="debug-stop" />
            </button>
          ) : (
            <button
              type="submit"
              className="send"
              aria-label="Send"
              title={
                reviewPending
                  ? 'Finish the review before sending'
                  : mode === 'edit' && !effective
                    ? 'Select code first'
                    : 'Send (Enter)'
              }
              disabled={!canSend}
            >
              <Icon name="arrow-up" />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint muted">
        {running
          ? 'Wait for this run to finish, or stop it, before sending a follow-up'
          : reviewPending
            ? 'Finish the review before sending a follow-up'
            : 'Enter to send · Shift+Enter new line · Esc to stop'}
      </div>
    </form>
  );
}
