import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, type Extension } from '@codemirror/state';
import { closeBrackets, CompletionContext, type Completion, type CompletionResult } from '@codemirror/autocomplete';
import { latex } from 'codemirror-lang-latex';
import * as Y from 'yjs';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { latexCloseBrackets } from '../../../editor/latexExtras';
import { beginBraceExtensions, closerAt, closerField } from '../../../editor/core/brackets';
import { latexNewlineIndent } from '../../../editor/newlineIndent';
import { keyChains } from '../../../editor/core/keyChains';
import { autoEditCore } from '../../../editor/core/autoEdit';
import { undoBoundary } from '../../../editor/visual/history';
import { headlessView, pressKey, typeText, withCaret, type HeadlessView } from '../../../editor/core/__tests__/replay';
import feature, { envCloseExtension } from '../index';
import { closeRule } from '../close';
import { envCompletionFilter, envNameApply } from '../completion';
import { partnerDecorations } from '../envSync';
import { settings, ENVCLOSE_SETTINGS } from '../settings';

vi.mock('../../../settings/store', () => ({ getSetting: () => undefined, setSetting: () => {}, subscribeSetting: () => () => {} }));

type Cfg = { close: boolean; linked: boolean; tabStops: boolean; visual: boolean };
const ALL: Cfg = { close: true, linked: true, tabStops: true, visual: false };
const language = latex({ autoCloseTags: false, enableLinting: false, enableAutocomplete: false, enableTooltips: false });

function parts(src: string): { doc: string; head: number } {
  const mark = src.indexOf('|');
  return { doc: mark < 0 ? src : src.slice(0, mark) + src.slice(mark + 1), head: mark < 0 ? src.replace('|', '').length : mark };
}

function base(cfg: Cfg): Extension[] {
  return [
    language,
    latexNewlineIndent,
    closeBrackets(),
    latexCloseBrackets('main.tex'),
    beginBraceExtensions(),
    envCloseExtension(cfg),
    autoEditCore([closeRule]),
    ...(feature.editor!.keyChains ?? []).map((e) => keyChains.of(e)),
  ];
}

function editor(src = '', cfg: Cfg = ALL, extra: Extension[] = []): HeadlessView {
  const { doc, head } = parts(src);
  return headlessView({ doc, selection: EditorSelection.cursor(head), extensions: [...base(cfg), ...extra] });
}

async function typed(text: string, src = '', cfg: Cfg = ALL): Promise<string> {
  const v = editor(src, cfg);
  await typeText(v, text);
  return withCaret(v);
}

const count = (s: string, sub: string) => s.split(sub).length - 1;

describe('closing an environment with }', () => {
  it('adds the \\end block once, caret on the body line', async () => {
    expect(await typed('\\begin{itemize}')).toBe('\\begin{itemize}\n  |\n\\end{itemize}');
    expect(await typed('\\begin{enumerate}', '  ')).toBe('  \\begin{enumerate}\n    |\n  \\end{enumerate}');
  });

  it('adds nothing when the \\end is already there', async () => {
    const src = '\\begin{document}\n|\n  \\item a\n\\end{itemize}\n\\end{document}';
    const out = await typed('\\begin{itemize}', src);
    expect(out).toBe('\\begin{document}\n\\begin{itemize}|\n  \\item a\n\\end{itemize}\n\\end{document}');
  });

  it('closes a nested environment of the same name', async () => {
    const out = await typed('\\begin{itemize}', '\\begin{itemize}\n  \\item a\n  |\n\\end{itemize}');
    expect(out).toBe('\\begin{itemize}\n  \\item a\n  \\begin{itemize}\n    |\n  \\end{itemize}\n\\end{itemize}');
  });

  it('closes a new environment typed before another one\'s \\end', async () => {
    const out = await typed('\\begin{center}', '\\begin{document}\n|\n\\end{document}');
    expect(out).toBe('\\begin{document}\n\\begin{center}\n  |\n\\end{center}\n\\end{document}');
  });

  it('never closes in a comment or in verbatim', async () => {
    expect(await typed('% \\begin{itemize}')).toBe('% \\begin{itemize}|');
    expect(await typed('\\begin{x}', '\\begin{verbatim}\n|\n\\end{verbatim}')).toBe('\\begin{verbatim}\n\\begin{x}|\n\\end{verbatim}');
  });

  it('is one automatic edit between two undo boundaries, and Backspace right after reverts it', async () => {
    const boundary = vi.fn();
    const v = editor('', ALL, [undoBoundary.of(boundary)]);
    await typeText(v, '\\begin{itemize}');
    expect(boundary).toHaveBeenCalledTimes(2);
    const last = v.log[v.log.length - 1];
    expect(last.isUserEvent('input.auto')).toBe(true);
    let inserted = '';
    last.changes.iterChanges((_fa, _ta, _fb, _tb, text) => { inserted += text.toString(); });
    expect(inserted).toBe('\n  \n\\end{itemize}');
    await pressKey(v, 'Backspace');
    expect(withCaret(v)).toBe('\\begin{itemize}|');
  });

  it('switched off, adds nothing (and Version 1\'s brace handler stands aside)', async () => {
    expect(await typed('\\begin{itemize}', '', { ...ALL, close: false })).toBe('\\begin{itemize}|');
  });

  it('an argument environment waits in {¦}: } steps over it and Enter moves into the body', async () => {
    const v = editor('', ALL, [closerField]);
    await typeText(v, '\\begin{tabular}');
    expect(withCaret(v)).toBe('\\begin{tabular}{|}\n  \n\\end{tabular}');
    expect(closerAt(v.state, v.state.selection.main.head)?.text).toBe('}');
    await typeText(v, 'lr}');
    expect(withCaret(v)).toBe('\\begin{tabular}{lr}|\n  \n\\end{tabular}');
    await pressKey(v, 'Enter');
    expect(withCaret(v)).toBe('\\begin{tabular}{lr}\n  |\n\\end{tabular}');
  });
});

