// Shown only in the dev harness (outside VS Code).
import { useEffect, useState } from 'react';
import { loadSession, replay, reset, setServer, toggleSelection } from '../demo';

type Theme = 'dark' | 'light' | 'hc' | 'hc-light';

const BODY_CLASS: Record<Theme, string> = {
  dark: 'vscode-dark',
  light: 'vscode-light',
  hc: 'vscode-high-contrast',
  'hc-light': 'vscode-high-contrast vscode-high-contrast-light',
};

export function DevBar() {
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => {
    // dev-theme.css keys on data-dev-theme; the extension styles key on VS Code's body classes.
    document.documentElement.dataset.devTheme = theme === 'hc-light' ? 'light' : theme;
    document.body.className = BODY_CLASS[theme];
  }, [theme]);
  return (
    <div className="devbar" role="toolbar" aria-label="Dev harness">
      <span className="muted">dev</span>
      <button className="btn btn-sm" onClick={() => replay()}>
        Replay run
      </button>
      <button className="btn btn-sm" onClick={() => reset()}>
        Empty state
      </button>
      <select defaultValue="up" aria-label="TrueForge state" onChange={(e) => setServer(e.target.value as 'up' | 'down' | 'empty')}>
        <option value="up">TrueForge up</option>
        <option value="empty">No models</option>
        <option value="down">TrueForge down</option>
      </select>
      <button className="btn btn-sm" onClick={() => loadSession()}>
        Load session
      </button>
      <button
        className="btn btn-sm"
        onClick={() =>
          loadSession(
            'The last turn of this session is still running or waiting for approval in TrueForge. Sending a message now will cancel it.',
          )
        }
      >
        Load unfinished
      </button>
      <button className="btn btn-sm" onClick={() => toggleSelection()}>
        Toggle selection
      </button>
      <button className="btn btn-sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle light and dark theme">
        {theme === 'dark' ? 'Light' : 'Dark'}
      </button>
      <select value={theme} aria-label="Theme" onChange={(e) => setTheme(e.target.value as Theme)}>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="hc">High contrast</option>
        <option value="hc-light">High contrast light</option>
      </select>
    </div>
  );
}
