// Edit-side MCP tools: propose_edit, create_file, submit_changeset, run_command.
// They are bound to the active run through `getRun`, so one long-lived MCP server serves every run.
import { z } from 'zod';
import type { ChangesetStore } from '../changeset';
import { checkSymbols } from '../guards';
import type { SymbolIndex } from '../guards';
import { defineTool, ToolError } from '../mcp';
import type { TemperTool } from '../mcp';
import type { TemperSettings } from '../config/settings';
import type { ScopeFlag } from '../shared/types';
import { checkCommand } from './commandPolicy';
import { runArgv } from './commandRunner';
import { shadowEnv } from './shadow';
import { STAGING_WAIT_MS, stagingOf } from './stagingTracker';
import type { ShadowWorktree } from './shadow';
import { namesFromStaged } from './symbolIndex';

/** An unresolved-symbol warning recorded at stage time; re-applied to hunks when review opens. */
export interface SymbolFlagRecord {
  path: string;
  symbols: string[];
  suggestions: Record<string, string[]>;
}

/** What the tools need from the active run. Implemented by RunController. */
export interface EditToolRun {
  runId: string;
  workspaceRoot: string;
  changeset: ChangesetStore;
  settings(): TemperSettings;
  symbolIndex(): Promise<SymbolIndex>;
  shadow(): ShadowWorktree;
  /** unknown-symbol warnings to attach to hunks at review time */
  symbolFlags: SymbolFlagRecord[];
  /** how many times an edit with these unknown symbols was already bounced (key: path + names) */
  bounces: Map<string, number>;
  /** Called by submit_changeset after TrueForge approval. Applies accepted hunks, returns the model-facing summary. */
  applySubmitted(summary: string): Promise<string>;
}

const CODE_EXT = /\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|cs|rb|php|c|h|cc|cpp|hpp|swift|scala)$/i;

