// ContextEngine: the facade the integrator wires up (index + retriever + packer + ledger).
import { WorkspaceIndex } from './indexer';
import type { IndexOptions, IndexStats } from './indexer';
import { LedgerStore } from './ledger';
import type { AgentRead } from './ledger';
import { pack, resolveBudget } from './packer';
import { Retriever } from './retriever';
import type { LedgerSnapshot } from '../shared/types';
import type { Mention, PackResult, RetrieveResult, Selection, WorkspaceReader } from './types';

export interface EngineBudget {
  /** 'adaptive' = budgetPercent of the model context window (clamped 4k..48k); 'fixed' = `tokens`. */
  mode: 'adaptive' | 'fixed';
  tokens?: number;
  percent: number;
}

export interface EngineOptions extends IndexOptions {
  ledger?: LedgerStore;
  budget?: Partial<EngineBudget>;
}

export interface AssembleRequest {
  task: string;
  runId: string;
  mentions?: Mention[];
  selection?: Selection;
  /** Overrides the engine budget for this call. */
  budgetTokens?: number;
  /** Selected model's context window, for the adaptive default. */
  contextLength?: number;
}

export interface AssembleResult extends PackResult {
  retrieval: RetrieveResult;
  budgetTokens: number;
}

export class ContextEngine {
  readonly index: WorkspaceIndex;
  readonly retriever: Retriever;
  readonly ledger: LedgerStore;
  private budget: EngineBudget;
  private built = false;

  constructor(reader: WorkspaceReader, opts: EngineOptions = {}) {
    this.index = new WorkspaceIndex(reader, opts);
    this.retriever = new Retriever(this.index);
    this.ledger = opts.ledger ?? new LedgerStore();
    this.budget = { mode: opts.budget?.mode ?? 'adaptive', percent: opts.budget?.percent ?? 25, ...(opts.budget?.tokens ? { tokens: opts.budget.tokens } : {}) };
  }

  /** Build the index (idempotent). */
  async init(): Promise<IndexStats> {
    const stats = await this.index.build();
    this.built = true;
    return stats;
  }

  async update(path: string): Promise<void> {
    if (!this.built) return;
    await this.index.update(path);
  }

  /** Ledger-panel slider: a fixed token budget, or undefined to return to the adaptive default. */
  setBudget(tokens: number | undefined, percent?: number): void {
    this.budget = {
      mode: tokens ? 'fixed' : 'adaptive',
      percent: percent ?? this.budget.percent,
      ...(tokens ? { tokens } : {}),
    };
  }

  getBudget(contextLength?: number): { mode: EngineBudget['mode']; tokens: number } {
    return {
      mode: this.budget.mode,
      tokens: resolveBudget({ ...(this.budget.mode === 'fixed' && this.budget.tokens ? { budgetTokens: this.budget.tokens } : {}), ...(contextLength ? { contextLength } : {}), budgetPercent: this.budget.percent }),
    };
  }

  async assemble(req: AssembleRequest): Promise<AssembleResult> {
    if (!this.built) await this.init();
    const state = this.ledger.retrievalState();
    const retrieval = this.retriever.retrieve(req.task, {
      mentions: req.mentions ?? [],
      ...(req.selection ? { selection: req.selection } : {}),
      pinned: state.pinned,
      evicted: state.evicted,
    });
    const budgetTokens = req.budgetTokens ?? this.getBudget(req.contextLength).tokens;
    const packed = pack(this.index, retrieval.candidates, {
      runId: req.runId,
      task: req.task,
      budgetTokens,
      queryTerms: retrieval.queryTerms,
      notes: retrieval.notes,
    });
    const snapshot: LedgerSnapshot = this.ledger.record(packed.snapshot);
    return { text: packed.text, snapshot, retrieval, budgetTokens };
  }

  /** Called by the tool layer when the agent reads a file itself. */
  noteAgentRead(runId: string, read: AgentRead): void {
    this.ledger.recordAgentRead(runId, read);
  }
}
