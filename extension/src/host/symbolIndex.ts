// Workspace symbol index for Symbol Check: a cheap def/class scan (the mcp find_symbol extractor).
import { SimpleSymbolIndex } from '../guards';
import { extractSymbols } from '../mcp';
import type { Workspace } from '../mcp';

const CODE_EXT = /\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|cs|rb|php|c|h|cc|cpp|hpp|swift|scala)$/i;
const MAX_FILES = 4000;
const MAX_FILE_CHARS = 1_000_000;

export async function collectSymbolNames(workspace: Workspace, maxFiles = MAX_FILES): Promise<Set<string>> {
  const names = new Set<string>();
  const files = (await workspace.walk()).filter((f) => CODE_EXT.test(f)).slice(0, maxFiles);
  let i = 0;
  const worker = async () => {
    while (i < files.length) {
      const f = files[i++]!;
      try {
        const text = await workspace.readFile(f);
        if (!text || text.length > MAX_FILE_CHARS) continue;
        for (const s of extractSymbols(f, text)) names.add(s.name);
      } catch {
        /* unreadable file */
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return names;
}

export async function buildSymbolIndex(workspace: Workspace): Promise<SimpleSymbolIndex> {
  return new SimpleSymbolIndex(await collectSymbolNames(workspace));
}

/** Names defined by files already staged in the changeset, so a later edit may use them. */
export function namesFromStaged(files: { path: string; proposed: string }[]): string[] {
  const out: string[] = [];
  for (const f of files) for (const s of extractSymbols(f.path, f.proposed)) out.push(s.name);
  return out;
}
