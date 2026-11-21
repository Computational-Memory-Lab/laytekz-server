/**
 * Where a suggestion may appear, and the text around the caret a model
 * provider is given (WP40; the model itself is WP43). Suggestions appear only
 * in prose: never in math, comments, verbatim, the preamble, definitions, or
 * an argument that is a key, a label, a path, a URL or an environment name (a
 * made-up citation key would typeset silently).
 */
import type { EditorState, Text } from '@codemirror/state';
import { contextAt } from '../../editor/texContext';

/** Whether the caret at `pos` is in prose. False while the syntax tree is not ready. */
export function canSuggestAt(state: EditorState, pos: number): boolean {
  let ctx;
  try {
    ctx = contextAt(state, pos, { side: -1 });
  } catch {
    return false;
  }
  if (!ctx) return false;
  if (ctx.kind !== 'text' && ctx.kind !== 'table') return false;
  if (ctx.math || ctx.preamble) return false;
  if (ctx.arg && ctx.arg.kind !== 'text') return false;
  return true;
}

export interface PromptContext {
  /** Where the prefix starts: it moves rarely, so a model's prompt cache covers it. */
  start: number;
  prefix: string;
  suffix: string;
}

export const PREFIX_CHARS = 2000;
export const PREFIX_GRID = 1024;
export const SUFFIX_CHARS = 300;

/**
 * The prefix runs from a fixed start to the caret: the first line start at or
 * after `pos - 2000` rounded down to a 1,024-character grid, and never before
 * `\begin{document}`. The suffix runs from the caret to the end of the next
 * line, at most 300 characters.
 */
export function promptContext(doc: Text, pos: number): PromptContext {
  const grid = Math.floor(Math.max(0, pos - PREFIX_CHARS) / PREFIX_GRID) * PREFIX_GRID;
  const line = doc.lineAt(grid);
  let start = line.from === grid ? grid : Math.min(line.to + 1, pos);
  const head = doc.sliceString(start, pos);
  const body = head.lastIndexOf('\\begin{document}');
  if (body >= 0) start += body + '\\begin{document}'.length;
  const here = doc.lineAt(pos);
  const end = here.number < doc.lines ? doc.line(here.number + 1).to : here.to;
  return { start, prefix: doc.sliceString(start, pos), suffix: doc.sliceString(pos, Math.min(end, pos + SUFFIX_CHARS)) };
}
