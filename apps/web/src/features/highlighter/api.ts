/**
 * The highlighter's public surface (WP32), for WP37's interface and any
 * other feature: other features import the highlighter only through here.
 */
import { apiRequest } from '../../api';

export {
  HIGHLIGHTS_KEY, HL_ORIGIN, HIGHLIGHTS_MAX, PRESETS, isPreset, isHex, isColor, drawnColor, colorName, normalizeHex,
  readEntry, newKey, type Entry, type Run, type PresetId, type HighlightColor,
} from './model';
export { paint, flatten, isPainted, normalizeRanges, type PaintOp, type PaintResult, type Range } from './paint';
export {
  hlConfig, highlightField, highlightRuns, shownRuns, resolveRuns, repairUndoneAnchors, applyHighlight, toggleSelection,
  clearHighlights, selectionRanges, HL_REPAIR_ORIGIN, type HighlighterConfig, type WriteResult, type Strength,
} from './extension';

/** One highlight in GET /api/projects/:id/highlights. */
export interface ProjectHighlight {
  id: string;
  colour: string;
  author: string;
  authorId: string;
  t: number;
  from: number;
  to: number;
  /** 1-based line of `from`. */
  line: number;
  /** The first 80 characters of the highlighted text. */
  excerpt: string;
}
export interface ProjectHighlights { files: Array<{ path: string; highlights: ProjectHighlight[] }>; truncated: boolean }

/** Every highlight of a branch, by file (path order), newest first within a file. */
export function fetchProjectHighlights(projectId: string, branch: string): Promise<ProjectHighlights> {
  return apiRequest<ProjectHighlights>(`/api/projects/${encodeURIComponent(projectId)}/highlights?branch=${encodeURIComponent(branch)}`);
}
