import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { EditorSelection, EditorState } from '@codemirror/state';

vi.mock('../../../settings/store', () => ({
  getSetting: (id: string) => ({ 'highlighter.card': true, 'highlighter.rememberLast': true, 'highlighter.color': 'yellow' } as Record<string, unknown>)[id],
  setSetting: () => {},
  useSetting: () => [undefined, () => {}],
}));

import { relAt } from '../../../editor/yAnchor';
import { HIGHLIGHTS_KEY, HL_ORIGIN, trackHighlights } from '../../../editor/docCache';
import { highlighterExtension, type HighlighterConfig } from '../extension';
import { addCustom, cleanCustomList, contrast, pickCurrent, readabilityWarnings, removeCustom, CUSTOM_MAX } from '../colors';
import { colorRows, contextItems, dropdownItems } from '../menuItems';
import { nextRun } from '../actions';
import { ago, runAt, selectionHasHighlight } from '../query';
import { cardField } from '../card';
import { filterRows, type ListRow } from '../HighlightsPanel';
import type { MenuEntry } from '../../../components/Menu';

function setup(doc: string, marks: Array<[string, number, number, string?, string?]>) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('content');
  ytext.insert(0, doc);
  const undoManager = new Y.UndoManager(ytext, { captureTimeout: 0 });
  trackHighlights(ydoc, undoManager);
  ydoc.transact(() => {
    for (const [key, from, to, c = 'yellow', u = 'acct:me'] of marks) {
      ydoc.getMap(HIGHLIGHTS_KEY).set(key, { v: 1, a: relAt(ytext, from, 0), b: relAt(ytext, to, -1), c, u, n: 'Ada', t: 1 });
    }
  }, HL_ORIGIN);
  const cfg: HighlighterConfig = {
    ydoc, ytext, undoManager, me: () => ({ id: 'acct:me', name: 'Ada' }), showOthers: true, strength: 'medium',
    canWrite: () => true, notify: () => {},
  };
  const state = EditorState.create({ doc, extensions: [highlighterExtension(cfg), cardField] });
  return { state, cfg };
}

const ids = (rows: MenuEntry[]) => rows.map((r) => ('id' in r ? r.id : r.kind));

describe('custom colours', () => {
  it('keeps hex values only, most recent first, without repeats, at most 8', () => {
    expect(cleanCustomList(['#aabbcc', 'nope', '#aabbcc', 3, '#112233'])).toEqual(['#aabbcc', '#112233']);
    let list: string[] = [];
    for (let i = 0; i < 10; i++) list = addCustom(list, `#00000${i}`);
    expect(list).toHaveLength(CUSTOM_MAX);
    expect(list[0]).toBe('#000009');
    expect(addCustom(list, '#000005')[0]).toBe('#000005');
    expect(addCustom(['#aabbcc'], 'red')).toEqual(['#aabbcc']);
    expect(removeCustom(['#aabbcc', '#112233'], '#aabbcc')).toEqual(['#112233']);
  });

  it('the current colour is the last chosen when remembered, else the default', () => {
    expect(pickCurrent('green', true, '#3366ff')).toBe('#3366ff');
    expect(pickCurrent('green', false, '#3366ff')).toBe('green');
    expect(pickCurrent('bogus', true, null)).toBe('yellow');
    expect(pickCurrent('pink', true, 'garbage')).toBe('pink');
  });

  it('warns about hard-to-read colours, and not about body text on a light yellow', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(readabilityWarnings('#f5c40d').filter((w) => w.startsWith('Text') || w.includes('barely'))).toEqual([]);
    expect(readabilityWarnings('#000000').some((w) => w.includes('hard to read'))).toBe(true);
    expect(readabilityWarnings('#fefefe').some((w) => w.includes('barely visible'))).toBe(true);
    expect(readabilityWarnings('nope')).toEqual([]);
  });
});

describe('menus', () => {
  it('colour rows: six presets, your colours, custom', () => {
    const rows = colorRows({ current: 'green', custom: ['#3366ff'], pick: () => {}, custom_: () => {}, prefix: 'p' });
    expect(ids(rows)).toEqual(['p-yellow', 'p-orange', 'p-pink', 'p-green', 'p-sky', 'p-violet', 'p-yours', 'p-3366ff', 'p-custom']);
    expect(rows.filter((r) => 'checked' in r && r.checked).map((r) => ('id' in r ? r.id : ''))).toEqual(['p-green']);
  });

  it('the dropdown has no writing rows when the file cannot be written', () => {
    const a = { pick: () => {}, custom: () => {}, erase: () => {}, clearMine: () => {}, clearAll: () => {}, step: () => {}, showList: () => {}, settings: () => {} };
    const base = { current: 'yellow', custom: [], hasSelection: true, selectionHasHighlight: false, hasHighlights: true, hasMine: false };
    const ro = ids(dropdownItems({ ...base, canWrite: false }, a));
    expect(ro).not.toContain('highlight-option-yellow');
    expect(ro).toContain('next');
    const rw = dropdownItems({ ...base, canWrite: true }, a);
    expect(ids(rw)).toContain('highlight-option-yellow');
    const erase = rw.find((r) => 'id' in r && r.id === 'erase') as { disabled?: boolean };
    expect(erase.disabled).toBe(true);
  });

  it('the right-click rows need a selection and a writable file; Remove only over a highlight', () => {
    const a = { pick: vi.fn(), custom: () => {}, erase: () => {} };
    const s = { current: 'pink', custom: [], canWrite: true, hasSelection: true, selectionHasHighlight: false, shortcut: '⇧⌘H' };
    expect(contextItems({ ...s, hasSelection: false }, a)).toBeNull();
    expect(contextItems({ ...s, canWrite: false }, a)).toBeNull();
    const rows = contextItems(s, a)!;
    expect(ids(rows)).toEqual(['highlight', 'highlight-colour']);
    expect((rows[0] as { label: string }).label).toBe('Highlight pink');
    (rows[0] as { onSelect(): void }).onSelect();
    expect(a.pick).toHaveBeenCalledWith('pink');
    expect(ids(contextItems({ ...s, selectionHasHighlight: true }, a)!)).toContain('highlight-remove');
  });
});

