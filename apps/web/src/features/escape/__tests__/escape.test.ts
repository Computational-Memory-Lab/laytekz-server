import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, Text, type Extension } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import * as Y from 'yjs';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { latex } from 'codemirror-lang-latex';
import { undoBoundary } from '../../../editor/visual/history';
import { autoEditCore } from '../../../editor/core/autoEdit';
import { resetAutoEditNotices } from '../../../editor/core/notices';
import { contextAt } from '../../../editor/texContext';
import { headlessView, pressKey, typeText, type HeadlessView } from '../../../editor/core/__tests__/replay';
import { ESCAPE_RULES, escapedAt, percentFollowsNumber } from '../rules';
import { escapedPaste, pasteEscaped } from '../paste';
import { chipFor } from '../chip';
import { settings } from '../settings';
import feature from '../index';

const store = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock('../../../settings/store', () => ({
  getSetting: (id: string) => store.values.get(id),
  setSetting: (id: string, v: unknown) => { store.values.set(id, v); },
  resetSetting: () => {},
  subscribeSetting: () => () => {},
  useSetting: () => [true, () => {}],
}));

const language = latex({ autoCloseTags: false, enableLinting: false, enableAutocomplete: false, enableTooltips: false });
const DOC_HEAD = '\\documentclass{article}\n\\begin{document}\n';
const DOC_TAIL = '\n\\end{document}\n';

/** An editor whose document is `before¦after`, caret at ¦, with the escape rules installed. */
function editor(around: string, extensions: Extension[] = []): HeadlessView {
  const mark = around.indexOf('¦');
  const doc = around.replace('¦', '');
  const view = headlessView({ doc, selection: EditorSelection.cursor(mark), extensions: [language, autoEditCore(ESCAPE_RULES), ...extensions] });
  ensureSyntaxTree(view.state, doc.length, 5_000);
  return view;
}

const inBody = (s: string) => `${DOC_HEAD}${s}${DOC_TAIL}`;
const body = (v: HeadlessView) => v.state.doc.toString().slice(DOC_HEAD.length, -DOC_TAIL.length);

/** A parsed state of `src` with ¦ as the position. */
function at(src: string): { state: EditorState; pos: number } {
  const pos = src.indexOf('¦');
  const doc = src.replace('¦', '');
  const state = EditorState.create({ doc, extensions: [language] });
  ensureSyntaxTree(state, doc.length, 5_000);
  return { state, pos };
}

beforeEach(() => {
  store.values.clear();
  resetAutoEditNotices();
});

