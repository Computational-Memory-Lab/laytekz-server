import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { closeBrackets } from '@codemirror/autocomplete';
import * as Y from 'yjs';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { latex } from 'codemirror-lang-latex';
import { undoBoundary } from '../../visual/history';
import { contextAt } from '../../texContext';
import {
  applyExplicitEdit, autoEditCore, autoEditMark, autoEditSettings, declined, lastAutoEdit, planAutoEdit, revertAutoEdit,
  statsEdit, typedInputOf,
} from '../autoEdit';
import { keyChains } from '../keyChains';
import { resetAutoEditNotices } from '../notices';
import type { AutoEditRule, TypedInput } from '../types';
import { headlessView, pressKey, settle, typeChar, typeText, withCaret, type HeadlessView } from './replay';

const store = vi.hoisted(() => ({ values: new Map<string, unknown>(), set: [] as [string, unknown][] }));
vi.mock('../../../settings/store', () => ({
  getSetting: (id: string) => store.values.get(id),
  setSetting: (id: string, v: unknown) => { store.set.push([id, v]); store.values.set(id, v); },
}));

/** `&` typed in text after anything but a backslash becomes `\&`. */
const amp: AutoEditRule = {
  id: 'test.amp',
  priority: 50,
  settingId: 'test.amp',
  run(t: TypedInput) {
    if (t.char !== '&' || t.from !== t.to || t.before.sliceDoc(t.from - 1, t.from) === '\\') return null;
    return { rule: 'test.amp', changes: { from: t.from, insert: '\\' } };
  },
};

const latexLanguage = latex({ autoCloseTags: false, enableLinting: false, enableAutocomplete: false, enableTooltips: false });

function editor(extensions: Extension[] = [], rules: AutoEditRule[] = [amp], doc = ''): HeadlessView {
  return headlessView({ doc, selection: EditorSelection.cursor(doc.length), extensions: [latexLanguage, autoEditCore(rules), ...extensions] });
}

beforeEach(() => {
  store.values.clear();
  store.set.length = 0;
  resetAutoEditNotices();
});

