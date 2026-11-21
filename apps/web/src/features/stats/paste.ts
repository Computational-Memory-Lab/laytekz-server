import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { statsEdit } from '../../editor/core/autoEdit';
import { looksLikeTestOutput } from './core/parse';
import { statsConfig } from './config';
import { convertRange } from './insert';
import { clearOffer, showOffer } from './ui';

/**
 * The paste offer (feature 16): when pasted text looks like R or Python test
 * output, Laytekz offers to convert it to the house style. Nothing changes
 * unless the person clicks Convert; the pasted range is tracked through later
 * edits, and Undo after converting brings the paste back.
 */

const MAX_PASTE = 20000;

const dropOffer = StateEffect.define<null>();

/** The range the last paste inserted, while an offer for it may be on screen. */
export const pastedRange = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(range, tr) {
    for (const e of tr.effects) if (e.is(dropOffer)) return null;
    if (tr.isUserEvent('input.paste') && !tr.annotation(statsEdit)) {
      let from = Infinity, to = -Infinity;
      tr.changes.iterChanges((_fA, _tA, fB, tB) => { from = Math.min(from, fB); to = Math.max(to, tB); });
      return to > from ? { from, to } : null;
    }
    if (!range || !tr.docChanged) return range;
    const from = tr.changes.mapPos(range.from, 1), to = tr.changes.mapPos(range.to, -1);
    return to > from ? { from, to } : null;
  },
});

/** The text of the tracked paste, when it reads as program output. */
export function offerText(state: EditorState): string | null {
  const r = state.field(pastedRange, false);
  if (!r || r.to - r.from > MAX_PASTE) return null;
  const text = state.sliceDoc(r.from, r.to);
  return looksLikeTestOutput(text) ? text : null;
}

/** Converts the tracked paste; returns how many blocks changed (0 when it is gone or nothing matched). */
export function convertPasted(view: EditorView): number {
  const r = view.state.field(pastedRange, false);
  if (!r) return 0;
  const n = convertRange(view, r);
  view.dispatch({ effects: dropOffer.of(null), annotations: statsEdit.of(true) });
  return n;
}

export function dismissPaste(view: EditorView): void {
  if (view.state.field(pastedRange, false)) view.dispatch({ effects: dropOffer.of(null), annotations: statsEdit.of(true) });
}

const pasteWatcher = EditorView.updateListener.of((u) => {
  const pasted = u.transactions.some((tr) => tr.isUserEvent('input.paste') && !tr.annotation(statsEdit));
  if (pasted) {
    if (u.state.facet(statsConfig).paste && !u.state.readOnly && offerText(u.state) !== null) showOffer(u.view);
    else clearOffer(u.view);
    return;
  }
  if (!u.state.field(pastedRange, false) && u.startState.field(pastedRange, false)) clearOffer(u.view);
});

/** An offer never outlives its editor (another file opened, the page left). */
const offerOwner = ViewPlugin.define((view) => ({ destroy: () => clearOffer(view) }));

export function pasteExtension(): Extension {
  return [pastedRange, pasteWatcher, offerOwner];
}
