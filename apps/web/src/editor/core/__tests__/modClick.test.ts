import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from '@codemirror/state';
import { EditorView, showTooltip } from '@codemirror/view';

vi.mock('../../../settings/store', () => {
  const missing = () => { throw new Error('store not used here'); };
  return { getSetting: missing, setSetting: missing, resetSetting: missing, subscribeSetting: missing };
});

import { followAtCaret, isModClick, modClick, modClickExtension, modClickHandlers, modClickHeld, modClickTargetAt, pickTarget, withinDrag } from '../modClick';
import type { ModClickHandler } from '../types';

function fakeView(state: EditorState): EditorView & { state: EditorState } {
  const v = {
    state,
    dispatch(s: Transaction | TransactionSpec) { v.state = ('startState' in s ? (s as Transaction) : v.state.update(s as TransactionSpec)).state; },
  };
  return v as unknown as EditorView & { state: EditorState };
}

const DOC = 'See \\url{https://example.org} and \\ref{fig:x}.';
const URL_FROM = DOC.indexOf('https');
const URL_TO = DOC.indexOf('}');
const REF_FROM = DOC.indexOf('fig:x');

const urlHandler = (run = vi.fn()): ModClickHandler => ({
  id: 'links.url', priority: 50,
  target: (view, pos) => {
    const s = view.state.doc.toString();
    const from = s.indexOf('https'), to = s.indexOf('}');
    return pos >= from && pos <= to ? { from, to, title: 'Open https://example.org/' } : null;
  },
  run,
});
const refHandler = (run = vi.fn()): ModClickHandler => ({
  id: 'crossrefs.label', priority: 40,
  target: (_view, pos) => (pos >= REF_FROM && pos <= REF_FROM + 5 ? { from: REF_FROM, to: REF_FROM + 5, title: 'Go to \\label{fig:x}', error: 'No \\label{fig:x} in this project' } : null),
  run,
});

describe('which handler answers', () => {
  it('asks the handlers by priority, highest first, and takes the first target', () => {
    const low: ModClickHandler = { id: 'low', priority: 1, target: () => ({ from: 0, to: 3, title: 'low' }), run: vi.fn() };
    const high = urlHandler();
    const state = EditorState.create({ doc: DOC, extensions: [modClick.of(low), modClick.of(high)] });
    expect(modClickHandlers(state).map((h) => h.id)).toEqual(['links.url', 'low']);
    const view = fakeView(state);
    expect(pickTarget(modClickHandlers(state), view, URL_FROM + 2)?.handler.id).toBe('links.url');
    expect(pickTarget(modClickHandlers(state), view, 1)?.handler.id).toBe('low');
  });

  it('gives no target where nothing is followable, so the click adds a cursor', () => {
    const state = EditorState.create({ doc: DOC, extensions: [modClick.of(urlHandler())] });
    expect(modClickTargetAt(fakeView(state), 1)).toBeNull();
    expect(modClickTargetAt(fakeView(EditorState.create({ doc: DOC })), URL_FROM), 'no handlers at all').toBeNull();
  });

  it('skips a handler that throws or answers a span outside the document', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throws: ModClickHandler = { id: 'throws', priority: 99, target: () => { throw new Error('boom'); }, run: vi.fn() };
    const wild: ModClickHandler = { id: 'wild', priority: 98, target: () => ({ from: 5, to: 9999, title: 'x' }), run: vi.fn() };
    const state = EditorState.create({ doc: DOC, extensions: [modClick.of(throws), modClick.of(wild), modClick.of(urlHandler())] });
    expect(modClickTargetAt(fakeView(state), URL_FROM)?.handler.id).toBe('links.url');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('the gesture', () => {
  const press = (mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>>, button = 0) =>
    ({ button, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

  it('is ⌘-click on a Mac and Ctrl-click elsewhere, with the main button', () => {
    expect(isModClick(press({ metaKey: true }), true)).toBe(true);
    expect(isModClick(press({ ctrlKey: true }), false)).toBe(true);
    expect(isModClick(press({ ctrlKey: true }), true), "a Mac's Control-click is a right-click").toBe(false);
    expect(isModClick(press({ metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(isModClick(press({ metaKey: true }), false), 'the Windows key is not the modifier for clicks').toBe(false);
    expect(isModClick(press({ metaKey: true }, 2), true)).toBe(false);
    expect(isModClick(press({}), true)).toBe(false);
    expect(isModClick(press({ metaKey: true, shiftKey: true }), true)).toBe(true);
  });

  it('never follows with Alt held: ⌘⌥-click still adds a cursor', () => {
    expect(isModClick(press({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isModClick(press({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(modClickHeld({ metaKey: true, ctrlKey: false, altKey: true }, true)).toBe(false);
  });

  it('follows on a click within the drag threshold only', () => {
    expect(withinDrag({ x: 10, y: 10 }, { x: 13, y: 14 })).toBe(true);
    expect(withinDrag({ x: 10, y: 10 }, { x: 16, y: 10 })).toBe(false);
  });
});

describe('following at the caret (Alt+Enter)', () => {
  const alt = { key: 'Enter', altKey: true } as KeyboardEvent;

  it('runs the target under the caret with the key event', () => {
    const run = vi.fn();
    const view = fakeView(EditorState.create({ doc: DOC, selection: EditorSelection.cursor(URL_FROM + 3), extensions: [modClickExtension(), modClick.of(urlHandler(run))] }));
    expect(followAtCaret(view, alt)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][1]).toEqual({ from: URL_FROM, to: URL_TO, title: 'Open https://example.org/' });
    expect(run.mock.calls[0][2]).toBe(alt);
  });

  it('lets the key through when nothing is under the caret', () => {
    const run = vi.fn();
    const view = fakeView(EditorState.create({ doc: DOC, selection: EditorSelection.cursor(1), extensions: [modClickExtension(), modClick.of(urlHandler(run))] }));
    expect(followAtCaret(view, alt)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('shows why a recognised target cannot be followed, and never runs it', () => {
    const run = vi.fn();
    const view = fakeView(EditorState.create({ doc: DOC, selection: EditorSelection.cursor(REF_FROM + 1), extensions: [modClickExtension(), modClick.of(refHandler(run))] }));
    expect(view.state.facet(showTooltip).filter(Boolean)).toHaveLength(0);
    expect(followAtCaret(view, alt)).toBe(true);
    expect(run).not.toHaveBeenCalled();
    const tips = view.state.facet(showTooltip).filter(Boolean);
    expect(tips).toHaveLength(1);
    expect(tips[0]!.pos).toBe(REF_FROM);
    // the underline marks the span, in the error style
    const marks: string[] = [];
    for (const deco of view.state.facet(EditorView.decorations)) {
      const set = typeof deco === 'function' ? null : deco;
      set?.between(0, view.state.doc.length, (from, to, d) => { marks.push(`${from}-${to}:${d.spec.class}`); });
    }
    expect(marks).toEqual([`${REF_FROM}-${REF_FROM + 5}:cm-modclick-target cm-modclick-target--error`]);
    // and goes away with the next edit or caret move
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(view.state.facet(showTooltip).filter(Boolean)).toHaveLength(0);
  });

  it('keeps going when a handler\'s run throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const view = fakeView(EditorState.create({ doc: DOC, selection: EditorSelection.cursor(URL_FROM), extensions: [modClickExtension(), modClick.of(urlHandler(vi.fn(() => { throw new Error('popup blocked'); })))] }));
    expect(followAtCaret(view, alt)).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