describe('the automatic-edit core', () => {
  it('makes the keystroke and the automatic edit separate steps between undo boundaries', async () => {
    const boundary = vi.fn();
    const view = editor([undoBoundary.of(boundary)]);
    await typeText(view, 'R&');
    expect(withCaret(view)).toBe('R\\&|');
    expect(boundary).toHaveBeenCalledTimes(2);
    const events = view.log.map((tr) => (tr.isUserEvent('input.auto') ? 'auto' : tr.isUserEvent('input.type') ? 'type' : 'other'));
    expect(events).toEqual(['type', 'type', 'auto']);
    expect(view.log[2].annotation(autoEditMark)).toBe('test.amp');
  });

  it('runs the first enabled rule by priority, and skips a rule that throws or whose setting is off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const low: AutoEditRule = { id: 'low', priority: 40, settingId: 'low.on', run: (t) => (t.char === '&' ? { rule: 'low', changes: { from: t.from, insert: 'L' } } : null) };
    const broken: AutoEditRule = { id: 'broken', priority: 90, settingId: 'broken.on', run: () => { throw new Error('boom'); } };
    let view = editor([], [low, amp, broken]);
    await typeText(view, '&');
    expect(withCaret(view)).toBe('\\&|');
    expect(warn).toHaveBeenCalledWith('Automatic edit broken failed', expect.any(Error));
    store.values.set('test.amp', false);
    view = editor([], [low, amp]);
    await typeText(view, '&');
    expect(withCaret(view)).toBe('L&|');
    view = editor([autoEditSettings.of(() => false)], [low, amp]);
    await typeText(view, '&');
    expect(withCaret(view)).toBe('&|');
    warn.mockRestore();
  });

  it('drops the follow-up when the document changed before it ran', async () => {
    const view = editor();
    await typeText(view, 'R');
    typeChar(view, '&');
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    await settle();
    expect(view.state.doc.toString()).toBe('xR&');
    expect(view.log.some((tr) => tr.isUserEvent('input.auto'))).toBe(false);
  });

  it('never runs during composition, with several cursors, when read-only, or on a statistics edit', async () => {
    let view = editor();
    view.dispatch({ changes: { from: 0, insert: '&' }, selection: { anchor: 1 }, userEvent: 'input.type.compose' });
    await settle();
    expect(view.state.doc.toString()).toBe('&');

    view = headlessView({
      doc: 'a b',
      selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)]),
      extensions: [EditorState.allowMultipleSelections.of(true), autoEditCore([amp])],
    });
    typeChar(view, '&');
    await settle();
    expect(view.state.doc.toString()).toBe('a& b&');

    view = editor([EditorState.readOnly.of(true)]);
    typeChar(view, '&');
    await settle();
    expect(view.state.doc.toString()).toBe('&');

    view = editor();
    view.dispatch({ changes: { from: 0, insert: '&' }, selection: { anchor: 1 }, userEvent: 'input.type', annotations: statsEdit.of(true) });
    await settle();
    expect(view.state.doc.toString()).toBe('&');
  });

  it('ignores pastes, completions and remote changes', async () => {
    const view = editor();
    view.dispatch({ changes: { from: 0, insert: '&' }, selection: { anchor: 1 }, userEvent: 'input.paste' });
    view.dispatch({ changes: { from: 1, insert: '&' }, selection: { anchor: 2 }, userEvent: 'input.complete' });
    view.dispatch({ changes: { from: 2, insert: '&' } });
    await settle();
    expect(view.state.doc.toString()).toBe('&&&');
  });

  it('reads the typed character from the input handlers, closeBrackets steps included', () => {
    const seen: string[] = [];
    const probe: AutoEditRule = { id: 'probe', priority: 1, settingId: 'probe', run: (t) => { seen.push(`${t.char}@${t.from}-${t.to}:${t.after.doc}`); return null; } };
    const view = editor([closeBrackets()], [probe]);
    typeChar(view, '{');
    typeChar(view, 'x');
    typeChar(view, '}');
    expect(seen).toEqual(['{@0-0:{}', 'x@1-1:{x}', '}@2-2:{x}']);
    const tr = view.state.update({ changes: { from: 0, insert: 'q' }, userEvent: 'input.type' });
    expect(typedInputOf(tr)).toMatchObject({ char: 'q', from: 0, to: 0 });
  });

  it('lets a rule read the context before the keystroke', async () => {
    const textOnly: AutoEditRule = { ...amp, run: (t) => (contextAt(t.before, t.from)?.kind === 'text' ? amp.run(t) : null) };
    const view = editor([], [textOnly], '\\begin{tabular}{ll}\n\n\\end{tabular}\n');
    view.dispatch({ selection: { anchor: 20 } });
    await typeText(view, 'a & b');
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await typeText(view, 'R&D');
    expect(view.state.doc.toString()).toBe('\\begin{tabular}{ll}\na & b\n\\end{tabular}\nR\\&D');
  });
});

describe('Backspace after an automatic edit', () => {
  it('reverts it, declines the spot, and leaves other spots alone', async () => {
    const view = editor();
    await typeText(view, 'R&');
    expect(view.state.field(lastAutoEdit)).toMatchObject({ rule: 'test.amp', caretAfter: 3 });
    expect(await pressKey(view, 'Backspace')).toBe(true);
    expect(withCaret(view)).toBe('R&|');
    expect(declined(view.state, 1, 'test.amp')).toBe(true);
    expect(declined(view.state, 1, 'other')).toBe(false);
    await typeText(view, '&');
    expect(withCaret(view)).toBe('R&&|');
    await typeText(view, ' and &');
    expect(withCaret(view)).toBe('R&& and \\&|');
  });

  it('is an ordinary Backspace once the caret moved or something else was typed', async () => {
    const view = editor();
    await typeText(view, 'R&');
    view.dispatch({ selection: { anchor: 2 }, userEvent: 'select' });
    view.dispatch({ selection: { anchor: 3 }, userEvent: 'select' });
    expect(view.state.field(lastAutoEdit)).toBeNull();
    await pressKey(view, 'Backspace');
    expect(withCaret(view)).toBe('R\\|');

    const typed = editor();
    await typeText(typed, 'R&x');
    expect(typed.state.field(lastAutoEdit)).toBeNull();
    expect(revertAutoEdit(typed.asView())).toBe(false);
  });

  it('survives a collaborator’s change elsewhere, but not one that touches the edit', async () => {
    const view = editor();
    await typeText(view, 'R&');
    view.dispatch({ changes: { from: 0, insert: 'xy ' } });
    expect(view.state.field(lastAutoEdit)).toMatchObject({ caretAfter: 6 });
    await pressKey(view, 'Backspace');
    expect(withCaret(view)).toBe('xy R&|');

    const touched = editor();
    await typeText(touched, 'R&');
    touched.dispatch({ changes: { from: 1, to: 2 } });
    expect(touched.state.field(lastAutoEdit)).toBeNull();
  });

  it('sits in the Backspace key chain at priority 100', () => {
    const view = editor();
    expect(view.state.facet(keyChains).filter((e) => e.key === 'Backspace').map((e) => [e.id, e.priority])).toEqual([['autoEdit.revert', 100]]);
  });
});

