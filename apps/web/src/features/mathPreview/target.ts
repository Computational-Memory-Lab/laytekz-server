import type { EditorState } from '@codemirror/state';
import { contextAt, formulaAt } from '../../editor/texContext';
import type { Formula } from '../../editor/texContext/types';

/**
 * What a formula preview draws, found from the source alone. Pure functions
 * over an EditorState: nothing here touches the document or the DOM.
 */
export interface PreviewTarget {
  /** The construct (or selection) the preview is for: hovering inside it keeps the preview open. */
  from: number;
  to: number;
  /** What KaTeX gets, with \label, \nonumber and \notag taken out. */
  source: string;
  display: boolean;
  kind: Formula['kind'] | 'selection';
  env?: string;
  /** Over the size limit: no KaTeX render, only a sentence. */
  tooLong: boolean;
}

/** Past these, KaTeX would take long and the tooltip could not show it anyway. */
export const MAX_SOURCE_CHARS = 8000;
export const MAX_SOURCE_LINES = 150;

/** Environments KaTeX draws itself (by base name, a trailing * dropped). */
const AS_WRITTEN = new Set([
  'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix', 'cases', 'dcases', 'rcases', 'drcases',
  'array', 'darray', 'subarray', 'CD', 'aligned', 'gathered', 'alignedat',
]);
/** Numbered displays KaTeX knows, drawn in their starred form so no made-up "(1)" appears. */
const STARRED = new Set(['align', 'gather']);
/** One centred line after another. */
const GATHERED = new Set(['multline', 'gather']);

const INVISIBLE = /\\(?:label\s*\{[^{}]*\}|nonumber(?![A-Za-z])|notag(?![A-Za-z]))/g;

/** `source` without what a typeset page never shows (labels, \nonumber). */
export function cleanSource(source: string): string {
  return source.replace(INVISIBLE, '');
}

/** What KaTeX should draw for a formula, and in which mode. */
export function katexInput(f: Pick<Formula, 'source' | 'display' | 'kind' | 'env'>): { source: string; display: boolean } {
  const body = cleanSource(f.source);
  if (f.kind !== 'env' || !f.env) return { source: body.trim(), display: f.display };
  if (!f.display) return { source: body.trim(), display: false }; // \begin{math}
  const base = f.env.replace(/\*$/, '');
  if (base === 'equation' || base === 'displaymath') return { source: body.trim(), display: true };
  if (AS_WRITTEN.has(base)) return { source: `\\begin{${f.env}}${body}\\end{${f.env}}`, display: true };
  if (STARRED.has(base)) return { source: `\\begin{${base}*}${body}\\end{${base}*}`, display: true };
  if (base === 'alignat' && /^\s*\{\s*\d+\s*\}/.test(body)) return { source: `\\begin{alignat*}${body}\\end{alignat*}`, display: true };
  const wrap = GATHERED.has(base) ? 'gathered' : 'aligned';
  return { source: `\\begin{${wrap}}${body}\\end{${wrap}}`, display: true };
}

function tooLong(source: string): boolean {
  if (source.length > MAX_SOURCE_CHARS) return true;
  let lines = 1;
  for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) if (++lines > MAX_SOURCE_LINES) return true;
  return false;
}

function fromFormula(f: Formula): PreviewTarget {
  const k = katexInput(f);
  return { from: f.from, to: f.to, source: k.source, display: k.display, kind: f.kind, env: f.env, tooLong: tooLong(f.source) };
}

/** Comments and verbatim text never preview, whatever the parser made of a `$` in them. */
function previewable(state: EditorState, f: Formula): boolean {
  const c = contextAt(state, Math.min(f.innerFrom, state.doc.length), { side: 1 });
  return !c || (c.kind !== 'comment' && c.kind !== 'verbatim');
}

/**
 * The formula under the pointer: the outermost closed math construct holding
 * the character on the hovered side of `pos`. A non-empty selection that the
 * pointer is in, and that lies inside one formula, previews on its own, in
 * that formula's mode.
 */
export function hoverTarget(state: EditorState, pos: number, side: -1 | 1 = 1): PreviewTarget | null {
  const sel = state.selection.main;
  if (!sel.empty && pos >= sel.from && pos <= sel.to) {
    const t = selectionTarget(state);
    if (t) return t;
  }
  const at = side < 0 ? pos : Math.min(pos + 1, state.doc.length);
  const f = formulaAt(state, at);
  if (!f || f.to <= f.from) return null;
  // the pointer must be over the construct itself, not just touching its edge from outside
  const ch = side < 0 ? pos - 1 : pos;
  if (ch < f.from || ch >= f.to) return null;
  return previewable(state, f) ? fromFormula(f) : null;
}

/** The formula the caret is in (or right after), for the caret preview and the pinned one. */
export function caretTarget(state: EditorState): PreviewTarget | null {
  const sel = state.selection.main;
  if (!sel.empty) return selectionTarget(state);
  const f = formulaAt(state, sel.head);
  return f && previewable(state, f) ? fromFormula(f) : null;
}

/** A selection inside one formula's body, drawn as a formula of that mode. */
export function selectionTarget(state: EditorState): PreviewTarget | null {
  const sel = state.selection.main;
  if (sel.empty) return null;
  const f = formulaAt(state, sel.from + 1);
  if (!f || sel.from < f.innerFrom || sel.to > f.innerTo || !previewable(state, f)) return null;
  const text = cleanSource(state.sliceDoc(sel.from, sel.to)).trim();
  if (!text) return null;
  // a piece of an aligned display keeps its & and \\ legal
  const source = f.display && /&|\\\\/.test(text) ? `\\begin{aligned}${text}\\end{aligned}` : text;
  return { from: sel.from, to: sel.to, source, display: f.display, kind: 'selection', env: f.env, tooLong: tooLong(text) };
}

/** Same construct, same text: an open preview need not be redrawn. */
export function sameTarget(a: PreviewTarget | null, b: PreviewTarget | null): boolean {
  if (a === b) return true;
  return !!a && !!b && a.from === b.from && a.to === b.to && a.source === b.source && a.display === b.display;
}
