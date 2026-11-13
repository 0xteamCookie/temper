// Multi-file review of a changeset: virtual-document diffs + decisions mirrored with the editor.
export { ReviewController } from './reviewController';
export type { ReviewHandlers, ReviewControllerOptions } from './reviewController';
export {
  ProposedContentProvider,
  proposedContent,
  registerReviewProviders,
  PROPOSED_SCHEME,
  ORIGINAL_SCHEME,
} from './proposedContentProvider';
export { applyAcceptedToDocument } from './applyEdit';
export { applyHunks, effectiveContent, contentForDecisions } from './effectiveContent';