function languageFor(path: string): 'python' | 'generic' {
  return /\.pyi?$/i.test(path) ? 'python' : 'generic';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Attach recorded unknown-symbol flags to the hunks that introduce those names. Call before review. */
export function applySymbolFlags(changeset: ChangesetStore, records: SymbolFlagRecord[]): void {
  const files = changeset.files();
  for (const rec of records) {
    const file = files.find((f) => f.path === rec.path);
    if (!file || file.hunks.length === 0) continue;
    const re = new RegExp(`\\b(?:${rec.symbols.map(escapeRe).join('|')})\\b`);
    let targets = file.hunks.filter((h) => h.lines.some((l) => l.startsWith('+') && re.test(l)));
    if (targets.length === 0) targets = file.hunks;
    for (const h of targets) {
      if (h.flags.some((f) => f.kind === 'unknownSymbol' && rec.symbols.every((s) => f.symbols.includes(s)))) continue;
      const flag: ScopeFlag = { kind: 'unknownSymbol', symbols: rec.symbols, suggestions: rec.suggestions };
      changeset.addFlag(h.id, flag);
    }
  }
}

function need(getRun: () => EditToolRun | undefined): EditToolRun {
  const run = getRun();
  if (!run) throw new ToolError('No Temper run is active, so there is no changeset to edit.');
  return run;
}

function symbolMessage(unknown: string[], suggestions: Record<string, string[]>, final: boolean): string {
  const lines = unknown.map((n) => {
    const s = suggestions[n] ?? [];
    return `- ${n}${s.length ? ` (did you mean: ${s.join(', ')}?)` : ' (no similar name found)'}`;
  });
  return (
    `Not staged. Symbol check: these names are used by your edit but do not exist in the project:\n${lines.join('\n')}\n` +
    'Verify each with find_symbol, use the real names (or define them in the same edit), then propose the edit again.' +
    (final ? '' : ' If you are certain the names are right, send the same edit again and it will be staged with a warning for the reviewer.')
  );
}

const proposeEdit = (getRun: () => EditToolRun | undefined) =>
  defineTool({
    name: 'propose_edit',
    description:
      'Stage a search/replace edit to an existing file. Nothing is written to disk until the user approves it in review. ' +
      '`old_string` must be copied exactly from the current file (read it first, keep indentation) and be unique; the smallest change that works is best. ' +
      'Returns the staged diff, or an error telling you how to fix the edit (including unknown symbols). Edits to the same file accumulate.',
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative path of the file to edit'),
      old_string: z.string().describe('Exact text to replace (must match the file, whitespace included)'),
      new_string: z.string().describe('Replacement text'),
      rationale: z.string().describe('One sentence: why this change is needed'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async handler({ path, old_string, new_string, rationale }, ctx) {
      const run = need(getRun);
      // Tracked so submit_changeset (possibly in the same batch) can wait for staging to finish.
      return stagingOf(run).track(async () => {
      if (ctx.signal?.aborted) throw new ToolError('The run was cancelled.');
      const mode = run.settings().guards.symbolCheck;

      let warn: { unknown: string[]; suggestions: Record<string, string[]> } | undefined;
      if (mode !== 'off' && CODE_EXT.test(path)) {
        let current: string | null = null;
        try {
          current = await run.changeset.read(path);
        } catch {
          /* bad path: stage() reports it */
        }
        if (current !== null) {
          const index = await run.symbolIndex();
          const input = {
            oldText: old_string,
            newText: new_string,
            index,
            language: languageFor(path),
            fileText: current,
            extraKnown: namesFromStaged(run.changeset.files()),
            mode,
          } as const;
          const res = checkSymbols(input);
          if (res.unknown.length > 0) {
            const key = `${path}\n${[...res.unknown].sort().join(',')}`;
            const prior = run.bounces.get(key) ?? 0;
            const action = mode === 'bounceThenWarn' ? checkSymbols({ ...input, priorBounces: prior }).action : res.action;
            if (action === 'bounce') {
              run.bounces.set(key, prior + 1);
              throw new ToolError(symbolMessage(res.unknown, res.suggestions, mode === 'bounce'));
            }
            if (action === 'warn') warn = { unknown: res.unknown, suggestions: res.suggestions };
          }
        }
      }

      const r = await run.changeset.stage(path, old_string, new_string, rationale);
      if (!r.ok) throw new ToolError(r.message);
      let text = `Staged edit to ${r.path} (matched by ${r.matchStrategy ?? 'exact'}). Not applied yet: the user reviews at submit_changeset.\n${r.message}`;
      if (warn) {
        run.symbolFlags.push({ path: r.path, symbols: warn.unknown, suggestions: warn.suggestions });
        text += `\nWarning: unresolved symbols ${warn.unknown.join(', ')} were flagged for the reviewer. Double-check them with find_symbol.`;
      }
      return text;
      });
    },
  });

const createFile = (getRun: () => EditToolRun | undefined) =>
  defineTool({
    name: 'create_file',
    description:
      'Stage a new file with the given content. Fails if the file already exists (use propose_edit then). ' +
      'Nothing is written until the user approves it in review.',
    inputSchema: z.object({
      path: z.string().describe('Workspace-relative path of the new file'),
      content: z.string().describe('Full file content'),
      rationale: z.string().describe('One sentence: why this file is needed'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async handler({ path, content, rationale }) {
      const run = need(getRun);
      return stagingOf(run).track(async () => {
        const r = await run.changeset.createFile(path, content, rationale);
        if (!r.ok) throw new ToolError(r.message);
        return `Staged new file ${r.path}. Not written yet: the user reviews at submit_changeset.`;
      });
    },
  });

const submitChangeset = (getRun: () => EditToolRun | undefined) =>
  defineTool({
    name: 'submit_changeset',
    description:
      'Submit all staged edits for the user to review hunk by hunk. The user approves or rejects each hunk; only accepted hunks are written. ' +
      'Call once, only after propose_edit/create_file have returned successfully (never in the same batch as them). If it is denied, read the reason, revise your edits and submit again.',
    inputSchema: z.object({
      summary: z.string().describe('Concise summary of what changed and why'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async handler({ summary }) {
      const run = need(getRun);
      // propose_edit may be in the same batch: let it finish staging before looking at the changeset.
      await stagingOf(run).settle(STAGING_WAIT_MS);
      if (run.changeset.isEmpty()) {
        throw new ToolError(
          'Nothing is staged. Make edits with propose_edit or create_file first and wait for them to return successfully, then call submit_changeset.',
        );
      }
      try {
        return await run.applySubmitted(summary);
      } catch (e) {
        if (e instanceof ToolError) throw e;
        throw new ToolError(`Could not apply the changes: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

const runCommand = (getRun: () => EditToolRun | undefined) =>
  defineTool({
    name: 'run_command',
    description:
      'Run an allowlisted command (for example `pytest tests/test_x.py -q`) and return its exit code and output tail. ' +
      'It runs in an isolated copy of the workspace that includes your staged edits, never in the real files. ' +
      'No pipes, redirects or chaining (; & | > <). `git` commands run read-only against the real working tree. Timeout 120 s.',
    inputSchema: z.object({
      command: z.string().describe('A single command, e.g. "pytest tests/test_cli.py -q"'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async handler({ command }, ctx) {
      const run = need(getRun);
      const settings = run.settings();
      const chk = checkCommand(command, settings.commands.allowlist);
      if (!chk.ok) throw new ToolError(chk.reason);

      const isGit = chk.argv[0] === 'git';
      let cwd = run.workspaceRoot;
      let env = shadowEnv(process.env, run.workspaceRoot, undefined);
      let where = 'workspace';
      if (settings.commands.runInShadowWorktree && !isGit) {
        const shadow = run.shadow();
        await shadow.sync(run.changeset.files().map((f) => ({ path: f.path, content: f.proposed })));
        cwd = shadow.dir;
        env = shadowEnv(process.env, run.workspaceRoot, shadow.dir);
        where = 'isolated copy with staged edits';
      }
      const res = await runArgv(chk.argv, { cwd, env, signal: ctx.signal, timeoutMs: 120_000, maxOutput: 8000 });
      if (res.spawnError) {
        throw new ToolError(`Could not start "${chk.argv[0]}": ${res.spawnError}. Check that it is installed (a .venv in the workspace is used automatically).`);
      }
      if (res.aborted) throw new ToolError('The command was cancelled.');
      const head = res.timedOut ? 'Timed out after 120 s and was killed.' : `Exit code ${res.exitCode}.`;
      return `$ ${chk.normalized}  [${where}]\n${head}\n${res.output || '(no output)'}`;
    },
  });

/** propose_edit, create_file, submit_changeset, run_command bound to the active run. */
export function createEditTools(getRun: () => EditToolRun | undefined): TemperTool[] {
  return [proposeEdit(getRun), createFile(getRun), submitChangeset(getRun), runCommand(getRun)];
}
