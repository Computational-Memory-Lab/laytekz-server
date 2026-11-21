/**
 * Reading the highlighter's state for the interface (WP37): settings with
 * fallbacks, the current colour, the highlights a person sees, and a
 * version counter the React parts watch.
 */
import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getSetting } from '../../settings/store';
import type { Run } from './model';
import { flatten } from './paint';
import { hlConfig, highlightRuns, selectionRanges, shownRuns } from './extension';
import { lastColor, pickCurrent, rememberColor } from './colors';

/** A setting's value, or `fallback` when the store cannot answer (an isolated build, a test). */
export function setting<T>(id: string, fallback: T): T {
  try {
    const v = getSetting<T>(id);
    return v === undefined || v === null ? fallback : v;
  } catch { return fallback; }
}

export const enabled = () => setting<boolean>('highlighter.enabled', true) !== false;

/** The colour the button and ⇧⌘H paint with now. */
export function currentColor(): string {
  return pickCurrent(setting('highlighter.color', 'yellow'), setting<boolean>('highlighter.rememberLast', true) !== false, lastColor());
}

/** Makes `c` the current colour when "Remember the last colour" is on. */
export function chooseColor(c: string): void {
  if (setting<boolean>('highlighter.rememberLast', true) !== false) rememberColor(c);
  bump();
}

// ---- A version counter the React parts watch (selection, highlights, read-only state) ----

let version = 0;
const listeners = new Set<() => void>();
let queued = false;
export function bump(): void {
  if (queued) return;
  queued = true;
  const run = () => { queued = false; version++; for (const l of listeners) l(); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else queueMicrotask(run);
}
export const hlVersion = {
  subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
  get: () => version,
};

/** An update listener for the editor: anything the button or the list shows has changed. */
export const watchView = EditorView.updateListener.of((u) => {
  if (u.selectionSet || u.docChanged || u.focusChanged || u.startState.readOnly !== u.state.readOnly
    || highlightRuns(u.startState) !== highlightRuns(u.state)) bump();
});

/** The runs this person sees in the view. */
export function visibleRuns(state: EditorState): Run[] {
  const cfg = state.facet(hlConfig);
  if (!cfg) return [];
  return shownRuns(highlightRuns(state), cfg);
}

/** The highlight drawn at `pos` (the top one where they overlap), or null. A caret at either edge counts. */
export function runAt(state: EditorState, pos: number): Run | null {
  for (const s of flatten(visibleRuns(state))) {
    if (s.from <= pos && pos <= s.to) return s.run;
    if (s.from > pos) break;
  }
  return null;
}

/** Whether the selection touches a highlight this person sees. */
export function selectionHasHighlight(state: EditorState): boolean {
  const ranges = selectionRanges(state);
  if (!ranges.length) return false;
  const runs = visibleRuns(state);
  return ranges.some((r) => runs.some((x) => x.from < r.to && x.to > r.from));
}

/** "just now", "5 minutes ago", "3 days ago". */
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const units: Array<[number, string]> = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [2592000, 'month'], [31536000, 'year']];
  let pick = units[0];
  for (const u of units) if (s >= u[0]) pick = u;
  const n = Math.max(1, Math.round(s / pick[0]));
  return `${n} ${pick[1]}${n === 1 ? '' : 's'} ago`;
}
