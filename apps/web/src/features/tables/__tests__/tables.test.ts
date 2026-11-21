import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { clearSnippet, nextSnippetField, prevSnippetField } from '@codemirror/autocomplete';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

const values: Record<string, unknown> = {};
vi.mock('../../../settings/store', () => ({
  getSetting: (id: string) => values[id],
  setSetting: (id: string, v: unknown) => { values[id] = v; },
  subscribeSetting: () => () => {},
  useSetting: () => [undefined, () => {}],
}));

import { latexLanguage } from '../../../editor/texContext/__tests__/helpers';
import { undoBoundary } from '../../../editor/visual/history';
import { insertTable, insertContext, peerCaretInside } from '../actions';
import { booktabsChange, loadsBooktabs, placement, preambleHere, snippetTemplate } from '../plan';
import { FIRST_SIZE, clampSize, keyStep, shownFor, sizeLabel, sizeWords } from '../picker';
import { tableTemplate } from '../../../editor/tables/insert';
import { settings } from '../settings';
import feature from '../index';

/** Enough of an EditorView: a state that each dispatch replaces, counting dispatches and undo boundaries. */
function fakeView(doc: string, anchor: number, head = anchor, extra: Extension[] = []) {
  let boundaries = 0;
  let state = EditorState.create({
    doc, selection: EditorSelection.single(anchor, head),
    extensions: [latexLanguage(), undoBoundary.of(() => { boundaries++; }), ...extra],
  });
  ensureSyntaxTree(state, doc.length, 5_000);
  const events: (string | undefined)[] = [];
  let dispatches = 0;
  const view = {
    get state() { return state; },
    dispatch(...specs: TransactionSpec[]) {
      const tr = state.update(...specs);
      dispatches++;
      events.push(specs.map((s) => s.userEvent).filter(Boolean).join(','));
      state = tr.state;
      ensureSyntaxTree(state, state.doc.length, 5_000);
    },
    focus() {},
  } as unknown as EditorView;
  const cmd = { get state() { return state; }, dispatch: (tr: { state: EditorState }) => { state = tr.state; } };
  return {
    view, events, cmd,
    doc: () => state.doc.toString(),
    sel: () => state.selection.main,
    dispatches: () => dispatches,
    boundaries: () => boundaries,
  };
}

const OPTS = { float: true, header: true, lines: 'hline' as const, align: 'l' as const, mode: 'source' as const };