describe('reading highlights in the editor', () => {
  const doc = 'alpha beta gamma delta';
  it('finds the highlight at the caret, edges included', () => {
    const { state } = setup(doc, [['h1', 6, 10]]);
    expect(runAt(state, 8)?.key).toBe('h1');
    expect(runAt(state, 6)?.key).toBe('h1');
    expect(runAt(state, 3)).toBeNull();
  });

  it('steps to the next and previous highlight from the caret, wrapping', () => {
    const { state } = setup(doc, [['h1', 0, 5], ['h2', 11, 16]]);
    const at = (pos: number) => state.update({ selection: EditorSelection.cursor(pos) }).state;
    expect(nextRun(at(7), 1)?.key).toBe('h2');
    expect(nextRun(at(18), 1)?.key).toBe('h1');
    expect(nextRun(at(7), -1)?.key).toBe('h1');
    expect(nextRun(at(0), -1)?.key).toBe('h2');
    expect(nextRun(setup(doc, []).state, 1)).toBeNull();
  });

  it('knows when the selection touches a highlight', () => {
    const { state } = setup(doc, [['h1', 6, 10]]);
    expect(selectionHasHighlight(state.update({ selection: EditorSelection.single(0, 7) }).state)).toBe(true);
    expect(selectionHasHighlight(state.update({ selection: EditorSelection.single(0, 5) }).state)).toBe(false);
  });

  it('the card opens on a click inside a highlight, never on an arrow-key move, and closes on typing', () => {
    const { state } = setup(doc, [['h1', 6, 10]]);
    const arrow = state.update({ selection: EditorSelection.cursor(8), userEvent: 'select' }).state;
    expect(arrow.field(cardField)).toBeNull();
    const click = state.update({ selection: EditorSelection.cursor(8), userEvent: 'select.pointer' }).state;
    expect(click.field(cardField)?.key).toBe('h1');
    const moved = click.update({ selection: EditorSelection.cursor(2), userEvent: 'select' }).state;
    expect(moved.field(cardField)).toBeNull();
    const typed = click.update({ changes: { from: 8, insert: 'x' }, userEvent: 'input.type' }).state;
    expect(typed.field(cardField)).toBeNull();
  });
});

describe('the list', () => {
  const row = (key: string, color: string, authorId: string): ListRow => ({ key, path: 'main.tex', color, from: 0, to: 1, line: 1, excerpt: 'x', name: 'A', authorId, t: 1 });
  const rows = [row('a', 'yellow', 'acct:me'), row('b', 'green', 'acct:other'), row('c', 'yellow', 'acct:other'), row('d', 'bogus', 'acct:me')];
  it('filters by author and colour and counts colours before the colour filter', () => {
    const all = filterRows(rows, { me: 'acct:me', onlyMine: false, showOthers: true, color: null });
    expect(all.shown).toHaveLength(4);
    expect(all.counts.get('yellow')).toBe(3); // the unknown colour is drawn yellow
    const mine = filterRows(rows, { me: 'acct:me', onlyMine: true, showOthers: true, color: null });
    expect(mine.shown.map((r) => r.key)).toEqual(['a', 'd']);
    const hidden = filterRows(rows, { me: 'acct:me', onlyMine: false, showOthers: false, color: null });
    expect(hidden.shown.map((r) => r.key)).toEqual(['a', 'd']);
    const green = filterRows(rows, { me: 'acct:me', onlyMine: false, showOthers: true, color: 'green' });
    expect(green.shown.map((r) => r.key)).toEqual(['b']);
    expect(green.counts.get('green')).toBe(1);
  });

  it('relative times read plainly', () => {
    const now = 1_000_000_000;
    expect(ago(now - 5_000, now)).toBe('just now');
    expect(ago(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(ago(now - 3 * 86_400_000, now)).toBe('3 days ago');
    expect(ago(now - 3_600_000, now)).toBe('1 hour ago');
  });
});
