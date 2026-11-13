import { z } from 'zod';
import { defineTool, ToolError } from '../tool';
import { normalizeRelPath } from '../util';
import { isExcludedName } from '../workspace';
import type { Workspace } from '../workspace';

const MAX_ENTRIES = 300;

export const listDirTool = defineTool({
  name: 'list_dir',
  description:
    'List files and folders under a workspace directory as an indented tree (folders end with "/"). ' +
    'Skips noise such as .git, node_modules, .venv, __pycache__ and dist. ' +
    'Use it to orient yourself in an unfamiliar repo: start with no arguments (workspace root, depth 2), then drill into a folder. ' +
    'To find code by content use search_code; to find a definition use find_symbol.',
  inputSchema: z.object({
    path: z.string().optional().describe('Workspace-relative directory. Default: the workspace root.'),
    depth: z.number().int().min(1).max(6).optional().describe('How many levels to show (default 2, max 6).'),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler({ path, depth }, { workspace }) {
    const rel = normalizeRelPath(path ?? '', workspace.root);
    const maxDepth = depth ?? 2;
    const top = await workspace.listDir(rel);
    if (!top) {
      if (await workspace.exists(rel)) throw new ToolError(`"${rel}" is a file, not a directory. Use read_file.`);
      throw new ToolError(`Directory not found: "${rel}". Use list_dir with no path to see the workspace root.`);
    }
    const out: string[] = [`${rel === '' ? '.' : rel}/`];
    let count = 0;
    let truncated = false;

    const render = async (dirRel: string, entries: Awaited<ReturnType<Workspace['listDir']>>, level: number): Promise<void> => {
      const list = (entries ?? [])
        .filter((e) => !(e.isDir && isExcludedName(e.name)))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
      for (const e of list) {
        if (count >= MAX_ENTRIES) {
          truncated = true;
          return;
        }
        count++;
        out.push(`${'  '.repeat(level)}${e.name}${e.isDir ? '/' : ''}`);
        if (e.isDir && level < maxDepth) {
          const childRel = dirRel ? `${dirRel}/${e.name}` : e.name;
          await render(childRel, await workspace.listDir(childRel), level + 1);
        } else if (e.isDir) {
          const childRel = dirRel ? `${dirRel}/${e.name}` : e.name;
          const kids = (await workspace.listDir(childRel))?.filter((k) => !(k.isDir && isExcludedName(k.name))) ?? [];
          if (kids.length) out[out.length - 1] += `  (${kids.length} items; use list_dir path="${childRel}")`;
        }
      }
    };
    await render(rel, top, 1);
    if (count === 0) out.push('  (empty)');
    if (truncated) out.push(`... [truncated at ${MAX_ENTRIES} entries. List a subdirectory or lower depth.]`);
    return out.join('\n');
  },
});
