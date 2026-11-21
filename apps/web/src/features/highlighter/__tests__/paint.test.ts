import { describe, it, expect } from 'vitest';
import { flatten, isPainted, normalizeRanges, paint, type PaintOp } from '../paint';
import { normalizeHex, readEntry, drawnColor, colorName, type Run } from '../model';

const run = (key: string, from: number, to: number, color = 'yellow', author = 'me', t = 1): Run => ({ key, from, to, color, author, name: author, t });
const P = (color: string, author = 'me', t = 10): Extract<PaintOp, { kind: 'paint' }> => ({ kind: 'paint', color, author, name: author, t });
const keys = () => { let i = 0; return () => `new${i++}`; };
/** The runs after applying a result, sorted by start. */
function after(runs: Run[], res: ReturnType<typeof paint>): Array<[number, number, string, string]> {
  const m = new Map(runs.map((r) => [r.key, r]));
  for (const d of res.deletes) m.delete(d);
  for (const u of res.upserts) m.set(u.key, u);
  return [...m.values()].sort((a, b) => a.from - b.from).map((r) => [r.from, r.to, r.color, r.author]);
}

describe('paint', () => {
  it('paints an empty stretch', () => {
    const res = paint([], [{ from: 2, to: 5 }], P('yellow'), keys());
    expect(res.deletes).toEqual([]);
    expect(after([], res)).toEqual([[2, 5, 'yellow', 'me']]);
  });

  it('splits another colour into three when painting inside it', () => {
    const runs = [run('a', 0, 10, 'green')];
    const res = paint(runs, [{ from: 3, to: 6 }], P('pink'), keys());
    expect(after(runs, res)).toEqual([[0, 3, 'green', 'me'], [3, 6, 'pink', 'me'], [6, 10, 'green', 'me']]);
    expect(res.deletes).toEqual([]);
  });

  it('trims what it paints over, and removes what it covers', () => {
    const runs = [run('a', 0, 4, 'green'), run('b', 5, 7, 'sky'), run('c', 8, 12, 'violet')];
    const res = paint(runs, [{ from: 2, to: 10 }], P('pink'), keys());
    expect(after(runs, res)).toEqual([[0, 2, 'green', 'me'], [2, 10, 'pink', 'me'], [10, 12, 'violet', 'me']]);
    expect(res.deletes).toEqual(['b']);
  });

  it('merges touching and overlapping runs of the same colour by the same author', () => {
    const runs = [run('a', 0, 3), run('b', 5, 8), run('c', 20, 22)];
    const res = paint(runs, [{ from: 3, to: 5 }], P('yellow'), keys());
    expect(after(runs, res)).toEqual([[0, 8, 'yellow', 'me'], [20, 22, 'yellow', 'me']]);
    expect(res.upserts).toHaveLength(1);
    expect(res.deletes).toHaveLength(1);
  });

  it("does not merge with a co-author's run of the same colour: paints over it", () => {
    const runs = [run('a', 0, 5, 'yellow', 'them')];
    const res = paint(runs, [{ from: 3, to: 8 }], P('yellow'), keys());
    expect(after(runs, res)).toEqual([[0, 3, 'yellow', 'them'], [3, 8, 'yellow', 'me']]);
  });

  it('erases by trimming and splitting', () => {
    const runs = [run('a', 0, 10, 'green'), run('b', 12, 14)];
    const res = paint(runs, [{ from: 4, to: 13 }], { kind: 'erase' }, keys());
    expect(after(runs, res)).toEqual([[0, 4, 'green', 'me'], [13, 14, 'yellow', 'me']]);
  });

  it('paints several selection ranges in one result', () => {
    const res = paint([], [{ from: 10, to: 12 }, { from: 0, to: 2 }, { from: 1, to: 3 }, { from: 5, to: 5 }], P('sky'), keys());
    expect(after([], res)).toEqual([[0, 3, 'sky', 'me'], [10, 12, 'sky', 'me']]);
  });

  it('changes nothing when the stretch already shows that colour', () => {
    const runs = [run('a', 0, 10)];
    const res = paint(runs, [{ from: 2, to: 5 }], { ...P('yellow'), t: 1 }, keys());
    expect(res).toEqual({ upserts: [], deletes: [] });
  });
});

describe('flatten, isPainted, normalizeRanges', () => {
  it('draws the newest on top where runs overlap', () => {
    const segs = flatten([run('old', 0, 10, 'green', 'a', 1), run('new', 3, 6, 'pink', 'b', 2)]);
    expect(segs.map((s) => [s.from, s.to, s.run.key])).toEqual([[0, 3, 'old'], [3, 6, 'new'], [6, 10, 'old']]);
  });

  it('knows when a selection is entirely one colour', () => {
    const runs = [run('a', 0, 5), run('b', 5, 9), run('c', 9, 12, 'green')];
    expect(isPainted(runs, [{ from: 1, to: 8 }], 'yellow')).toBe(true);
    expect(isPainted(runs, [{ from: 1, to: 10 }], 'yellow')).toBe(false);
    expect(isPainted(runs, [{ from: 13, to: 14 }], 'yellow')).toBe(false);
    expect(isPainted(runs, [], 'yellow')).toBe(false);
  });

  it('joins ranges', () => {
    expect(normalizeRanges([{ from: 5, to: 7 }, { from: 0, to: 2 }, { from: 2, to: 3 }, { from: 9, to: 9 }])).toEqual([{ from: 0, to: 3 }, { from: 5, to: 7 }]);
  });
});

describe('model', () => {
  it('normalises hex colours and refuses the rest', () => {
    expect(normalizeHex(' #ABC ')).toEqual({ ok: true, color: '#aabbcc' });
    expect(normalizeHex('3366FF')).toEqual({ ok: true, color: '#3366ff' });
    expect(normalizeHex('#3366ff80')).toMatchObject({ ok: false, error: expect.stringContaining('Transparency') });
    expect(normalizeHex('#12')).toMatchObject({ ok: false, error: expect.stringContaining('6 hex digits') });
  });

  it('reads only version-1 entries, keeping an unknown colour as stored but drawing it yellow', () => {
    expect(readEntry(null)).toBeNull();
    expect(readEntry({ v: 2, a: {}, b: {}, t: 1 })).toBeNull();
    expect(readEntry({ v: 1, a: 'x', b: {}, t: 1 })).toBeNull();
    const e = readEntry({ v: 1, a: {}, b: {}, c: 'url(evil)', u: 'acct:1', n: 'Ada', t: 5 });
    expect(e?.c).toBe('url(evil)');
    expect(drawnColor(e?.c)).toBe('yellow');
    expect(colorName('#3366ff')).toBe('#3366ff');
    expect(colorName('sky')).toBe('Sky');
  });
});
