// Typed accessor for the temper.* settings.
// Defaults here must match contributes.configuration in package.json
// (enforced by test/settings.test.ts).

export type ReviewMode = 'endOfRun' | 'perEdit';
export type ScopeFenceMode = 'flagAndReject' | 'block' | 'warn' | 'off';
export type SymbolCheckMode = 'bounceThenWarn' | 'bounce' | 'warn' | 'off';

export interface TemperSettings {
  trueforge: {
    baseUrl: string;
    agent: string;
    inlineAgent: string;
  };
  models: {
    chain: string[];
    agentMode: string;
    inlineEdit: string;
    fallback: { enabled: boolean; retries: number };
  };
  context: {
    budgetTokens: number;
    budgetPercent: number;
    exclude: string[];
  };
  review: { mode: ReviewMode };
  commands: { allowlist: string[]; runInShadowWorktree: boolean };
  guards: { scopeFence: ScopeFenceMode; symbolCheck: SymbolCheckMode };
  mcp: { port: number };
  ui: { showLedger: boolean };
}

export const DEFAULT_SETTINGS: Readonly<TemperSettings> = {
  trueforge: { baseUrl: 'http://127.0.0.1:8790', agent: '', inlineAgent: '' },
  models: {
    chain: [],
    agentMode: '',
    inlineEdit: '',
    fallback: { enabled: true, retries: 1 },
  },
  context: {
    budgetTokens: 0,
    budgetPercent: 25,
    exclude: ['.git', 'node_modules', 'dist', 'out', '.venv', '__pycache__'],
  },
  review: { mode: 'endOfRun' },
  commands: {
    allowlist: ['pytest', 'python -c', 'git diff', 'git status', 'flask --help'],
    runInShadowWorktree: true,
  },
  guards: { scopeFence: 'flagAndReject', symbolCheck: 'bounceThenWarn' },
  mcp: { port: 0 },
  ui: { showLedger: true },
};

/** Minimal read interface, satisfied by vscode.WorkspaceConfiguration. */
export interface ConfigReader {
  get<T>(section: string): T | undefined;
}

function pick<T>(reader: ConfigReader, key: string, fallback: T): T {
  const value = reader.get<T>(key);
  return value === undefined || value === null ? fallback : value;
}

function pickEnum<T extends string>(
  reader: ConfigReader,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = reader.get<string>(key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function pickInt(reader: ConfigReader, key: string, fallback: number, min: number, max: number) {
  const value = reader.get<number>(key);
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function pickStrings(reader: ConfigReader, key: string, fallback: readonly string[]): string[] {
  const value = reader.get<unknown>(key);
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Read all temper.* settings from a reader scoped to the `temper` section. */
export function readSettings(reader: ConfigReader): TemperSettings {
  const d = DEFAULT_SETTINGS;
  return {
    trueforge: {
      baseUrl: pick(reader, 'trueforge.baseUrl', d.trueforge.baseUrl),
      agent: pick(reader, 'trueforge.agent', d.trueforge.agent),
      inlineAgent: pick(reader, 'trueforge.inlineAgent', d.trueforge.inlineAgent),
    },
    models: {
      chain: pickStrings(reader, 'models.chain', d.models.chain),
      agentMode: pick(reader, 'models.agentMode', d.models.agentMode),
      inlineEdit: pick(reader, 'models.inlineEdit', d.models.inlineEdit),
      fallback: {
        enabled: pick(reader, 'models.fallback.enabled', d.models.fallback.enabled),
        retries: pickInt(reader, 'models.fallback.retries', d.models.fallback.retries, 0, 5),
      },
    },
    context: {
      budgetTokens: pickInt(
        reader,
        'context.budgetTokens',
        d.context.budgetTokens,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      budgetPercent: pickInt(reader, 'context.budgetPercent', d.context.budgetPercent, 1, 90),
      exclude: pickStrings(reader, 'context.exclude', d.context.exclude),
    },
    review: {
      mode: pickEnum(reader, 'review.mode', ['endOfRun', 'perEdit'], d.review.mode),
    },
    commands: {
      allowlist: pickStrings(reader, 'commands.allowlist', d.commands.allowlist),
      runInShadowWorktree: pick(
        reader,
        'commands.runInShadowWorktree',
        d.commands.runInShadowWorktree,
      ),
    },
    guards: {
      scopeFence: pickEnum(
        reader,
        'guards.scopeFence',
        ['flagAndReject', 'block', 'warn', 'off'],
        d.guards.scopeFence,
      ),
      symbolCheck: pickEnum(
        reader,
        'guards.symbolCheck',
        ['bounceThenWarn', 'bounce', 'warn', 'off'],
        d.guards.symbolCheck,
      ),
    },
    mcp: { port: pickInt(reader, 'mcp.port', d.mcp.port, 0, 65535) },
    ui: { showLedger: pick(reader, 'ui.showLedger', d.ui.showLedger) },
  };
}
