import { z } from 'zod';
import { defineTool, ToolError } from '../tool';
import { looksBinary } from '../util';

export type SymbolKind = 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type' | 'enum';

export interface SymbolDef {
  path: string;
  line: number;
  kind: SymbolKind;
  name: string;
  signature: string;
  container?: string;
}

const MAX_DEFS = 25;
const MAX_REFS = 15;
const MAX_FILE_CHARS = 1_000_000;
const CODE_EXT = /\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|cs|rb|php|c|h|cc|cpp|hpp|swift|scala)$/i;
const TS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'super', 'with', 'else', 'do']);

function clip(s: string, n = 140): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n) + '...' : t;
}

/** Signature text starting at `name(` on line i, joined across up to 4 lines until the closing paren. */
function signatureFrom(lines: string[], i: number, startCol: number): string {
  let s = lines[i]!.slice(startCol);
  let depth = 0;
  let k = i;
  for (;;) {
    for (const c of s) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    if (depth <= 0 || k - i >= 4 || k + 1 >= lines.length) break;
    k++;
    s += ' ' + lines[k]!.trim();
  }
  return clip(s.replace(/\s+/g, ' ').replace(/\s*[{:]\s*$/, ''));
}

/** Extract all definitions in a file (any name). `want` is a quick pre-filter on the file text. */
export function extractSymbols(path: string, text: string, want?: string): SymbolDef[] {
  if (want && !text.includes(want)) return [];
  const lines = text.split(/\r?\n/);
  const out: SymbolDef[] = [];
  const add = (line: number, kind: SymbolKind, name: string, signature: string, container?: string): void => {
    out.push({ path, line, kind, name, signature, container });
  };
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();

  if (ext === 'py' || ext === 'pyi') {
    const classStack: Array<{ indent: number; name: string }> = [];
    const defStack: number[] = []; // indents of enclosing defs (locals inside functions are skipped)
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (!l.trim() || l.trim().startsWith('#')) continue;
      const indent = l.length - l.trimStart().length;
      while (classStack.length && indent <= classStack[classStack.length - 1]!.indent) classStack.pop();
      while (defStack.length && indent <= defStack[defStack.length - 1]!) defStack.pop();
      let m = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(l);
      if (m) {
        const cls = classStack[classStack.length - 1];
        const col = l.indexOf(m[2]!);
        const sig = signatureFrom(lines, i, col);
        const ret = /\)\s*(->\s*[^:]+)?:/.exec(lines[i]!.slice(col));
        if (!defStack.length || cls) add(i + 1, cls && indent > cls.indent ? 'method' : 'function', m[2]!, sig + (ret?.[1] && !sig.includes('->') ? ' ' + ret[1].trim() : ''), cls?.name);
        defStack.push(indent);
        continue;
      }
      m = /^(\s*)class\s+([A-Za-z_]\w*)\s*(\([^)]*\))?/.exec(l);
      if (m) {
        add(i + 1, 'class', m[2]!, `class ${m[2]}${m[3] ?? ''}`, classStack[classStack.length - 1]?.name);
        classStack.push({ indent, name: m[2]! });
        continue;
      }
      if (!defStack.length) {
        m = /^(\s*)([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*=(?!=)\s*(.*)$/.exec(l);
        if (m && (indent === 0 || classStack.length)) {
          add(i + 1, 'variable', m[2]!, clip(`${m[2]}${m[3] ? ': ' + m[3] : ''} = ${m[4]}`), classStack[classStack.length - 1]?.name);
        }
      }
    }
    return out;
  }

  if (/^(ts|tsx|js|jsx|mjs|cjs)$/.test(ext)) {
    let classIndent = -1;
    let className = '';
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const indent = l.length - l.trimStart().length;
      if (classIndent >= 0 && indent <= classIndent && l.trim().startsWith('}')) classIndent = -1;
      let m = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(l);
      if (m) {
        add(i + 1, 'class', m[1]!, clip(l.replace(/\s*\{.*$/, '')));
        classIndent = indent;
        className = m[1]!;
        continue;
      }
      m = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(l);
      if (m) {
        add(i + 1, 'function', m[1]!, signatureFrom(lines, i, l.indexOf(m[1]!)));
        continue;
      }
      m = /^\s*(?:export\s+)?(?:declare\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(l);
      if (m) {
        add(i + 1, m[1] === 'enum' ? 'enum' : m[1] === 'type' ? 'type' : 'interface', m[2]!, clip(l.replace(/\s*\{.*$/, '')));
        continue;
      }
      m = /^\s*(?:export\s+)?(?:declare\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/.exec(l);
      if (m && indent === 0) {
        const isFn = /^(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/.test(m[3]!);
        add(i + 1, isFn ? 'function' : 'variable', m[2]!, clip(`${m[1]} ${m[2]} = ${m[3]}`));
        continue;
      }
      if (classIndent >= 0 && indent > classIndent) {
        m = /^\s*(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\s*\(/.exec(l);
        if (m && !TS_KEYWORDS.has(m[1]!) && /[{;]\s*$|\)\s*(?::[^;{]+)?\s*\{?\s*$/.test(l) && !/^\s*(?:return|await|new|throw)\b/.test(l) && indent === classIndent + (lines[i]!.match(/^\s*/)![0].includes('\t') ? 1 : 2)) {
          add(i + 1, 'method', m[1]!, signatureFrom(lines, i, l.indexOf(m[1]!)), className);
        }
      }
    }
    return out;
  }

  // Generic fallback (go, rust, java, ...)
  const re = /\b(func|fn|def|function|class|struct|interface|trait|enum|type|impl|object|module)\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w$]*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const kw = m[1]!;
    const kind: SymbolKind = kw === 'class' || kw === 'struct' || kw === 'impl' || kw === 'object' ? 'class' : kw === 'interface' || kw === 'trait' ? 'interface' : kw === 'enum' ? 'enum' : kw === 'type' ? 'type' : 'function';
    add(i + 1, kind, m[2]!, clip(lines[i]!.replace(/\s*\{.*$/, '')));
  }
  return out;
}

export const findSymbolTool = defineTool({
  name: 'find_symbol',
  description:
    'Find where a function, class, method, interface, type or module-level variable is DEFINED, plus a few references. ' +
    'Faster and more precise than search_code for "where is X defined". Exact, case-sensitive name (e.g. "get_debug_flag", "Flask", "UserService"); ' +
    'use "Class.method" to prefer a method of that class. Supports Python, TypeScript/JavaScript and (roughly) Go, Rust, Java and similar. ' +
    'Output: "path:line kind name(signature)" per definition, then "path:line: code" references. ' +
    'If nothing is found the name may be misspelled or dynamic: try search_code with a partial name.',
  inputSchema: z.object({
    name: z.string().min(1).describe('Symbol name, e.g. "get_debug_flag" or "Flask.run"'),
    kind: z.enum(['function', 'class', 'method', 'variable', 'interface', 'type', 'enum']).optional().describe('Restrict to one kind of definition'),
    max_references: z.number().int().min(0).max(50).optional().describe(`Maximum references to list (default ${MAX_REFS}; 0 = definitions only)`),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler({ name, kind, max_references }, { workspace, signal }) {
    const [maybeCls, last] = name.includes('.') ? [name.slice(0, name.lastIndexOf('.')), name.slice(name.lastIndexOf('.') + 1)] : [undefined, name];
    const sym = last!.trim();
    if (!/^[A-Za-z_$#][\w$]*$/.test(sym)) throw new ToolError(`"${name}" is not a valid identifier. Pass a plain symbol name like "get_user".`);
    const clsHint = maybeCls?.split('.').pop();
    const refLimit = max_references ?? MAX_REFS;
    const files = (await workspace.walk()).filter((f) => CODE_EXT.test(f));
    const wordRe = new RegExp(`(?<![\\w$])${sym.replace(/\$/g, '\\$')}(?![\\w$])`);

    const defs: SymbolDef[] = [];
    const refs: Array<{ path: string; line: number; text: string }> = [];
    let moreRefs = false;
    const BATCH = 32;
    for (let i = 0; i < files.length; i += BATCH) {
      if (signal?.aborted) throw new ToolError('Search cancelled.');
      const batch = files.slice(i, i + BATCH);
      const texts = await Promise.all(batch.map((f) => workspace.readFile(f)));
      batch.forEach((f, j) => {
        const text = texts[j];
        if (text === undefined || text.length > MAX_FILE_CHARS || !text.includes(sym) || looksBinary(text)) return;
        const found = extractSymbols(f, text, sym).filter((d) => d.name === sym && (!kind || d.kind === kind));
        defs.push(...found);
        if (refLimit === 0) return;
        const defLines = new Set(found.map((d) => d.line));
        const lines = text.split('\n');
        for (let k = 0; k < lines.length; k++) {
          if (defLines.has(k + 1) || !wordRe.test(lines[k]!)) continue;
          if (refs.length >= refLimit) {
            moreRefs = true;
            return;
          }
          refs.push({ path: f, line: k + 1, text: clip(lines[k]!, 160) });
        }
      });
    }

    const isTest = (p: string): number => (/(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.|(^|\/)test_/.test(p) ? 1 : 0);
    defs.sort((a, b) => {
      const ca = clsHint && a.container === clsHint ? 0 : 1;
      const cb = clsHint && b.container === clsHint ? 0 : 1;
      return ca - cb || isTest(a.path) - isTest(b.path) || a.path.localeCompare(b.path) || a.line - b.line;
    });
    refs.sort((a, b) => isTest(a.path) - isTest(b.path) || a.path.localeCompare(b.path) || a.line - b.line);

    if (!defs.length && !refs.length) {
      return `No symbol named "${sym}"${kind ? ` of kind ${kind}` : ''} found. Check spelling, or try search_code with a partial name (set regex=true for patterns).`;
    }
    const out: string[] = [];
    if (defs.length) {
      out.push(`Definitions of ${sym} (${defs.length}):`);
      for (const d of defs.slice(0, MAX_DEFS)) {
        const sig = d.container && d.signature.startsWith(d.name) ? `${d.container}.${d.signature}` : d.signature;
        out.push(`${d.path}:${d.line} ${d.kind} ${sig}`);
      }
      if (defs.length > MAX_DEFS) out.push(`... ${defs.length - MAX_DEFS} more definitions; add kind or use Class.name to narrow.`);
    } else {
      out.push(`No definition of "${sym}" found in the workspace (it may come from a dependency). References:`);
    }
    if (refs.length) {
      out.push('', `References (${refs.length}${moreRefs ? '+' : ''}):`);
      for (const r of refs) out.push(`${r.path}:${r.line}: ${r.text}`);
      if (moreRefs) out.push(`[more references omitted; use search_code query="${sym}" with a glob to see them.]`);
    }
    return out.join('\n');
  },
});
