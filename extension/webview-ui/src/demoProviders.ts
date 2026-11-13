// Dev harness: mock host for the Providers screen (keys are never typed in the browser; the real host
// uses VS Code input boxes). Lets `npm run dev` preview connected, empty, busy and server-down states.
import type { HostMessage, WebviewMessage } from './vscode';
import type { ProviderPanelState, ProviderRow } from '../../src/shared/providers';

type Send = (m: HostMessage) => void;

const row = (
  name: string,
  label: string,
  connected: boolean,
  modelCount = 0,
  extra: Partial<ProviderRow> = {},
): ProviderRow => ({
  name,
  label,
  kind: 'catalog',
  connected,
  modelCount,
  ...extra,
});

let rows: ProviderRow[] = [
  row('openai', 'OpenAI', false),
  row('anthropic', 'Anthropic', true, 3),
  row('google-gemini', 'Google Gemini', true, 2),
  row('fireworks', 'Fireworks AI', false),
  row('together', 'Together AI', false),
  row('moonshot', 'Moonshot AI', false),
  row('zai', 'Z.ai', false),
  row('alibaba', 'Alibaba Cloud (Qwen)', false),
  row('ollama', 'ollama', true, 1, { kind: 'custom', baseUrl: 'http://127.0.0.1:11434/v1' }),
];
let state: ProviderPanelState = { rows, busy: null };
let send: Send = () => {};

const publish = () => send({ type: 'providers.state', state });

function simulate(name: string, text: string, onDone?: () => void): void {
  state = { rows, busy: name };
  publish();
  window.setTimeout(() => {
    onDone?.();
    state = { rows, busy: null, result: { scope: name, level: 'info', text } };
    publish();
  }, 700);
}

export function bindProviders(s: Send): void {
  send = s;
}

export function providersHandle(m: WebviewMessage): boolean {
  switch (m.type) {
    case 'ready':
    case 'providers.refresh':
      publish();
      return m.type === 'providers.refresh';
    case 'providers.add':
      simulate(
        m.id,
        'Connected: 3 models saved in TrueForge. (dev mock: no key was entered)',
        () => {
          rows = rows.map((r) => (r.name === m.id ? { ...r, connected: true, modelCount: 3 } : r));
        },
      );
      return true;
    case 'providers.edit':
      simulate(m.name, 'Updated: models saved in TrueForge. (dev mock)');
      return true;
    case 'providers.check':
      simulate(
        m.name,
        'TrueForge serves all configured models. The key was not verified with the provider. No model was called.',
      );
      return true;
    case 'providers.remove':
      simulate(m.name, `Removed ${m.name} from TrueForge.`, () => {
        rows = rows.map((r) => (r.name === m.name ? { ...r, connected: false, modelCount: 0 } : r));
      });
      return true;
    case 'server.start':
    case 'server.copyCommand':
      state = {
        rows,
        busy: null,
        result: {
          scope: 'server',
          level: 'info',
          text: 'The start script was not found in this workspace. The command below was copied.',
          command: 'npx @truefoundry/trueforge@0.185.0',
        },
      };
      publish();
      return true;
    case 'connection.retry':
      send({ type: 'connection', trueforge: 'connected' });
      return true;
    default:
      return false;
  }
}
