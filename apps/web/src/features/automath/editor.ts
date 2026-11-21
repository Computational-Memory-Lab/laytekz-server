/**
 * Automatic math mode's keys and completion (WP11): Tab leaves inline math,
 * and the completion list ranks math commands first inside math and lists
 * each label once.
 */
import type { EditorView } from '@codemirror/view';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { contextAt } from '../../editor/texContext';
import { GREEK_LETTERS, MATH_ONLY_COMMANDS, MATH_OPERATOR_NAMES } from '../../latex/vocab';
import { autoMathConfig } from './rules';

const CLOSERS: Readonly<Record<string, string>> = { '$': '$', '$$': '$$', '\\(': '\\)', '\\[': '\\]' };

/** Tab with the caret right before the closing delimiter of the formula it is in: moves past it. */
export function tabOutOfMath(view: Pick<EditorView, 'state' | 'dispatch'>): boolean {
  const state = view.state;
  if (!state.facet(autoMathConfig).tabOut) return false;
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return false;
  const pos = sel.main.head;
  const ctx = contextAt(state, pos);
  if (!ctx || ctx.kind !== 'math' || !ctx.math || ctx.math.delim === 'env') return false;
  const closer = CLOSERS[ctx.math.delim];
  if (!closer || state.sliceDoc(pos, pos + closer.length) !== closer) return false;
  if (closer === '$' && (state.sliceDoc(pos - 1, pos) === '\\' || state.sliceDoc(pos + 1, pos + 2) === '$')) return false;
  view.dispatch({ selection: { anchor: pos + closer.length }, scrollIntoView: true, userEvent: 'select' });
  return true;
}

const MATH_LABELS: ReadonlySet<string> = new Set([...GREEK_LETTERS, ...MATH_ONLY_COMMANDS, ...MATH_OPERATOR_NAMES].map((n) => `\\${n}`));
const MATH_BOOST = 2;

/** Each label once; inside math, math commands ranked first. */
export function mathCompletionFilter(r: CompletionResult, cx: CompletionContext): CompletionResult {
  const seen = new Set<string>();
  let dupes = false;
  for (const o of r.options) {
    if (seen.has(o.label)) { dupes = true; break; }
    seen.add(o.label);
  }
  let options: readonly Completion[] = r.options;
  if (dupes) {
    const once = new Set<string>();
    options = options.filter((o) => (once.has(o.label) ? false : (once.add(o.label), true)));
  }
  if (options.some((o) => MATH_LABELS.has(o.label))) {
    const ctx = contextAt(cx.state, cx.pos);
    if (ctx?.kind === 'math') options = options.map((o) => (MATH_LABELS.has(o.label) ? { ...o, boost: (o.boost ?? 0) + MATH_BOOST } : o));
  }
  return options === r.options ? r : { ...r, options };
}