describe('inserting a table (F4)', () => {
  it('puts a 2 × 2 float at the caret on a blank line, as one undo step, and Tab walks the cells, the caption, the label, then leaves', () => {
    const v = fakeView('Intro.\n\nEnd.', 7);
    const r = insertTable(v.view, { ...OPTS, cols: 2, rows: 2 });
    expect(r).toEqual({ ok: true, needsBooktabs: false });
    const table = [
      '\\begin{table}[htbp]',
      '  \\centering',
      '  \\caption{}',
      '  \\label{tab:}',
      '  \\begin{tabular}{ll}',
      '    \\hline',
      '     &  \\\\',
      '    \\hline',
      '     &  \\\\',
      '    \\hline',
      '  \\end{tabular}',
      '\\end{table}',
    ].join('\n');
    expect(v.doc()).toBe(`Intro.\n${table}\nEnd.`);
    expect(v.dispatches()).toBe(1);
    expect(v.boundaries()).toBe(2);
    expect(v.events).toEqual(['input.table']);
    const at = (s: string, from = 0) => v.doc().indexOf(s, from);
    const cell1 = at('    \\hline\n') + '    \\hline\n    '.length;
    expect(v.sel().head).toBe(cell1);
    const stops: number[] = [v.sel().head];
    for (let i = 0; i < 6; i++) { expect(nextSnippetField(v.cmd)).toBe(true); stops.push(v.sel().head); }
    expect(stops).toEqual([
      cell1, cell1 + 3, // row 1
      at('     &', cell1 + 5) + 4, at('     &', cell1 + 5) + 7, // row 2
      at('\\caption{') + '\\caption{'.length,
      at('\\label{tab:') + '\\label{tab:'.length,
      v.doc().length - 'End.'.length - 1, // after \end{table}
    ]);
    expect(nextSnippetField(v.cmd)).toBe(false);
  });

  it('types into the fields and keeps the text exact; Shift+Tab goes back; Escape ends the fields', () => {
    const v = fakeView('', 0);
    insertTable(v.view, { ...OPTS, cols: 2, rows: 1, float: false, lines: 'none' });
    v.view.dispatch({ changes: { from: v.sel().from, to: v.sel().to, insert: 'A' }, selection: { anchor: v.sel().from + 1 } });
    nextSnippetField(v.cmd);
    v.view.dispatch({ changes: { from: v.sel().from, to: v.sel().to, insert: 'B' }, selection: { anchor: v.sel().from + 1 } });
    expect(v.doc()).toBe('\\begin{tabular}{ll}\n  A & B \\\\\n\\end{tabular}');
    expect(prevSnippetField(v.cmd)).toBe(true);
    expect(clearSnippet(v.cmd)).toBe(true);
    expect(nextSnippetField(v.cmd)).toBe(false);
  });

  it('starts a float on its own line after a line with text, under that line\'s indentation, and never replaces a selection', () => {
    const doc = '  Some text here.\nNext.';
    const v = fakeView(doc, 4, 9);
    insertTable(v.view, { ...OPTS, cols: 1, rows: 1, lines: 'none', header: false });
    expect(v.doc()).toBe([
      '  Some text here.',
      '  \\begin{table}[htbp]',
      '    \\centering',
      '    \\caption{}',
      '    \\label{tab:}',
      '    \\begin{tabular}{l}',
      '       \\\\',
      '    \\end{tabular}',
      '  \\end{table}',
      'Next.',
    ].join('\n'));
  });

  it('adds \\usepackage{booktabs} in the same transaction when the preamble is in this file', () => {
    const doc = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\nText.\n\\end{document}\n';
    const v = fakeView(doc, doc.indexOf('\n\nText') + 1);
    expect(insertContext(v.view.state).autoLines).toBe('booktabs');
    const r = insertTable(v.view, { ...OPTS, cols: 2, rows: 2, lines: 'auto' });
    expect(r).toEqual({ ok: true, needsBooktabs: false });
    expect(v.dispatches()).toBe(1);
    expect(v.doc().startsWith('\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{booktabs}\n\\begin{document}\n\\begin{table}')).toBe(true);
    expect(v.doc()).toContain('\\toprule');
    // the first field still sits in the first cell, after the package line moved it down
    expect(v.doc().slice(v.sel().head - 5, v.sel().head)).toBe('\n    ');
    expect(v.doc().slice(v.sel().head, v.sel().head + 3)).toBe(' & ');
  });

  it('uses \\hline by default when the preamble is elsewhere, and says booktabs is missing when asked for it', () => {
    const v = fakeView('Text.\n\n', 7);
    expect(insertContext(v.view.state).autoLines).toBe('hline');
    expect(insertContext(v.view.state, true).autoLines).toBe('booktabs');
    const r = insertTable(v.view, { ...OPTS, cols: 1, rows: 1, lines: 'booktabs' });
    expect(r).toEqual({ ok: true, needsBooktabs: true });
    expect(v.doc()).not.toContain('usepackage');
    const w = fakeView('Text.\n\n', 7);
    expect(insertTable(w.view, { ...OPTS, cols: 1, rows: 1, lines: 'booktabs', rootLoadsBooktabs: true })).toEqual({ ok: true, needsBooktabs: false });
  });

  it('refuses inside a formula and in a read-only file; inside a tabular only a bare tabular goes in', () => {
    const math = fakeView('Text $x + y$ end.', 8);
    expect(insertTable(math.view, { ...OPTS, cols: 2, rows: 2 })).toEqual({ ok: false, reason: expect.stringContaining('formula') });
    expect(math.doc()).toBe('Text $x + y$ end.');
    const ro = fakeView('Text.', 0, 0, [EditorState.readOnly.of(true)]);
    expect(insertTable(ro.view, { ...OPTS, cols: 2, rows: 2 })).toEqual({ ok: false, reason: 'This file is read-only' });
    const doc = '\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}';
    const nested = fakeView(doc, doc.indexOf('b \\'));
    expect(insertContext(nested.view.state).floatRefusal).toBeTruthy();
    insertTable(nested.view, { ...OPTS, cols: 1, rows: 1, lines: 'none', header: false });
    expect(nested.doc()).not.toContain('\\begin{table}');
  });

  it('visual mode puts the caret after the table with no fields', () => {
    const v = fakeView('', 0);
    insertTable(v.view, { ...OPTS, cols: 1, rows: 1, mode: 'visual' });
    expect(v.sel().head).toBe(v.doc().length);
    expect(nextSnippetField(v.cmd)).toBe(false);
  });
});