describe('Enter at the end of a \\begin line', () => {
  it('adds no second \\end to an environment that has one', async () => {
    const v = editor('\\begin{itemize}|\n  \\item a\n\\end{itemize}');
    await pressKey(v, 'Enter');
    expect(count(v.state.doc.toString(), '\\end{itemize}')).toBe(1);
  });

  it('closes a new one: the line break, then the \\end line as its own step', async () => {
    const v = editor('\\begin{figure}[ht]|');
    await pressKey(v, 'Enter');
    expect(withCaret(v)).toBe('\\begin{figure}[ht]\n  |\n\\end{figure}');
    expect(v.log[v.log.length - 1].isUserEvent('input.auto')).toBe(true);
    await pressKey(v, 'Backspace');
    expect(withCaret(v)).toBe('\\begin{figure}[ht]\n  |');
  });

  it('leaves Enter alone in Visual mode', async () => {
    const v = editor('\\begin{itemize}|', { ...ALL, visual: true });
    await pressKey(v, 'Enter');
    expect(v.state.doc.toString()).not.toContain('\\end');
  });
});

describe('linked \\begin and \\end names', () => {
  const ENV = '\\begin{itemize}\n  \\item a\n\\end{itemize}';

  it('renaming the \\begin renames the \\end, each keystroke one transaction', async () => {
    const v = editor(ENV.replace('itemize}', 'itemize|}'));
    for (let i = 0; i < 'itemize'.length; i++) await pressKey(v, 'Backspace');
    const before = v.log.length;
    await typeText(v, 'enumerate');
    expect(v.state.doc.toString()).toBe('\\begin{enumerate}\n  \\item a\n\\end{enumerate}');
    expect(v.log.length - before).toBe('enumerate'.length);
  });

  it('renaming the \\end renames the \\begin', async () => {
    const v = editor('\\begin{itemize}\n  \\item a\n\\end{item|ize}');
    await typeText(v, 'x');
    expect(v.state.doc.toString()).toBe('\\begin{itemxize}\n  \\item a\n\\end{itemxize}');
  });

  it('follows nesting and skips comments', async () => {
    const src = '\\begin{itemize|}\n  \\begin{itemize}\n  % \\end{itemize}\n  \\end{itemize}\n\\end{itemize}';
    const v = editor(src);
    await typeText(v, 'x');
    expect(v.state.doc.toString()).toBe('\\begin{itemizex}\n  \\begin{itemize}\n  % \\end{itemize}\n  \\end{itemize}\n\\end{itemizex}');
  });

  it('leaves names that already differed, changes without a user event, and the switch off', async () => {
    const v = editor('\\begin{itemize|}\n\\end{enumerate}');
    await typeText(v, 'x');
    expect(v.state.doc.toString()).toBe('\\begin{itemizex}\n\\end{enumerate}');

    const r = editor(ENV);
    r.dispatch({ changes: { from: '\\begin{item'.length, insert: 'x' } });
    expect(r.state.doc.toString()).toBe(ENV.replace('item', 'itemx'));

    const off = editor(ENV.replace('itemize}', 'itemize|}'), { ...ALL, linked: false });
    await typeText(off, 'x');
    expect(off.state.doc.toString()).toBe('\\begin{itemizex}\n  \\item a\n\\end{itemize}');
  });

  it('outlines the partner while the caret is in a name', () => {
    const v = editor(ENV.replace('{itemize}', '{ite|mize}'));
    const ranges: [number, number][] = [];
    partnerDecorations(v.state).between(0, v.state.doc.length, (from, to) => { ranges.push([from, to]); });
    const endName = ENV.lastIndexOf('itemize');
    expect(ranges).toEqual([[endName, endName + 'itemize'.length]]);
  });
});

