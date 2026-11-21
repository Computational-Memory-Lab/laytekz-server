/**
 * Undo for "Add and cite" (WP22). The \cite the panel inserts is an ordinary
 * local edit, so ⌘Z takes it back; the toast's Undo must find it again after
 * collaborators have typed around it. Each insertion the plugin host records
 * becomes a range that this field maps through every later change, local or
 * remote; Undo removes it only while its text is exactly what was inserted.
 */
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/** One contiguous edit: `removed` (the selection it replaced) became `inserted` at `from`. */
export interface Insertion { from: number; removed: string; inserted: string }

/** The single contiguous change that turns `before` into `after`, or null when they are equal. */
export function diffInsertion(before: string, after: string): Insertion | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  return { from: p, removed: before.slice(p, before.length - s), inserted: after.slice(p, after.length - s) };
}

interface Mark { id: number; from: number; to: number }

const track = StateEffect.define<Mark>();
const drop = StateEffect.define<number>();
/** At most this many insertions are remembered per editor state. */
const KEEP = 20;

/** Text typed right before the range stays outside it, and so does text typed right after. */
const mapMark = (m: Mark, map: (pos: number, assoc: number) => number): Mark => ({ id: m.id, from: map(m.from, 1), to: map(m.to, -1) });

export const citeMarks = StateField.define<readonly Mark[]>({
  create: () => [],
  update(marks, tr) {
    let next = tr.docChanged ? marks.map((m) => mapMark(m, (pos, assoc) => tr.changes.mapPos(pos, assoc))) : marks;
    for (const e of tr.effects) {
      if (e.is(track)) next = [...next.slice(-(KEEP - 1)), e.value];
      else if (e.is(drop)) next = next.filter((m) => m.id !== e.value);
    }
    return next;
  },
});

/** Installed by the references feature in every TeX editor (both modes). */
export function citeTrackExtension(): Extension {
  return citeMarks;
}

export interface TrackedInsertion extends Insertion {
  id: number;
  /** The file it was made in; Undo refuses anywhere else. */
  file: string | null;
  /** The field was installed when it was recorded, so its mapped range is authoritative. */
  tracked: boolean;
}

let nextId = 1;

/** Remember `ins`, just applied to `view`, so revertInsertion can find it again. */
export function trackInsertion(view: EditorView, file: string | null, ins: Insertion): TrackedInsertion {
  const id = nextId++;
  const tracked = view.state.field(citeMarks, false) !== undefined;
  if (tracked) view.dispatch({ effects: track.of({ id, from: ins.from, to: ins.from + ins.inserted.length }) });
  return { ...ins, id, file, tracked };
}

/** Where the insertion is now, or null when it is gone from this editor state. */
export function insertionRange(view: EditorView, t: TrackedInsertion): { from: number; to: number } | null {
  if (t.tracked) {
    const m = view.state.field(citeMarks, false)?.find((x) => x.id === t.id);
    if (!m || m.from > m.to) return null;
    return { from: m.from, to: m.to };
  }
  return { from: t.from, to: t.from + t.inserted.length };
}

/** Put back what the insertion replaced, while its text is unchanged. False when it moved away or was edited. */
export function revertInsertion(view: EditorView, t: TrackedInsertion): boolean {
  if (view.state.readOnly) return false;
  const r = insertionRange(view, t);
  if (!r || r.to > view.state.doc.length || view.state.sliceDoc(r.from, r.to) !== t.inserted) return false;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: t.removed },
    effects: t.tracked ? drop.of(t.id) : [],
    userEvent: 'delete',
  });
  return true;
}