describe('typing & % #', () => {
  it('stores R\\&D grew 50\\% for R&D grew 50% in text', async () => {
    const v = editor(inBody('¦'));
    await typeText(v, 'R&D grew 50% ');
    expect(body(v)).toBe('R\\&D grew 50\\% ');
  });

  it('keeps & raw at the top level of a table cell and in math', async () => {
    const t = editor(inBody('\\begin{tabular}{ll}\n¦\n\\end{tabular}'));
    await typeText(t, 'a & b \\\\');
    expect(body(t)).toBe('\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}');
    const m = editor(inBody('\\begin{align}\n¦\n\\end{align}'));
    await typeText(m, 'x &= 1');
    expect(body(m)).toBe('\\begin{align}\nx &= 1\n\\end{align}');
  });

  it('escapes & inside a brace group in a table cell', async () => {
    const v = editor(inBody('\\begin{tabular}{ll}\n\\multicolumn{2}{c}{R¦} \\\\\n\\end{tabular}'));
    await typeText(v, '&D');
    expect(body(v)).toContain('\\multicolumn{2}{c}{R\\&D}');
  });

  it('leaves 50 %, }% and word% raw (they start comments)', async () => {
    const v = editor(inBody('¦'));
    await typeText(v, '50 %');
    expect(body(v)).toBe('50 %');
    const w = editor(inBody('\\textbf{x}¦'));
    await typeText(w, '%');
    expect(body(w)).toBe('\\textbf{x}%');
    const x = editor(inBody('word¦'));
    await typeText(x, '%');
    expect(body(x)).toBe('word%');
  });

  it('escapes # in text and math, never in a definition or a URL', async () => {
    const v = editor(inBody('¦'));
    await typeText(v, 'item #1');
    expect(body(v)).toBe('item \\#1');
    const d = editor('\\documentclass{article}\n\\newcommand{\\x}[1]{¦}\n\\begin{document}\n\\end{document}\n');
    await typeText(d, '#1');
    expect(d.state.doc.toString()).toContain('\\newcommand{\\x}[1]{#1}');
    const u = editor(inBody('\\url{http://a.org/¦}'));
    await typeText(u, '#top');
    expect(body(u)).toBe('\\url{http://a.org/#top}');
  });

  it('does nothing after a backslash typed by hand, or in a comment', async () => {
    const v = editor(inBody('¦'));
    await typeText(v, 'R\\&D 5\\% \\#');
    expect(body(v)).toBe('R\\&D 5\\% \\#');
    const c = editor(inBody('% note ¦'));
    await typeText(c, 'R&D 50% #1');
    expect(body(c)).toBe('% note R&D 50% #1');
  });

  it('gives back a plain & on Backspace right after the escape', async () => {
    const v = editor(inBody('¦'));
    await typeText(v, 'R&');
    expect(body(v)).toBe('R\\&');
    expect(await pressKey(v, 'Backspace')).toBe(true);
    expect(body(v)).toBe('R&');
  });

  it('stores input exactly as typed with the switches off', async () => {
    for (const s of settings) store.values.set(s.id, false);
    const v = editor(inBody('¦'));
    await typeText(v, 'R&D grew 50% #1');
    expect(body(v)).toBe('R&D grew 50% #1');
  });

  it('turns each character off on its own', async () => {
    store.values.set('escape.amp', false);
    const v = editor(inBody('¦'));
    await typeText(v, 'R&D 50%');
    expect(body(v)).toBe('R&D 50\\%');
  });
});

describe('% after a number', () => {
  const t = (s: string) => percentFollowsNumber(Text.of([s]), s.length);
  it('accepts plain numbers, decimals, thousands and a thin space', () => {
    for (const s of ['50', 'grew 3.5', 'of 1,000', 'about 12\\,', '(50', '-5']) expect(t(s), s).toBe(true);
  });
  it('refuses control-word arguments, key-value pairs and non-numbers', () => {
    for (const s of ['\\penalty10000', '\\kern-3', 'width=50', 'word', '}', '50 ', '\\\\,', '']) expect(t(s), s).toBe(false);
  });
  it('counts backslashes before a character', () => {
    expect(escapedAt(Text.of(['a\\']), 2)).toBe(true);
    expect(escapedAt(Text.of(['a\\\\']), 3)).toBe(false);
  });
});

describe('pasting plain text in Source mode', () => {
  const prose = 'Q&A: 30% off, $5 #1';
  it('escapes prose in text', () => {
    const { state, pos } = at(inBody('¦'));
    expect(escapedPaste(state, pos, prose)).toBe('Q\\&A: 30\\% off, \\$5 \\#1');
  });

  it('keeps & raw at the top level of a table cell', () => {
    const { state, pos } = at(inBody('\\begin{tabular}{ll}\n¦\n\\end{tabular}'));
    expect(contextAt(state, pos)?.kind).toBe('table');
    expect(escapedPaste(state, pos, 'R&D & 50%')).toBe('R&D & 50\\%');
  });

  it('pastes as copied in math, comments, and when it already looks like LaTeX', () => {
    const math = at(inBody('$x¦$'));
    expect(escapedPaste(math.state, math.pos, prose)).toBeNull();
    const comment = at(inBody('% ¦'));
    expect(escapedPaste(comment.state, comment.pos, prose)).toBeNull();
    const text = at(inBody('¦'));
    expect(escapedPaste(text.state, text.pos, 'see \\cite{knuth} and $x^2$')).toBeNull();
  });

  it('pastes as copied first, then escapes as a step Backspace reverts', async () => {
    const v = editor(inBody('¦'));
    pasteEscaped(v.asView(), prose, escapedPaste(v.state, v.state.selection.main.head, prose)!);
    expect(body(v)).toBe('Q\\&A: 30\\% off, \\$5 \\#1');
    expect(v.log.filter((tr) => tr.docChanged).length).toBe(2);
    expect(await pressKey(v, 'Backspace')).toBe(true);
    expect(body(v)).toBe(prose);
  });
});

