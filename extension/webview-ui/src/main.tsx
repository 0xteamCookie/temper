import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { isVsCode } from './vscode';

async function boot() {
  if (!isVsCode) {
    // Dev harness: mock host + fallback --vscode-* theme variables.
    await import('./dev-theme.css');
    (await import('./demo')).startDemo();
  }
  const container = document.getElementById('root');
  if (container) {
    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }
}

void boot();