describe('completions', () => {
  function result(v: HeadlessView, options: Completion[], from: number): CompletionResult {
    return envCompletionFilter({ from, options }, new CompletionContext(v.state, v.state.selection.main.head, false));
  }
  const accept = (v: HeadlessView, r: CompletionResult, label: string) => {
    const o = r.options.find((x) => x.label === label)!;
    (o.apply as (...a: unknown[]) => void)(v.asView(), o, r.from, v.state.selection.main.head);
  };

  it('a new environment name closes the environment', async () => {
    const v = editor();
    await typeText(v, '\\begin{ite');
    accept(v, result(v, [{ label: 'itemize', type: 'class' }], '\\begin{'.length), 'itemize');
    expect(withCaret(v)).toBe('\\begin{itemize}\n  |\n\\end{itemize}');
  });

  it('a name accepted inside an existing pair replaces the name and its partner follows', async () => {
    const w = editor('\\begin{enu|}\n  \\item a\n\\end{enu}');
    accept(w, result(w, [{ label: 'enumerate', type: 'class' }], '\\begin{'.length), 'enumerate');
    expect(w.state.doc.toString()).toBe('\\begin{enumerate}\n  \\item a\n\\end{enumerate}');
  });

  it('after \\end{, the innermost open environment comes first', () => {
    const v = editor('\\begin{document}\n\\begin{center}\n\\end{|}');
    const r = result(v, [{ label: 'itemize', type: 'class' }, { label: 'center', type: 'class' }], v.state.selection.main.head);
    expect(r.options.find((o) => o.label === 'center')!.boost).toBe(99);
    const custom = editor('\\begin{myenv}\n\\end{|}');
    expect(result(custom, [{ label: 'itemize', type: 'class' }], custom.state.selection.main.head).options[0].label).toBe('myenv');
  });

  it('a command with several arguments gets tab stops', async () => {
    const v = editor();
    await typeText(v, '$\\fr');
    const r = result(v, [{ label: '\\frac', type: 'function' }], 1);
    accept(v, r, '\\frac');
    expect(withCaret(v)).toMatch(/^\$\\frac\{\|\}\{\}/);
    await typeText(v, 'a');
    await pressKey(v, 'Tab');
    expect(withCaret(v)).toMatch(/^\$\\frac\{a\}\{\|\}/);
    await typeText(v, 'b');
    await pressKey(v, 'Tab');
    expect(withCaret(v)).toMatch(/^\$\\frac\{a\}\{b\}\|/);
  });

  it('tab stops switched off leave the command as it was', async () => {
    const v = editor('', { ...ALL, tabStops: false });
    await typeText(v, '\\fr');
    const o: Completion = { label: '\\frac', type: 'function' };
    expect(result(v, [o], 0).options[0]).toBe(o);
  });

  it('envNameApply keeps the brace that follows', async () => {
    const v = editor('\\end{ite|}');
    envNameApply('itemize', 'end')(v.asView(), { label: 'itemize' }, '\\end{'.length, v.state.selection.main.head);
    expect(withCaret(v)).toBe('\\end{itemize}|');
  });
});

describe('with a real Y.UndoManager', () => {
  function peer(ydoc: Y.Doc) {
    const ytext = ydoc.getText('t');
    const undoManager = new Y.UndoManager(ytext);
    const collab = yCollab(ytext, null, { undoManager });
    const view = headlessView({ doc: ytext.toString(), extensions: [collab, undoBoundary.of(() => undoManager.stopCapturing()), ...base(ALL)] }, collab);
    const undo = () => yUndoManagerKeymap.find((b) => b.key === 'Mod-z')!.run!(view.asView());
    return { view, undo, ytext };
  }

  it('one undo removes only the \\end block', async () => {
    const a = peer(new Y.Doc());
    await typeText(a.view, '\\begin{itemize}');
    expect(a.ytext.toString()).toBe('\\begin{itemize}\n  \n\\end{itemize}');
    a.undo();
    expect(a.ytext.toString()).toBe('\\begin{itemize}');
  });

  it('a linked rename is one undo step, and a collaborator\'s copy is not mirrored again', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(docB, u, 'remote'); });
    docB.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(docA, u, 'remote'); });
    docA.getText('t').insert(0, '\\begin{itemize}\n\\end{itemize}');
    const a = peer(docA);
    const b = peer(docB);
    a.view.dispatch({ selection: { anchor: '\\begin{itemize'.length } });
    await typeText(a.view, 's');
    expect(b.ytext.toString()).toBe('\\begin{itemizes}\n\\end{itemizes}');
    expect(b.view.state.doc.toString()).toBe('\\begin{itemizes}\n\\end{itemizes}');
    a.undo();
    expect(b.ytext.toString()).toBe('\\begin{itemize}\n\\end{itemize}');
  });
});

describe('settings', () => {
  it('registers the three switches in the typing section', () => {
    expect(settings.map((s) => s.id)).toEqual([ENVCLOSE_SETTINGS.close, ENVCLOSE_SETTINGS.linked, ENVCLOSE_SETTINGS.tabStops]);
    expect(settings.every((s) => s.section === 'typing' && s.default === true)).toBe(true);
  });
});
