import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { relAt, resolve, resolveMany } from '../yAnchor';

function peers(n: number): Y.Doc[] {
  return Array.from({ length: n }, (_, i) => { const d = new Y.Doc(); d.clientID = 100 + i; return d; });
}
function syncAll(docs: Y.Doc[]) {
  for (const a of docs) for (const b of docs) if (a !== b) Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
}

describe('resolveMany', () => {
  it('gives the same answers as resolving one by one, after interleaved edits from three clients', () => {
    const docs = peers(3);
    docs[0].getText('content').insert(0, 'The quick brown fox jumps over the lazy dog.\nSecond line.\n');
    syncAll(docs);
    const t0 = docs[0].getText('content');
    const anchors: unknown[] = [];
    for (let i = 0; i <= t0.length; i++) anchors.push(relAt(t0, i, 0), relAt(t0, i, -1));
    let seed = 7;
    const rnd = (m: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % m; };
    for (let round = 0; round < 40; round++) {
      for (const d of docs) {
        const t = d.getText('content');
        if (rnd(3) === 0 && t.length > 2) t.delete(rnd(t.length - 1), 1 + rnd(2));
        else t.insert(rnd(t.length + 1), 'ab'.slice(0, 1 + rnd(2)));
      }
      if (round % 3 === 0) syncAll(docs);
    }
    syncAll(docs);
    for (const d of docs) {
      const t = d.getText('content');
      expect(resolveMany(d, t, anchors)).toEqual(anchors.map((a) => resolve(d, t, a)));
    }
    // Every peer agrees.
    const answers = docs.map((d) => resolveMany(d, d.getText('content'), anchors));
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it('ignores junk and positions in another type', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'abc');
    const other = doc.getText('other');
    other.insert(0, 'xyz');
    const list = [null, 'nope', 42, {}, { item: { client: 'x', clock: 0 } }, { item: { client: 999999, clock: 0 } }, relAt(other, 1)];
    expect(resolveMany(doc, text, list)).toEqual([null, null, null, null, null, null, null]);
  });

  it('resolves the start and end of the text', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'abc');
    expect(resolveMany(doc, text, [relAt(text, 0, -1), relAt(text, 3, 0), relAt(text, 3, -1)])).toEqual([0, 3, 3]);
  });

  it('follows text an undo restored only when asked, like Yjs', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'keep GONE keep');
    const undo = new Y.UndoManager(text, { captureTimeout: 0 });
    const a = relAt(text, 5, 0);
    const b = relAt(text, 9, -1);
    text.delete(5, 4);
    expect(resolveMany(doc, text, [a, b])).toEqual([5, 5]);
    undo.undo();
    expect(text.toString()).toBe('keep GONE keep');
    expect(resolveMany(doc, text, [a, b], true)).toEqual([5, 9]);
    expect(resolveMany(doc, text, [a, b], false)).toEqual([resolve(doc, text, a, false), resolve(doc, text, b, false)]);
    const plain = resolveMany(doc, text, [a, b], false);
    expect(plain[0]).toBe(plain[1]); // without following, the range stays collapsed: what a peer sees
  });
});