describe('applyExplicitEdit', () => {
  it('makes a command’s edit one undo step, as input.auto unless told otherwise', () => {
    const boundary = vi.fn();
    const view = editor([undoBoundary.of(boundary)]);
    applyExplicitEdit(view.asView(), { changes: { from: 0, insert: 'x' } });
    applyExplicitEdit(view.asView(), { changes: { from: 1, insert: 'y' } }, 'input.align');
    expect(boundary).toHaveBeenCalledTimes(4);
    expect(view.log.map((tr) => (tr.isUserEvent('input.auto') ? 'auto' : tr.isUserEvent('input.align') ? 'align' : '?'))).toEqual(['auto', 'align']);
    expect(planAutoEdit(view.log[0])).toBeNull();
  });

  it('marked, is reverted by Backspace like an automatic edit', async () => {
    const view = editor([], []);
    applyExplicitEdit(view.asView(), { changes: { from: 0, insert: '\\end{x}' }, selection: { anchor: 7 }, annotations: autoEditMark.of('envclose') });
    expect(await pressKey(view, 'Backspace')).toBe(true);
    expect(view.state.doc.toString()).toBe('');
  });
});

describe('with a real Y.UndoManager', () => {
  function peer(ydoc: Y.Doc, extensions: Extension[] = []) {
    const ytext = ydoc.getText('t');
    const undoManager = new Y.UndoManager(ytext);
    const collab = yCollab(ytext, null, { undoManager });
    const view = headlessView({
      doc: ytext.toString(),
      extensions: [collab, undoBoundary.of(() => undoManager.stopCapturing()), autoEditCore([amp]), ...extensions],
    }, collab);
    const undo = () => yUndoManagerKeymap.find((b) => b.key === 'Mod-z')!.run!(view.asView());
    return { view, undo, ytext };
  }

  function connect(a: Y.Doc, b: Y.Doc) {
    a.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(b, u, 'remote'); });
    b.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(a, u, 'remote'); });
  }

  it('one undo reverts only the automatic edit', async () => {
    const a = peer(new Y.Doc());
    await typeText(a.view, 'R&');
    expect(a.ytext.toString()).toBe('R\\&');
    a.undo();
    expect(a.ytext.toString()).toBe('R&');
    expect(a.view.state.doc.toString()).toBe('R&');
    a.undo();
    expect(a.ytext.toString()).toBe('');
  });

  it('a collaborator’s undo never reverts it, and Backspace still can after their change', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    connect(docA, docB);
    const a = peer(docA);
    const b = peer(docB);
    await typeText(a.view, 'R&');
    expect(b.view.state.doc.toString()).toBe('R\\&');
    await typeText(b.view, 'x');
    expect(a.view.state.doc.toString()).toBe('xR\\&');
    b.undo();
    expect(a.ytext.toString()).toBe('R\\&');
    expect(b.ytext.toString()).toBe('R\\&');
    b.undo();
    expect(b.ytext.toString()).toBe('R\\&');

    await typeText(b.view, 'y');
    expect(a.view.state.field(lastAutoEdit)).not.toBeNull();
    await pressKey(a.view, 'Backspace');
    expect(a.ytext.toString()).toBe('yR&');
    expect(b.ytext.toString()).toBe('yR&');
  });
});

describe('the flash', () => {
  it('marks what the automatic edit wrote until the next change', async () => {
    const view = editor();
    await typeText(view, 'R&');
    const marked = () => view.state.facet(EditorView.decorations).reduce((n, d) => n + (typeof d === 'function' ? 0 : d.size), 0);
    expect(marked()).toBe(1);
    await typeText(view, 'D');
    expect(marked()).toBe(0);
  });
});
