/**
 * What the highlighter's button, menus, card, list and commands do (WP37),
 * in one place, on top of WP32's data layer.
 */
import { EditorSelection, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Notify } from '../types';
import { HIGHLIGHTS_MAX, isColor, type Run } from './model';
import { flatten } from './paint';
import { applyHighlight, hlConfig, selectionRanges, toggleSelection, type WriteResult } from './extension';
import { chooseColor, currentColor, runAt, visibleRuns } from './query';
import { openCard } from './card';

export {
  setting, enabled, currentColor, chooseColor, bump, hlVersion, watchView, visibleRuns, runAt, selectionHasHighlight, ago,
} from './query';

// ---- Messages ----

export function say(notify: Notify, r: WriteResult | 'removed', what = 'highlight'): void {
  const text: Partial<Record<WriteResult, string>> = {
    off: 'Open a file in the code editor to highlight it.',
    readonly: 'This file cannot be highlighted: it is read-only or still loading.',
    empty: `Select some text to ${what} first.`,
    blank: 'Select some text, not just spaces, to highlight.',
    full: `This file has ${HIGHLIGHTS_MAX.toLocaleString('en')} highlights, the most it can hold. Remove some to add more.`,
  };
  const msg = text[r as WriteResult];
  if (msg) notify(msg, r === 'full' ? 'error' : 'info');
}

// ---- Writing ----

/** Paints the selection with `color` (never a toggle) and makes it the current colour. */
export function paintSelection(view: EditorView, color: string): WriteResult {
  const cfg = view.state.facet(hlConfig);
  if (!cfg) return 'off';
  if (!isColor(color)) return 'unchanged';
  const me = cfg.me();
  const r = applyHighlight(view, selectionRanges(view.state), { kind: 'paint', color, author: me.id, name: me.name, t: Date.now() });
  if (r === 'done' || r === 'unchanged') chooseColor(color);
  else say(cfg.notify, r);
  return r;
}

/** Paints one run's text with `color` (the card's swatches). */
export function recolorRun(view: EditorView, run: Pick<Run, 'from' | 'to'>, color: string): WriteResult {
  const cfg = view.state.facet(hlConfig);
  if (!cfg) return 'off';
  const me = cfg.me();
  const r = applyHighlight(view, [{ from: run.from, to: run.to }], { kind: 'paint', color, author: me.id, name: me.name, t: Date.now() });
  if (r === 'done') chooseColor(color);
  else say(cfg.notify, r);
  return r;
}

export function removeRun(view: EditorView, run: Pick<Run, 'from' | 'to'>): WriteResult {
  const cfg = view.state.facet(hlConfig);
  if (!cfg) return 'off';
  const r = applyHighlight(view, [{ from: run.from, to: run.to }], { kind: 'erase' });
  if (r !== 'done' && r !== 'unchanged') say(cfg.notify, r, 'remove highlights from');
  return r;
}

export function eraseSelection(view: EditorView): WriteResult {
  const cfg = view.state.facet(hlConfig);
  if (!cfg) return 'off';
  const r = applyHighlight(view, selectionRanges(view.state), { kind: 'erase' });
  if (r !== 'done' && r !== 'unchanged') say(cfg.notify, r, 'remove highlights from');
  return r;
}

/**
 * ⇧⌘H and the button: paints the selection with the current colour, or
 * removes it when the selection already shows exactly that colour. With no
 * selection and the caret in a highlight, opens its card.
 */
export function highlightOrCard(view: EditorView): WriteResult | 'removed' | 'card' {
  const cfg = view.state.facet(hlConfig);
  if (!cfg) return 'off';
  if (!selectionRanges(view.state).length) {
    const run = runAt(view.state, view.state.selection.main.head);
    if (run) { openCard(view, run.key); return 'card'; }
  }
  const r = toggleSelection(view, currentColor());
  say(cfg.notify, r);
  return r;
}

// ---- Moving ----

/** Selects a highlight's text and scrolls it into view. */
export function selectRun(view: EditorView, run: Pick<Run, 'from' | 'to'>, focus = true): void {
  const len = view.state.doc.length;
  const from = Math.min(run.from, len);
  const to = Math.min(run.to, len);
  view.dispatch({ selection: EditorSelection.single(from, to), effects: EditorView.scrollIntoView(from, { y: 'center' }) });
  if (focus) view.focus();
}

/** The next (dir 1) or previous (dir −1) highlight from the caret, wrapping; null when there is none. */
export function nextRun(state: EditorState, dir: 1 | -1): Run | null {
  const segs = flatten(visibleRuns(state));
  if (!segs.length) return null;
  const sel = state.selection.main;
  if (dir === 1) {
    const s = segs.find((x) => x.from > sel.from) ?? segs[0];
    return { ...s.run, from: s.from, to: s.to };
  }
  const before = segs.filter((x) => x.from < sel.from && !(x.from === sel.from && x.to === sel.to));
  const s = before[before.length - 1] ?? segs[segs.length - 1];
  return { ...s.run, from: s.from, to: s.to };
}

export function stepHighlight(view: EditorView, dir: 1 | -1): boolean {
  const run = nextRun(view.state, dir);
  if (!run) return false;
  selectRun(view, run);
  return true;
}
