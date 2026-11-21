/**
 * "Find references" seeds the project Search panel with a regular expression
 * (WP20). The page context's `showPanel('search', query)` carries only the
 * text, so the feature marks that text as a pattern here first and the panel
 * (components/SearchPanel.tsx) takes the mark when the seed arrives: it then
 * searches with the regex toggle on for that search only, never remembered.
 */

let pending: { pattern: string; at: number } | null = null;

/** A mark older than this belongs to some earlier request that never reached the panel. */
const MARK_MS = 5_000;

export function markRegexSeed(pattern: string): void {
  pending = { pattern, at: Date.now() };
}

/** True once when `seed` is the pattern marked last (and recently). */
export function takeRegexSeed(seed: string | undefined): boolean {
  const p = pending;
  if (!p || seed === undefined) return false;
  pending = null;
  return p.pattern === seed && Date.now() - p.at < MARK_MS;
}
