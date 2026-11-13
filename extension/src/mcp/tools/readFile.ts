import { z } from 'zod';
import { defineTool, ToolError } from '../tool';
import { looksBinary, normalizeRelPath, suggestPaths } from '../util';

export const DEFAULT_MAX_LINES = 400;

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read a text file from the workspace and return it with line numbers (format "  12| code"). ' +
    'Reflects any edits already proposed in this session. ' +
    `Returns at most ${DEFAULT_MAX_LINES} lines by default; for larger files pass start_line/end_line (1-based, inclusive) ` +
    'to page through, or use search_code / find_symbol first to locate the part you need. ' +
    'Use workspace-relative paths such as "src/app/models.py". Do not guess paths: use list_dir or search_code if unsure. ' +
    'Line numbers are display-only; never include them in edit text.',
  inputSchema: z.object({
    path: z.string().describe('Workspace-relative file path, e.g. "src/flask/app.py"'),
    start_line: z.number().int().min(1).optional().describe('First line to return (1-based). Default 1.'),
    end_line: z.number().int().min(1).optional().describe(`Last line to return (inclusive). Default start_line+${DEFAULT_MAX_LINES - 1}.`),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler({ path, start_line, end_line }, { workspace }) {
    const rel = normalizeRelPath(path, workspace.root);
    const text = await workspace.readFile(rel);
    if (text === undefined) {
      if (rel !== '' && (await workspace.listDir(rel))) {
        throw new ToolError(`"${rel}" is a directory, not a file. Use list_dir to see its contents.`);
      }
      const similar = await suggestPaths(() => workspace.walk(), rel);
      throw new ToolError(
        `File not found: "${rel}".` +
          (similar.length ? ` Did you mean: ${similar.join(', ')}?` : ' Use list_dir or search_code to find the right path.'),
      );
    }
    if (looksBinary(text)) throw new ToolError(`"${rel}" looks like a binary file; read_file only supports text.`);

    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    if (total === 0) return `${rel} (empty file)`;

    const start = start_line ?? 1;
    if (start > total) throw new ToolError(`start_line ${start} is past the end of "${rel}" (${total} lines).`);
    let end = end_line ?? start + DEFAULT_MAX_LINES - 1;
    if (end < start) throw new ToolError(`end_line (${end}) must be >= start_line (${start}).`);
    const hardCap = start + DEFAULT_MAX_LINES * 5 - 1;
    if (end > hardCap) end = hardCap;
    end = Math.min(end, total);

    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(Math.max(width, 3))}| ${l.length > 2000 ? l.slice(0, 2000) + ' ...[line truncated]' : l}`)
      .join('\n');

    let header = `${rel} (lines ${start}-${end} of ${total})`;
    let footer = '';
    if (end < total) {
      footer = `\n[${total - end} more lines. Use start_line=${end + 1} to continue${end_line === undefined ? ` (default window is ${DEFAULT_MAX_LINES} lines)` : ''}.]`;
    } else if (start === 1) header = `${rel} (${total} lines)`;
    return `${header}\n${body}${footer}`;
  },
});
