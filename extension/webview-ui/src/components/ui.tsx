import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ModelHealth, ModelInfo } from '../../../src/shared/types';
import { fmtTokens } from '../../../src/shared/format';
import { postToHost } from '../vscode';

/* ------------------------------ icons ------------------------------ */

export function Icon({
  name,
  spin,
  className,
}: {
  name: string;
  spin?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    />
  );
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const h = () => setReduced(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return reduced;
}

/** Live-activity spinner; static outline icon under prefers-reduced-motion. */
export function Spinner() {
  const reduced = useReducedMotion();
  return reduced ? <Icon name="circle-large-outline" /> : <Icon name="loading" spin />;
}

export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  pressed,
  className,
  title,
}: {
  icon: string;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-btn${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

/* ------------------------------ helpers ------------------------------ */

export function splitPath(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
}

/** "provider/alias" -> "alias" for compact displays. */
export function shortModel(name: string): string {
  const i = name.indexOf('/');
  return i < 0 ? name : name.slice(i + 1);
}

export function fmtRange(start: number, end: number): string {
  return start === end ? `${start}` : `${start}–${end}`;
}

export function summarizeArgs(args: unknown, max = 60): string {
  let s: string;
  if (args == null) s = '';
  else if (typeof args === 'string') s = args;
  else if (typeof args === 'object') {
    const o = args as Record<string, unknown>;
    const pref = ['path', 'file', 'file_path', 'command', 'query', 'pattern', 'url', 'name'];
    const key =
      pref.find((k) => typeof o[k] === 'string') ??
      Object.keys(o).find((k) => typeof o[k] === 'string');
    s = key ? String(o[key]) : JSON.stringify(args);
  } else s = String(args);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export { fmtTokens };

const HEALTH_TONE: Record<ModelHealth, 'ok' | 'bad' | 'unknown'> = {
  ok: 'ok',
  failing: 'bad',
  unknown: 'unknown',
};

/** Dot + word so health is never colour-only. */
export function HealthPill({ health, lastError }: { health: ModelHealth; lastError?: string }) {
  return (
    <span
      className={`pill pill-${HEALTH_TONE[health]}`}
      title={lastError ? `${health}: ${lastError}` : `Health: ${health}`}
    >
      <span className="dot" aria-hidden="true" />
      {health}
    </span>
  );
}

/* ------------------------------ popover listbox ------------------------------ */

export interface PickerOption {
  id: string;
  node: ReactNode;
  selected?: boolean;
  /** accessible name */
  aria?: string;
  separatorBefore?: boolean;
}

/**
 * Button + fixed-position listbox. Keyboard: Up/Down/Home/End move, Enter/Space choose, Esc closes.
 * Esc is preventDefault-ed so the global Esc-to-stop does not fire.
 */
export function Picker({
  options,
  onChoose,
  trigger,
  triggerClass,
  triggerLabel,
  listLabel,
  disabled,
  placement = 'auto',
}: {
  options: PickerOption[];
  onChoose: (id: string) => void;
  trigger: ReactNode;
  triggerClass?: string;
  triggerLabel: string;
  listLabel: string;
  disabled?: boolean;
  placement?: 'auto' | 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<React.CSSProperties>({});
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const uid = useRef(`pk${Math.random().toString(36).slice(2, 8)}`).current;

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  }, []);

  const openIt = () => {
    const sel = options.findIndex((o) => o.selected);
    setActive(sel >= 0 ? sel : 0);
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(Math.max(r.width, 240), window.innerWidth - margin * 2);
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - width - margin));
    const spaceAbove = r.top - margin;
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const up =
      placement === 'up' || (placement === 'auto' && spaceBelow < 220 && spaceAbove > spaceBelow);
    const maxHeight = Math.max(120, Math.min(320, up ? spaceAbove - 4 : spaceBelow - 4));
    setPos(
      up
        ? { left, width, maxHeight, bottom: window.innerHeight - r.top + 4 }
        : { left, width, maxHeight, top: r.bottom + 4 },
    );
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const away = () => setOpen(false);
    document.addEventListener('mousedown', down);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('mousedown', down);
      window.removeEventListener('resize', away);
    };
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${uid}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, uid]);

  const choose = (i: number) => {
    const o = options[i];
    if (!o) return;
    close();
    onChoose(o.id);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const n = options.length;
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % n);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + n) % n);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(n - 1);
    else if (e.key === 'Enter' || e.key === ' ') choose(active);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') {
      setOpen(false);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={triggerClass}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={triggerLabel}
        disabled={disabled}
        onClick={() => (open ? close(false) : openIt())}
      >
        {trigger}
      </button>
      {open && (
        <ul
          ref={list}
          className="popover"
          role="listbox"
          tabIndex={-1}
          aria-label={listLabel}
          aria-activedescendant={`${uid}-${active}`}
          style={pos}
          onKeyDown={onKey}
        >
          {options.map((o, i) => (
            <li
              key={o.id}
              id={`${uid}-${i}`}
              role="option"
              aria-selected={!!o.selected}
              aria-label={o.aria}
              className={`opt${i === active ? ' active' : ''}${o.separatorBefore ? ' sep' : ''}`}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(i)}
            >
              {o.node}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const MANAGE = '\u0000manage';
const NONE = '\u0000none';

/** Model chooser built on Picker. */
export function ModelPicker({
  models,
  value,
  onPick,
  onManage,
  variant,
  label,
  disabled,
  placement,
}: {
  models: ModelInfo[];
  value: string;
  onPick: (name: string) => void;
  onManage?: () => void;
  variant: 'compact' | 'field';
  label: string;
  disabled?: boolean;
  placement?: 'auto' | 'up' | 'down';
}) {
  const options: PickerOption[] = models.map((m) => ({
    id: m.name,
    selected: m.name === value,
    aria: `${m.name}, ${m.provider}, ${m.health}${m.name === value ? ', current' : ''}`,
    node: (
      <>
        <span
          className={`dot dot-${HEALTH_TONE[m.health]}`}
          aria-hidden="true"
          title={m.lastError ?? `Health: ${m.health}`}
        />
        <span className="opt-main">
          <span className="ellipsis opt-name">{shortModel(m.name)}</span>
          <span className="ellipsis muted opt-sub">
            {m.provider}
            {m.contextLength ? ` · ${fmtTokens(m.contextLength)} ctx` : ''}
            {m.health !== 'ok' ? ` · ${m.health}` : ''}
          </span>
        </span>
        {m.name === value && <Icon name="check" />}
      </>
    ),
  }));
  if (models.length === 0) {
    options.push({ id: NONE, node: <span className="muted">No models available</span> });
  }
  if (onManage) {
    options.push({
      id: MANAGE,
      separatorBefore: true,
      node: (
        <>
          <Icon name="settings-gear" />
          <span className="opt-main">Manage fallback chain…</span>
        </>
      ),
    });
  }
  const current = models.find((m) => m.name === value);
  return (
    <Picker
      options={options}
      onChoose={(id) => {
        if (id === MANAGE) onManage?.();
        else if (id !== NONE) onPick(id);
      }}
      triggerClass={variant === 'compact' ? 'model-btn' : 'field-btn'}
      triggerLabel={`${label}: ${value || 'none'}`}
      listLabel={label}
      disabled={disabled}
      placement={placement}
      trigger={
        variant === 'compact' ? (
          <>
            <span className="ellipsis" title={value}>
              {value ? shortModel(value) : 'No model'}
            </span>
            <Icon name="chevron-down" />
          </>
        ) : (
          <>
            {current && (
              <span className={`dot dot-${HEALTH_TONE[current.health]}`} aria-hidden="true" />
            )}
            <span className="ellipsis" title={value}>
              {value || 'Choose a model'}
            </span>
            <Icon name="chevron-down" />
          </>
        )
      }
    />
  );
}

/** Link-styled button that opens a workspace file in the editor. */
export function FileLink({
  path,
  line,
  label,
  className,
}: {
  path: string;
  line?: number;
  label?: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`file-link ${className ?? ''}`}
      title={`Open ${path}${line ? `:${line}` : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        postToHost({ type: 'open.file', path, line });
      }}
    >
      {label ?? path}
    </button>
  );
}
