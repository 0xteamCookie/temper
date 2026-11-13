import { summarizeArgs } from './ui';

export type ToolCat = 'read' | 'search' | 'context' | 'edit' | 'run' | 'submit' | 'tools' | 'other';

export interface ToolInfo {
  cat: ToolCat;
  icon: string;
  label: string;
}

/** Categorise a tool call by name substring (see spec section 3). */
export function categorize(name: string): ToolInfo {
  const n = name.toLowerCase();
  if (n.includes('submit_changeset') || n.includes('submit')) return { cat: 'submit', icon: 'checklist', label: 'Submitted for review' };
  if (n.includes('list_tools') || n.includes('get_tool_info') || n.includes('tool_info')) return { cat: 'tools', icon: 'tools', label: 'Loaded tools' };
  if (n.includes('run_command') || n.includes('command') || n.includes('shell') || n.includes('bash') || n.includes('exec'))
    return { cat: 'run', icon: 'terminal', label: 'Ran' };
  if (n.includes('propose_edit') || n.includes('edit') || n.includes('write') || n.includes('replace') || n.includes('patch'))
    return { cat: 'edit', icon: 'edit', label: 'Edited' };
  if (n.includes('get_context') || n.includes('retrieve')) return { cat: 'context', icon: 'search', label: 'Gathered context' };
  if (n.includes('search') || n.includes('grep') || n.includes('find')) return { cat: 'search', icon: 'search', label: 'Searched' };
  if (n.includes('read') || n.includes('get_file') || n.includes('open_file') || n === 'cat') return { cat: 'read', icon: 'file', label: 'Read' };
  return { cat: 'other', icon: 'symbol-method', label: name };
}

export interface FileTarget {
  path: string;
  line?: number;
}

/** A workspace file this tool call operates on, if any (read / edit categories). */
export function fileTarget(cat: ToolCat, args: unknown): FileTarget | undefined {
  if (cat !== 'read' && cat !== 'edit') return undefined;
  if (!args || typeof args !== 'object') return undefined;
  const o = args as Record<string, unknown>;
  const key = ['path', 'file', 'file_path', 'filepath', 'filename'].find((k) => typeof o[k] === 'string' && o[k]);
  if (!key) return undefined;
  const lineKey = ['line', 'start_line', 'startLine', 'offset'].find((k) => typeof o[k] === 'number');
  const line = lineKey ? (o[lineKey] as number) : undefined;
  return { path: o[key] as string, line: line && line > 0 ? line : undefined };
}

/** Short mono text shown beside the label when it is not a clickable file. */
export function plainTarget(cat: ToolCat, args: unknown): string {
  if (cat === 'submit' || cat === 'tools') return '';
  if (cat === 'run' && args && typeof args === 'object') {
    const c = (args as Record<string, unknown>).command;
    if (typeof c === 'string') return c.replace(/\s+/g, ' ').trim();
  }
  return summarizeArgs(args, 80);
}

export interface ToolLike {
  name: string;
  args: unknown;
  pending: boolean;
  isError?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Read 4 files · searched 2 · edited 3 files · ran pytest" */
export function summarizeTools(tools: ToolLike[]): { text: string; failed: number } {
  const c = { read: 0, search: 0, context: 0, edit: 0, run: 0, submit: 0, tools: 0, other: 0 };
  const cmds: string[] = [];
  let failed = 0;
  for (const t of tools) {
    const info = categorize(t.name);
    c[info.cat]++;
    if (info.cat === 'run') cmds.push(plainTarget('run', t.args).split(' ')[0] ?? '');
    if (t.isError) failed++;
  }
  const parts: string[] = [];
  if (c.read) parts.push(`read ${plural(c.read, 'file')}`);
  if (c.search) parts.push(`searched ${c.search}`);
  if (c.context) parts.push(`gathered context ${c.context > 1 ? `${c.context}×` : ''}`.trim());
  if (c.edit) parts.push(`edited ${plural(c.edit, 'file')}`);
  if (c.run) parts.push(c.run === 1 && cmds[0] ? `ran ${cmds[0]}` : `ran ${plural(c.run, 'command')}`);
  if (c.submit) parts.push('submitted for review');
  if (c.tools) parts.push('loaded tools');
  if (c.other) parts.push(plural(c.other, 'other call'));
  let text = parts.join(' · ');
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return { text: text || 'No steps', failed };
}
