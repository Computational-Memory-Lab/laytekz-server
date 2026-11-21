import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { EditorState } from '@codemirror/state';
import { relAt } from '../../../editor/yAnchor';
import { HIGHLIGHTS_KEY, HL_ORIGIN, trackHighlights } from '../../../editor/docCache';
import { highlightRuns, highlighterExtension, repairUndoneAnchors, resolveRuns, type HighlighterConfig } from '../extension';

function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.clientID = 1;
  b.clientID = 2;
  return { a, b };
}
const sync = (x: Y.Doc, y: Y.Doc) => {
  Y.applyUpdate(y, Y.encodeStateAsUpdate(x, Y.encodeStateVector(y)), 'remote');
  Y.applyUpdate(x, Y.encodeStateAsUpdate(y, Y.encodeStateVector(x)), 'remote');
};
const text = (d: Y.Doc) => d.getText('content');
function highlight(d: Y.Doc, key: string, from: number, to: number, author = 'acct:a') {
  d.transact(() => {
    d.getMap(HIGHLIGHTS_KEY).set(key, { v: 1, a: relAt(text(d), from, 0), b: relAt(text(d), to, -1), c: 'yellow', u: author, n: 'Ada', t: Date.now() });
  }, HL_ORIGIN);
}
const shown = (d: Y.Doc) => resolveRuns(d, text(d)).map((r) => text(d).toString().slice(r.from, r.to));

describe('highlight anchors', () => {
  it('typing at either edge does not grow a highlight; typing inside does', () => {
    const { a } = pair();
    text(a).insert(0, 'one TWO three');
    highlight(a, 'h', 4, 7);
    text(a).insert(7, '!');
    text(a).insert(4, '>');
    expect(shown(a)).toEqual(['TWO']);
    text(a).insert(6, 'w');
    expect(shown(a)).toEqual(['TwWO']);
  });

  it('concurrent edits leave identical ranges for every peer', () => {
    const { a, b } = pair();
    text(a).insert(0, 'alpha beta gamma delta');
    sync(a, b);
    highlight(a, 'h1', 6, 16); // "beta gamma"
    highlight(b, 'h2', 0, 5); // "alpha"
    text(a).insert(11, 'NEW ');
    text(b).delete(6, 2); // "ta gamma"
    text(b).insert(0, '>> ');
    text(a).insert(6, '[');
    sync(a, b);
    expect(text(a).toString()).toBe(text(b).toString());
    const ra = resolveRuns(a, text(a)).map((r) => [r.key, r.from, r.to]).sort();
    const rb = resolveRuns(b, text(b)).map((r) => [r.key, r.from, r.to]).sort();
    expect(ra).toEqual(rb);
    expect(shown(a).sort()).toEqual(['alpha', 'ta NEW gamma']);
  });

  it('a full deletion hides it; undo brings it back for both peers', () => {
    const { a, b } = pair();
    text(a).insert(0, 'keep THIS keep');
    const undo = new Y.UndoManager(text(a), { captureTimeout: 0 });
    trackHighlights(a, undo);
    highlight(a, 'h', 5, 9);
    sync(a, b);
    expect(shown(b)).toEqual(['THIS']);
    text(a).delete(4, 6); // " THIS "
    sync(a, b);
    expect(shown(a)).toEqual([]);
    expect(shown(b)).toEqual([]);
    undo.undo();
    expect(text(a).toString()).toBe('keep THIS keep');
    expect(repairUndoneAnchors(a, text(a))).toBe(1);
    sync(a, b);
    expect(shown(a)).toEqual(['THIS']);
    expect(shown(b)).toEqual(['THIS']);
    expect(undo.undoStack.length).toBe(1); // the repair is no undo step: the highlight itself still is
  });

  it('a highlight is one undo step of its own; a remote highlight is in nobody else\'s history', () => {
    const { a, b } = pair();
    text(a).insert(0, 'some text here');
    sync(a, b);
    const undo = new Y.UndoManager(text(a), { captureTimeout: 0 });
    trackHighlights(a, undo);
    highlight(b, 'theirs', 0, 4, 'acct:b');
    sync(a, b);
    expect(undo.undoStack.length).toBe(0);
    highlight(a, 'mine', 5, 9);
    expect(undo.undoStack.length).toBe(1);
    undo.undo();
    expect(shown(a)).toEqual(['some']);
    undo.redo();
    expect(shown(a).sort()).toEqual(['some', 'text']);
    expect(text(a).toString()).toBe('some text here'); // highlights never change the text
  });
});

describe('the editor field', () => {
  it('follows CodeMirror changes the way the anchors resolve', () => {
    const { a } = pair();
    text(a).insert(0, 'one TWO three FOUR five');
    highlight(a, 'h1', 4, 7);
    highlight(a, 'h2', 14, 18);
    const cfg: HighlighterConfig = {
      ydoc: a, ytext: text(a), undoManager: new Y.UndoManager(text(a)),
      me: () => ({ id: 'acct:a', name: 'Ada' }), showOthers: true, strength: 'medium', canWrite: () => true, notify: () => {},
    };
    let state = EditorState.create({ doc: text(a).toString(), extensions: highlighterExtension(cfg) });
    expect(highlightRuns(state).map((r) => [r.from, r.to])).toEqual([[4, 7], [14, 18]]);
    const edits: Array<{ from: number; to?: number; insert?: string }> = [
      { from: 7, insert: 'x' }, { from: 4, insert: 'y' }, { from: 10, to: 16 }, { from: 0, insert: 'zz' },
    ];
    for (const e of edits) {
      state = state.update({ changes: e }).state;
      a.transact(() => {
        if (e.to !== undefined) text(a).delete(e.from, e.to - e.from);
        if (e.insert) text(a).insert(e.from, e.insert);
      });
    }
    expect(state.doc.toString()).toBe(text(a).toString());
    const fromField = highlightRuns(state).map((r) => [r.key, r.from, r.to]).sort();
    const fromAnchors = resolveRuns(a, text(a)).map((r) => [r.key, r.from, r.to]).sort();
    expect(fromField).toEqual(fromAnchors);
  });
});
