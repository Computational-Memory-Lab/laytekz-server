import { describe, expect, it } from 'vitest';
import { EditorSelection } from '@codemirror/state';
import { headlessView } from '../../../editor/core/__tests__/replay';
import { citationEdit } from '../../../editor/citeInsert';
import { citeTrackExtension, diffInsertion, insertionRange, revertInsertion, trackInsertion } from '../citeTrack';

/** Cite `key` the way CodePane.insertCitation does, and record it the way the plugin host does. */
function citeAndTrack(doc: string, cursor: number, key: string, o: { track?: boolean; selTo?: number } = {}) {
  const v = headlessView({ doc, selection: EditorSelection.single(cursor, o.selTo ?? cursor), extensions: o.track === false ? [] : [citeTrackExtension()] });
  const view = v.asView();
  const before = v.state.doc.toString();
  const sel = v.state.selection.main;
  const edit = citationEdit(before, sel.from, key, sel.to);
  if (edit.kind !== 'present') v.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: { anchor: edit.cursor }, userEvent: 'input' });
  const ins = diffInsertion(before, v.state.doc.toString());
  return { v, view, before, t: ins ? trackInsertion(view, 'main.tex', ins) : null };
}

describe('diffInsertion', () => {
  it('finds a pure insertion, a replacement and nothing', () => {
    expect(diffInsertion('see .', 'see \\cite{a}.')).toEqual({ from: 4, removed: '', inserted: '\\cite{a}' });
    expect(diffInsertion('see XY.', 'see \\cite{a}.')).toEqual({ from: 4, removed: 'XY', inserted: '\\cite{a}' });
    expect(diffInsertion('same', 'same')).toBeNull();
  });
  it('turns the after text back into the before text', () => {
    const before = '\\cite{a,b} and \\cite{a}';
    const after = '\\cite{a,b} and \\cite{a,b}';
    const d = diffInsertion(before, after)!;
    expect(after.slice(0, d.from) + d.removed + after.slice(d.from + d.inserted.length)).toBe(before);
  });
});

describe('Undo of the panel citation', () => {
  it('removes a new \\cite in one change', () => {
    const { v, view, before, t } = citeAndTrack('As shown by .', 12, 'vaswani2017');
    expect(v.state.doc.toString()).toBe('As shown by \\cite{vaswani2017}.');
    expect(revertInsertion(view, t!)).toBe(true);
    expect(v.state.doc.toString()).toBe(before);
  });

  it('removes only the key it added to an existing citation', () => {
    const doc = 'See \\cite{lamport1994}.';
    const { v, view, t } = citeAndTrack(doc, 21, 'knuth1984');
    expect(v.state.doc.toString()).toBe('See \\cite{lamport1994,knuth1984}.');
    expect(revertInsertion(view, t!)).toBe(true);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it('follows text a collaborator typed before it', () => {
    const { v, view, t } = citeAndTrack('Intro.\nAs shown by .', 19, 'a2020');
    v.dispatch({ changes: { from: 0, insert: 'Remote line.\n' } });
    expect(insertionRange(view, t!)).toEqual({ from: 32, to: 32 + '\\cite{a2020}'.length });
    expect(revertInsertion(view, t!)).toBe(true);
    expect(v.state.doc.toString()).toBe('Remote line.\nIntro.\nAs shown by .');
  });

  it('refuses once the citation was edited, and leaves the text alone', () => {
    const { v, view, t } = citeAndTrack('As shown by .', 12, 'a2020');
    v.dispatch({ changes: { from: 18, insert: 'x' } });
    const now = v.state.doc.toString();
    expect(revertInsertion(view, t!)).toBe(false);
    expect(v.state.doc.toString()).toBe(now);
  });

  it('puts a replaced selection back', () => {
    const { v, view, t } = citeAndTrack('See [ref] here.', 4, 'k2001', { selTo: 9 });
    expect(v.state.doc.toString()).toBe('See \\cite{k2001} here.');
    expect(revertInsertion(view, t!)).toBe(true);
    expect(v.state.doc.toString()).toBe('See [ref] here.');
  });

  it('without the tracking field it still reverts in place, but only while unmoved', () => {
    const { v, view, t } = citeAndTrack('As shown by .', 12, 'a2020', { track: false });
    expect(t!.tracked).toBe(false);
    v.dispatch({ changes: { from: 0, insert: 'X' } });
    expect(revertInsertion(view, t!)).toBe(false);
    v.dispatch({ changes: { from: 0, to: 1 } });
    expect(revertInsertion(view, t!)).toBe(true);
    expect(v.state.doc.toString()).toBe('As shown by .');
  });

  it('a reverted citation cannot be reverted twice', () => {
    const { view, t } = citeAndTrack('As shown by .', 12, 'a2020');
    expect(revertInsertion(view, t!)).toBe(true);
    expect(revertInsertion(view, t!)).toBe(false);
  });
});
