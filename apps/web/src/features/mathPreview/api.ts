/**
 * What other features may use of the formula preview (plan §2.2: a feature
 * imports another only through its api.ts).
 */
export { registerPreviewTier, previewTiers } from './tiers';
export type { PreviewTier, PreviewTierRequest, PreviewTierResult } from './tiers';
export { caretTarget, hoverTarget, katexInput, selectionTarget } from './target';
export type { PreviewTarget } from './target';
export { pinPreview, previewPinned } from './extension';
