// In-memory changeset overlay: staged edits, hunks, apply via a FileSystemPort,
// checkpoints and undo. Nothing is written to disk before the user accepts.
export * from './changeset'
export * from './fsPort'
export { replace, missHint, detectEol } from './fuzzyEdit'
export type { ReplaceResult } from './fuzzyEdit'
