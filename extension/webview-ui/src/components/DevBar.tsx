// Shown only in the dev harness (outside VS Code).
import { useEffect, useState } from 'react';
import { replay } from '../demo';

export function DevBar() {
  const [theme, setTheme] = useState<'dark' | 'light' | 'hc'>('dark');
  useEffect(() => {
    document.documentElement.dataset.devTheme = theme;
  }, [theme]);
  return (
    <div className="devbar" role="toolbar" aria-label="Dev harness">
      <span className="muted">dev</span>
      <button className="btn btn-sm" onClick={() => replay()}>
        Replay demo
      </button>
      <select value={theme} aria-label="Theme" onChange={(e) => setTheme(e.target.value as typeof theme)}>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="hc">High contrast</option>
      </select>
    </div>
  );
}
