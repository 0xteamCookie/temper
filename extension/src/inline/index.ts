// Inline edit: selection-scoped edits shown in place with per-hunk Accept/Reject CodeLens.
export { InlineDiffSession } from './inlineDiff';
export type { InlineDiffCallbacks, InlineDiffOptions } from './inlineDiff';
export { addToHistory, promptInstruction } from './instructionInput';
export type { HistoryStore, InstructionResult, PromptOptions } from './instructionInput';
export { registerInlineDiff, INLINE_ACTIVE_CONTEXT_KEY } from './inlineCommands';
export { INLINE_COMMANDS } from './lensModel';
export { layoutHunk, layoutHunks } from './hunkLayout';
