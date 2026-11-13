// Small form pieces shared by the Settings pages.
import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { postToHost } from '../vscode';
import { Icon } from './ui';

/** Write one allowlisted temper.* setting; the host validates and echoes a fresh snapshot. */
export const update = (key: string, value: unknown) => postToHost({ type: 'settings.update', key, value });

export function Page({ children }: { children: ReactNode }) {
  return <div className="settings-page">{children}</div>;
}

export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="group">
      {title && <h2 className="group-title">{title}</h2>}
      {children}
    </section>
  );
}

export function Help({ children }: { children: ReactNode }) {
  return <p className="muted small help">{children}</p>;
}

export function Toggle({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="check" htmlFor={id}>
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {help && <Help>{help}</Help>}
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  help,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; help?: string }[];
  help?: ReactNode;
  onChange: (v: T) => void;
}) {
  const id = useId();
  const cur = options.find((o) => o.value === value);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {(cur?.help ?? help) && <Help>{cur?.help ?? help}</Help>}
    </div>
  );
}

/** Integer input that commits on blur or Enter and reverts when the text is not a valid number in range. */
export function NumberField({
  label,
  value,
  min,
  max,
  suffix,
  help,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  help?: ReactNode;
  onCommit: (n: number) => void;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(String(value));
    setBad(false);
  }, [value]);
  const commit = () => {
    const n = Number(text.trim());
    if (text.trim() === '' || !Number.isInteger(n) || n < min || n > max) {
      setBad(true);
      return;
    }
    setBad(false);
    if (n !== value) onCommit(n);
  };
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="input-row">
        <input
          id={id}
          className="text-input num-input"
          inputMode="numeric"
          value={text}
          aria-invalid={bad}
          aria-describedby={bad ? `${id}-err` : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') {
              setText(String(value));
              setBad(false);
            }
          }}
        />
        {suffix && <span className="muted">{suffix}</span>}
      </div>
      {bad && (
        <p id={`${id}-err`} className="err-text small" role="alert">
          Enter a whole number from {min} to {max}.
        </p>
      )}
      {help && <Help>{help}</Help>}
    </div>
  );
}

/** "Edit in settings.json" link for list settings the panel does not edit itself. */
export function JsonLink({ settingKey, label = 'Edit in settings.json' }: { settingKey: string; label?: string }) {
  return (
    <button
      type="button"
      className="link-btn"
      onClick={() => postToHost({ type: 'settings.openJson', key: settingKey })}
    >
      <Icon name="go-to-file" /> {label}
    </button>
  );
}

export function StatusLine({
  tone,
  children,
}: {
  tone: 'ok' | 'bad' | 'muted';
  children: ReactNode;
}) {
  const icon = tone === 'ok' ? 'check' : tone === 'bad' ? 'error' : 'circle-outline';
  return (
    <span className={`status-line ${tone === 'ok' ? 'ok-text' : tone === 'bad' ? 'err-text' : 'muted'}`}>
      <Icon name={icon} /> {children}
    </span>
  );
}