describe('the context chip', () => {
  it('names the context at the cursor', () => {
    const label = (src: string) => { const { state, pos } = at(src); return chipFor(contextAt(state, pos))?.label; };
    expect(label(inBody('Some ¦text'))).toBe('Text');
    expect(label(inBody('$x¦$'))).toBe('Math');
    expect(label(inBody('% ¦'))).toBe('Comment');
    expect(label(inBody('\\begin{tabular}{ll}\na & ¦b\n\\end{tabular}'))).toMatch(/^Table/);
    expect(label(inBody('\\url{http://¦}'))).toMatch(/^Literal/);
    expect(chipFor(null)).toBeNull();
  });
});

describe('the module', () => {
  it('registers its rules, its switches, the chip and the raw-paste chord', () => {
    expect(feature.editor?.autoEditRules?.map((r) => r.settingId)).toEqual(['escape.amp', 'escape.percent', 'escape.hash']);
    const ids = settings.map((s) => s.id);
    for (const r of ESCAPE_RULES) expect(ids).toContain(r.settingId);
    expect(ids).toEqual(expect.arrayContaining(['escape.paste', 'escape.chip']));
    for (const s of settings) expect(s.id.startsWith('escape.')).toBe(true);
    expect(feature.keybindings?.[0]).toMatchObject({ id: 'escape.pasteRaw', default: { mod: true, shift: true, alt: false, key: 'v' }, scope: 'editor' });
    expect(feature.slots?.[0]).toMatchObject({ slot: 'editor.status' });
  });
});

describe('with two collaborators', () => {
  function peer(ydoc: Y.Doc) {
    const ytext = ydoc.getText('t');
    const undoManager = new Y.UndoManager(ytext);
    const collab = yCollab(ytext, null, { undoManager });
    const view = headlessView({
      doc: ytext.toString(),
      extensions: [language, collab, undoBoundary.of(() => undoManager.stopCapturing()), autoEditCore(ESCAPE_RULES)],
    }, collab);
    const undo = () => yUndoManagerKeymap.find((b) => b.key === 'Mod-z')!.run!(view.asView());
    return { view, undo, ytext };
  }

  it("B's undo leaves A's \\& alone, B's edits never trigger an escape on A, and one undo reverts only the escape", async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(docB, u, 'remote'); });
    docB.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(docA, u, 'remote'); });
    const a = peer(docA);
    const b = peer(docB);
    await typeText(a.view, 'R&D');
    expect(b.ytext.toString()).toBe('R\\&D');
    await typeText(b.view, 'x');
    b.undo();
    expect(a.ytext.toString()).toBe('R\\&D');
    expect(b.ytext.toString()).toBe('R\\&D');
    // A remote & arrives as a change, never as typing, so A's rules stay quiet.
    b.view.dispatch({ changes: { from: 0, insert: 'Q&A ' } });
    expect(a.ytext.toString()).toBe('Q&A R\\&D');
  });

  it('one undo reverts only the escape and keeps what was typed', async () => {
    const a = peer(new Y.Doc());
    await typeText(a.view, 'R&');
    expect(a.ytext.toString()).toBe('R\\&');
    a.undo();
    expect(a.ytext.toString()).toBe('R&');
  });
});
