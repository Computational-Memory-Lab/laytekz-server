import type { EditorView } from '@codemirror/view';
import type { PreviewTarget } from './target';

/**
 * Preview tiers: renderers better than KaTeX that may replace its drawing in
 * an open preview (WP21's crop of the typeset PDF). KaTeX always draws first;
 * then each registered tier is asked, highest priority first, and the first
 * one that returns a result replaces the KaTeX drawing in place. A tier that
 * returns null, throws or rejects leaves KaTeX's drawing as it is.
 */
export interface PreviewTierRequest {
  view: EditorView;
  /** The open file's project path. */
  filePath: string;
  target: PreviewTarget;
  /** CSS pixels per PDF point at the chosen preview size (KaTeX is drawn at the same scale). */
  pxPerPt: number;
  /** "As on paper" (white sheet, black ink) rather than the theme's colours. */
  paper: boolean;
  /** Aborted when the preview closes or moves to another formula. */
  signal: AbortSignal;
}

export interface PreviewTierResult {
  /** Goes to the preview's `data-tier` ('pdf'). */
  tier: string;
  dom: HTMLElement;
  /** Replaces the caption ("As typeset"). */
  caption?: string;
  /** The caption's tooltip (when that typeset ran). */
  title?: string;
}

export interface PreviewTier {
  id: string;
  priority: number;
  render(req: PreviewTierRequest): PreviewTierResult | null | Promise<PreviewTierResult | null>;
}

const tiers: PreviewTier[] = [];

/** Adds a tier; the returned function removes it. A second tier with the same id replaces the first. */
export function registerPreviewTier(t: PreviewTier): () => void {
  const at = tiers.findIndex((x) => x.id === t.id);
  if (at >= 0) tiers.splice(at, 1);
  tiers.push(t);
  tiers.sort((a, b) => b.priority - a.priority);
  return () => {
    const i = tiers.indexOf(t);
    if (i >= 0) tiers.splice(i, 1);
  };
}

/** The registered tiers, highest priority first. */
export function previewTiers(): readonly PreviewTier[] {
  return tiers;
}

/** The first tier result for `req`, or null; failures count as null. */
export async function bestTier(req: PreviewTierRequest): Promise<PreviewTierResult | null> {
  for (const t of [...tiers]) {
    if (req.signal.aborted) return null;
    try {
      const r = await t.render(req);
      if (r && !req.signal.aborted) return r;
    } catch {
      // a tier that fails leaves the KaTeX drawing
    }
  }
  return null;
}
