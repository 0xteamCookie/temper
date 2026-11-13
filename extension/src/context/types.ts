// Internal types of the context engine. Vscode-free so everything runs in plain Node (and vitest).
import type { LedgerSnapshot, PickReason } from '../shared/types';

/** Injectable view of the workspace. Paths are workspace-relative with forward slashes. */
export interface WorkspaceReader {
  /** Absolute workspace root (informational). */
  root: string;
  /** All candidate files, honoring `excludes` (directory names or `*.ext` / exact file name patterns). */
  listFiles(excludes: string[]): Promise<string[]>;
  /** File contents, or undefined if missing / unreadable / binary / too large. */
  readFile(rel: string): Promise<string | undefined>;
}

export type SymbolKind =
  | 'class'
  | 'function'
  | 'method'
  | 'variable'
  | 'interface'
  | 'type'
  | 'enum'
  | 'heading';

export interface SymbolDef {
  name: string;
  kind: SymbolKind;
  path: string;
  /** 1-based line of the definition keyword itself. */
  line: number;
  /** 1-based first line including decorators. */
  startLine: number;
  /** 1-based inclusive end line. */
  endLine: number;
  /** One-line signature, e.g. `def run(self, a, b=1) -> int`. */
  signature: string;
  /** First line of docstring / JSDoc. */
  doc?: string;
  /** Enclosing class name for methods. */
  parent?: string;
  /** First decorator, trimmed (e.g. `@click.command("routes")`). */
  decorator?: string;
}

/**
 * Pluggable symbol provider. The integrator can add an LSP-backed source; return undefined to let
 * the next source (finally the built-in regex/indent extractor) handle the file.
 */
export interface SymbolSource {
  readonly name: string;
  symbols(path: string, content: string): SymbolDef[] | undefined | Promise<SymbolDef[] | undefined>;
}

export type Lang = 'python' | 'ts' | 'doc' | 'generic' | 'text';
export type FileRole = 'source' | 'test' | 'doc' | 'config' | 'other';

export interface Chunk {
  /** `${path}#${startLine}` */
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Display symbol, e.g. `FlaskGroup` or `FlaskGroup.get_command` or a doc section title. */
  symbol?: string;
  kind: 'function' | 'class' | 'method' | 'section' | 'window';
}

export interface Mention {
  kind: 'file' | 'symbol';
  value: string;
}

export interface Selection {
  path: string;
  startLine: number;
  endLine: number;
}

export interface RetrieveContext {
  mentions: Mention[];
  selection?: Selection;
  /** Pinned ledger ids (`path` or `path#symbol`). */
  pinned: string[];
  /** Evicted ledger ids (`path` or `path#symbol`); a bare path evicts everything in that file. */
  evicted: string[];
}

export interface Reason {
  reason: PickReason;
  detail: string;
}

export interface Candidate {
  id: string;
  path: string;
  symbol?: string;
  startLine: number;
  endLine: number;
  /** True when the candidate stands for the whole file. */
  wholeFile: boolean;
  score: number;
  reasons: Reason[];
  /** mention / selection / pinned: must be included, whatever the budget. */
  mandatory: boolean;
  evicted?: boolean;
  pinned?: boolean;
}

export interface RetrieveResult {
  candidates: Candidate[];
  queryTerms: string[];
  notes: string[];
  ms: number;
}

export interface PackResult {
  text: string;
  snapshot: LedgerSnapshot;
}
