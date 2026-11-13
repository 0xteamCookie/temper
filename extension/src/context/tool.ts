// get_context MCP tool + @mention parsing. Conforms to src/mcp/tool.ts (TemperTool / ToolContext).
import { z } from 'zod';
import type { TemperTool, ToolContext } from '../mcp/tool';
import type { ContextEngine } from './engine';
import type { Mention, Selection } from './types';
import type { LedgerSnapshot } from '../shared/types';

/**
 * Parse "@path/to/file.py" and "@symbol:name" (also "@name" without a path-ish shape = symbol).
 * Returns the mentions and the text with the @tokens left in place (the model should still see them).
 */
export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s(,])@([^\s,;)]+)/g)) {
    const m1 = m[1];
    if (!m1) continue;
    const raw = m1.replace(/[.:]+$/, '');
    const mention = parseMention(raw);
    if (!mention) continue;
    const key = `${mention.kind}:${mention.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(mention);
    }
  }
  return out;
}

/** Parse one mention token with or without the leading '@'. */
export function parseMention(token: string): Mention | undefined {
  const t = token.trim().replace(/^@/, '');
  if (!t) return undefined;
  const sym = /^(?:symbol|sym|fn|class):(.+)$/i.exec(t);
  if (sym?.[1]) return { kind: 'symbol', value: sym[1] };
  if (/[/\\]/.test(t) || /\.[A-Za-z0-9]{1,6}$/.test(t)) return { kind: 'file', value: t.replace(/\\/g, '/') };
  return { kind: 'symbol', value: t };
}

export interface GetContextToolOptions {
  /** Engine; falls back to `ctx.services.contextEngine` when omitted. */
  engine?: ContextEngine;
  /** Receives the LedgerSnapshot of every call (the Ledger panel subscribes here). */
  onSnapshot?: (snapshot: LedgerSnapshot, ctx: ToolContext) => void;
  /** Selected model's context window, for the adaptive budget. */
  getContextLength?: () => number | undefined;
  /** Current editor selection to treat as always-included context. */
  getSelection?: () => Selection | undefined;
  /** Explicit budget (Ledger slider); undefined = engine default. */
  getBudgetTokens?: () => number | undefined;
}

const inputSchema = z.object({
  task: z.string().describe('The task or question you need context for, in your own words. Mention identifiers, commands, files.'),
  mentions: z
    .array(z.string())
    .optional()
    .describe('Optional things to force-include, e.g. "@src/flask/cli.py" or "@symbol:run_command".'),
});

export function createGetContextTool(opts: GetContextToolOptions = {}): TemperTool {
  const tool: TemperTool<typeof inputSchema> = {
    name: 'get_context',
    description:
      'Assemble a size-budgeted pack of the most relevant code, tests and docs for a task, chosen by hybrid retrieval ' +
      '(symbol table, BM25, import/call graph, test and docs pairing). Each item says why it was picked. ' +
      'Call this first on an unfamiliar repository, before reading files one by one.',
    inputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async handler(args, ctx) {
      const engine = opts.engine ?? (ctx.services['contextEngine'] as ContextEngine | undefined);
      if (!engine) throw new Error('get_context: no context engine is registered');
      const mentions: Mention[] = [...parseMentions(args.task)];
      for (const m of args.mentions ?? []) {
        const p = parseMention(m);
        if (p && !mentions.some((x) => x.kind === p.kind && x.value === p.value)) mentions.push(p);
      }
      const contextLength = opts.getContextLength?.();
      const budgetTokens = opts.getBudgetTokens?.();
      const selection = opts.getSelection?.();
      const res = await engine.assemble({
        task: args.task,
        runId: ctx.runId,
        mentions,
        ...(selection ? { selection } : {}),
        ...(budgetTokens ? { budgetTokens } : {}),
        ...(contextLength ? { contextLength } : {}),
      });
      opts.onSnapshot?.(res.snapshot, ctx);
      return res.text;
    },
  };
  return tool as unknown as TemperTool;
}