describe('the pure helpers', () => {
  it('make a snippet template with numbered fields and a final stop', () => {
    const t = tableTemplate({ cols: 2, rows: 1, float: true, header: false, lines: 'none', align: 'c', indent: '', unit: '\t' });
    expect(snippetTemplate(t, true)).toBe('\n\\begin{table}[htbp]\n\t\\centering\n\t\\caption{${3}}\n\t\\label{tab:${4}}\n\t\\begin{tabular}{cc}\n\t\t${1} & ${2} \\\\\n\t\\end{tabular}\n\\end{table}${0}');
  });

  it('place a float after a line with text and at the caret on a blank line', () => {
    const s = EditorState.create({ doc: 'abc\n  \nd' });
    expect(placement(s, 1, true)).toEqual({ from: 3, newline: true });
    expect(placement(s, 6, true)).toEqual({ from: 6, newline: false });
    expect(placement(s, 1, false)).toEqual({ from: 1, newline: false });
  });

  it('find the preamble and the booktabs line', () => {
    expect(preambleHere('\\documentclass{a}\n\\begin{document}\n')).toBe(true);
    expect(preambleHere('% \\documentclass{a}\n\\begin{document}\n')).toBe(false);
    expect(preambleHere('Just a chapter.')).toBe(false);
    expect(booktabsChange('\\documentclass{a}\n\\begin{document}\nx')).toEqual({ from: 18, insert: '\\usepackage{booktabs}\n' });
    expect(booktabsChange('\\documentclass{a}\n\\usepackage{x}\n% \\usepackage{y}\n\\begin{document}')).toEqual({ from: 32, insert: '\n\\usepackage{booktabs}' });
    expect(booktabsChange('chapter')).toBeNull();
    expect(loadsBooktabs('\\usepackage[x]{array,booktabs}')).toBe(true);
    expect(loadsBooktabs('% \\usepackage{booktabs}')).toBe(false);
  });

  it('grow the picker grid with the pointer, clamp the keys, and name the size columns first', () => {
    expect(shownFor({ cols: 3, rows: 3 }, { cols: 8, rows: 8 })).toEqual({ cols: 8, rows: 8 });
    expect(shownFor({ cols: 8, rows: 8 }, { cols: 8, rows: 8 })).toEqual({ cols: 9, rows: 9 });
    expect(shownFor({ cols: 12, rows: 20 }, { cols: 12, rows: 20 })).toEqual({ cols: 12, rows: 20 });
    expect(shownFor({ cols: 8, rows: 3 }, { cols: 8, rows: 8 }, true)).toEqual({ cols: 8, rows: 8 });
    expect(keyStep(FIRST_SIZE, 'ArrowRight')).toEqual({ cols: 4, rows: 3 });
    expect(keyStep({ cols: 1, rows: 1 }, 'ArrowUp')).toEqual({ cols: 1, rows: 1 });
    expect(keyStep({ cols: 12, rows: 3 }, 'ArrowRight')).toEqual({ cols: 12, rows: 3 });
    expect(keyStep({ cols: 8, rows: 3 }, 'ArrowRight', true)).toEqual({ cols: 8, rows: 3 });
    expect(keyStep({ cols: 5, rows: 5 }, 'Home')).toEqual({ cols: 1, rows: 1 });
    expect(keyStep(FIRST_SIZE, 'Enter')).toBe('insert');
    expect(keyStep(FIRST_SIZE, ' ')).toBe('insert');
    expect(keyStep(FIRST_SIZE, 'a')).toBeNull();
    expect(clampSize({ cols: 40, rows: 0 })).toEqual({ cols: 12, rows: 1 });
    expect(sizeLabel({ cols: 4, rows: 3 })).toBe('4 × 3');
    expect(sizeWords({ cols: 4, rows: 1 })).toBe('4 columns, 1 row');
  });

  it('see a collaborator\'s focused caret inside a range', () => {
    const doc = new Y.Doc();
    const text = doc.getText('t');
    text.insert(0, 'abcdefghij');
    const aw = new Awareness(doc);
    const head = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 5));
    aw.states.set(4242, { cursor: { anchor: head, head } });
    expect(peerCaretInside(aw, doc, text, 3, 7)).toBe(true);
    expect(peerCaretInside(aw, doc, text, 6, 9)).toBe(false);
    aw.states.set(4242, { cursor: { anchor: head, head }, focused: false });
    expect(peerCaretInside(aw, doc, text, 3, 7)).toBe(false);
    aw.destroy();
  });
});

describe('the feature module', () => {
  it('declares its settings in the tables section with the automatic switch on by default', () => {
    expect(settings.every((s) => s.id.startsWith('tables.') && s.section === 'tables')).toBe(true);
    const keep = settings.find((s) => s.id === 'tables.keepAligned');
    expect(keep).toMatchObject({ default: true, automatic: true });
  });

  it('binds ⇧⌥A by key code in the editor, and the commands it runs exist', () => {
    expect(feature.keybindings).toEqual([expect.objectContaining({ id: 'tables.align', scope: 'editor', matchCode: true, command: 'tables.align' })]);
    const page = { view: () => null, activeFile: () => 'main.tex', toast: () => {} } as never;
    const ids = feature.commands!(page).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['tables.insert', 'tables.align', 'tables.alignAll', 'tables.op.rowBelow', 'tables.op.alignCenter']));
    expect(feature.slots?.[0]).toMatchObject({ slot: 'editor.tools', order: 100 });
  });

  it('realigns tables after Format document unless the setting is off', () => {
    const doc = 'x\n\\begin{tabular}{ll}\na & b \\\\\nccc & d \\\\\n\\end{tabular}\n';
    const state = EditorState.create({ doc, extensions: [latexLanguage()] });
    ensureSyntaxTree(state, doc.length, 5_000);
    const spec = feature.editor!.afterFormat!(state);
    expect(spec).toBeTruthy();
    expect(state.update({ changes: spec! }).state.doc.toString()).toBe(doc.replace('a & b', 'a   & b'));
    values['tables.formatAligns'] = false;
    expect(feature.editor!.afterFormat!(state)).toBeNull();
    delete values['tables.formatAligns'];
  });
});
