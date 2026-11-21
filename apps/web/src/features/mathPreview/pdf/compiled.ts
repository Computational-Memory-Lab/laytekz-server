import { ChangeSet, StateEffect, StateField, type EditorState, type Text } from '@codemirror/state';

/**
 * What the last typeset compiled, for the open file: the text it typeset and
 * every change made since (local, remote and agent edits alike, since all of
 * them reach the editor as transactions). Positions in the editor map back to
 * that text, so a formula provably untouched since the typeset can be found
 * in its SyncTeX records even after lines were added above it. Only effects:
 * nothing here changes the document or the undo history.
 */
export interface Snapshot {
  text: Text;
  /** From `text` to the document now. */
  changes: ChangeSet;
}

export interface Compiled extends Snapshot {
  compileId: number;
}

export interface CompiledState {
  /** Taken when this page asked for a typeset: the server flushes after that, so with no edit in between it is what ran. */
  request: Snapshot | null;
  /** Taken when a run's result arrived, until its hash is checked (by token). */
  pending: ReadonlyMap<number, Snapshot>;
  /** The text of the typeset whose PDF is shown, proven by the server's hash, or null. */
  compiled: Compiled | null;
}

export const takeRequestSnapshot = StateEffect.define<null>();
export const takeResultSnapshot = StateEffect.define<number>();
/** Settles a result snapshot: which snapshot the run's hash matched (`use`), or none. */
export const settleResult = StateEffect.define<{ token: number; compileId: number; use: 'result' | 'request' | null }>();

const fresh = (doc: Text): Snapshot => ({ text: doc, changes: ChangeSet.empty(doc.length) });
const NONE: CompiledState = { request: null, pending: new Map(), compiled: null };

export const compiledField = StateField.define<CompiledState>({
  create: () => NONE,
  update(value, tr) {
    let { request, pending, compiled } = value;
    let changed = false;
    if (tr.docChanged) {
      const step = <T extends Snapshot>(s: T): T => ({ ...s, changes: s.changes.compose(tr.changes) });
      if (request) request = step(request);
      if (compiled) compiled = step(compiled);
      if (pending.size) pending = new Map([...pending].map(([k, s]) => [k, step(s)] as const));
      changed = true;
    }
    for (const e of tr.effects) {
      if (e.is(takeRequestSnapshot)) {
        request = fresh(tr.state.doc);
        changed = true;
      } else if (e.is(takeResultSnapshot)) {
        pending = new Map(pending).set(e.value, fresh(tr.state.doc));
        changed = true;
      } else if (e.is(settleResult)) {
        const { token, compileId, use } = e.value;
        const snap = use === 'result' ? pending.get(token) : use === 'request' ? request : null;
        compiled = snap ? { text: snap.text, changes: snap.changes, compileId } : null;
        const rest = new Map(pending);
        rest.delete(token);
        pending = rest;
        if (use) request = null;
        changed = true;
      }
    }
    return changed ? { request, pending, compiled } : value;
  },
});

export type CompiledRange =
  | { kind: 'none' }
  | { kind: 'changed' }
  | {
      kind: 'ok';
      compileId: number;
      /** 1-based lines of the construct in the typeset text. */
      firstLine: number;
      lastLine: number;
      /** Something other than blanks or a comment shares the first or last line. */
      textBefore: boolean;
      textAfter: boolean;
    };

/**
 * Where the construct `from`…`to` (positions in the editor now) was in the
 * typeset text: 'changed' when any edit since the typeset reached inside it,
 * 'none' when no typeset text is known for this editor.
 */
export function compiledRange(state: EditorState, from: number, to: number): CompiledRange {
  const c = state.field(compiledField, false)?.compiled;
  if (!c) return { kind: 'none' };
  // current positions → typeset text
  const back = c.changes.invertedDesc;
  let touched = false;
  back.iterChangedRanges((fromA, toA) => {
    if (fromA < toA ? fromA < to && toA > from : fromA > from && fromA < to) touched = true;
  });
  if (touched) return { kind: 'changed' };
  const a = back.mapPos(from, 1), b = back.mapPos(to, -1);
  if (b <= a || c.text.sliceString(a, b) !== state.sliceDoc(from, to)) return { kind: 'changed' };
  const first = c.text.lineAt(a), last = c.text.lineAt(b);
  const after = last.text.slice(b - last.from).trim();
  return {
    kind: 'ok',
    compileId: c.compileId,
    firstLine: first.number,
    lastLine: last.number,
    textBefore: first.text.slice(0, a - first.from).trim() !== '',
    textAfter: after !== '' && !after.startsWith('%'),
  };
}

/**
 * The SyncTeX lines to look at for a display on `firstLine`…`lastLine`, or
 * null when the records cannot be told apart from the text around it. The
 * opening line is left out of a formula on several lines: the paragraph
 * before the display is broken there, and its last line is recorded on it;
 * the formula's own material is recorded on its body and closing lines.
 */
export function synctexLines(r: { firstLine: number; lastLine: number; textBefore: boolean; textAfter: boolean }): { first: number; last: number; single: boolean } | null {
  if (r.firstLine === r.lastLine) return r.textBefore || r.textAfter ? null : { first: r.firstLine, last: r.lastLine, single: true };
  const first = r.firstLine + 1;
  const last = r.textAfter ? r.lastLine - 1 : r.lastLine;
  return last < first ? null : { first, last, single: false };
}
