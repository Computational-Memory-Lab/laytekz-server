import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

vi.mock('../../../settings/store', () => ({ getSetting: () => undefined }));
vi.mock('../../../api', () => ({ api: {}, apiRequest: async () => null }));

import { insertLabelIn, referenceChange, takenLabels } from '../actions';
import { labelSuggestion } from '../labelCompletion';
import { NO_SETUP, type LabelDetail, type RefSetup } from '../refCommands';

const fig: LabelDetail = { label: 'fig:x', file: 'main.tex', kind: 'figure', env: 'figure' };
const tab: LabelDetail = { label: 'tab:y', file: 'main.tex', kind: 'table', env: 'table' };

/** The text after writing `labels` at the `|` (a selection between two `|`). */
function written(marked: string, labels: LabelDetail[], setup: RefSetup = NO_SETUP, o: { bare?: boolean; spacing?: boolean } = {}) {
  const a = marked.indexOf('|');
  const b = marked.indexOf('|', a + 1);
  const text = marked.replace(/\|/g, '');
  const state = EditorState.create({ doc: text, selection: b < 0 ? { anchor: a } : EditorSelection.single(a, b - 1) });
  const c = referenceChange(state, labels, setup, { style: 'auto', ...o })!;
  return text.slice(0, c.from) + c.insert + text.slice(c.to);
}

describe('writing a reference', () => {
  it('without cleveref writes Figure~\\ref{fig:x}, with a space after a word', () => {
    expect(written('as shown in|', [fig])).toBe('as shown in Figure~\\ref{fig:x}');
    expect(written('as shown in |', [fig])).toBe('as shown in Figure~\\ref{fig:x}');
  });

  it('turns an existing "Figure " into Figure~\\ref{}', () => {
    expect(written('as shown in Figure |', [fig])).toBe('as shown in Figure~\\ref{fig:x}');
    expect(written('as shown in fig.|', [fig])).toBe('as shown in fig.~\\ref{fig:x}');
    expect(written('as shown in Figure~|', [fig])).toBe('as shown in Figure~\\ref{fig:x}');
    expect(written('as shown in Figure |', [fig], { ...NO_SETUP, cleveref: true })).toBe('as shown in Figure~\\ref{fig:x}');
    expect(written('as shown in Figure |', [fig], NO_SETUP, { spacing: false })).toBe('as shown in Figure \\ref{fig:x}');
  });

  it('in apa7 with cleveref writes \\Cref, and Shift gives a bare \\ref', () => {
    const apa7 = { ...NO_SETUP, cleveref: true, documentClass: 'apa7' };
    expect(written('as shown in |', [fig, tab], apa7)).toBe('as shown in \\Cref{fig:x,tab:y}');
    expect(written('as shown in |', [fig], apa7, { bare: true })).toBe('as shown in \\ref{fig:x}');
    expect(written('Done. |', [fig], { ...NO_SETUP, cleveref: true })).toBe('Done. \\Cref{fig:x}');
  });

  it('replaces the selection', () => {
    expect(written('see |this| now', [fig])).toBe('see Figure~\\ref{fig:x} now');
  });
});

/** A view stand-in: enough for applyExplicitEdit and insertLabelIn. */
function fakeView(marked: string) {
  const text = marked.replace('|', '');
  let state = EditorState.create({ doc: text, selection: { anchor: marked.indexOf('|') } });
  const view = {
    get state() { return state; },
    dispatch(spec: TransactionSpec) { state = state.update(spec).state; },
    focus() {},
  };
  return view as unknown as EditorView & { state: EditorState };
}

describe('insert label here', () => {
  it('a label in a figure lands after the caption, with the slug selected and a toast', () => {
    const view = fakeView('\\begin{figure}\n|\\includegraphics{a.pdf}\n\\caption{Mean reaction times}\n\\end{figure}');
    const notify = vi.fn();
    expect(insertLabelIn(view, 'main.tex', [], notify)).toBe(true);
    const doc = view.state.doc.toString();
    expect(doc).toBe('\\begin{figure}\n\\includegraphics{a.pdf}\n\\caption{Mean reaction times}\\label{fig:mean-reaction-times}\n\\end{figure}');
    const sel = view.state.selection.main;
    expect(doc.slice(sel.from, sel.to)).toBe('mean-reaction-times');
    expect(notify).toHaveBeenCalledWith('The label goes after the caption, so it numbers the figure.', 'info');
  });

  it('avoids names used elsewhere in the project, and selects a label already there', () => {
    const view = fakeView('\\section{Method}|');
    insertLabelIn(view, 'main.tex', [{ label: 'sec:method', file: 'other.tex' }], vi.fn());
    expect(view.state.doc.toString()).toBe('\\section{Method}\\label{sec:method-2}');
    const notify = vi.fn();
    expect(insertLabelIn(view, 'main.tex', [], notify)).toBe(false);
    const sel = view.state.selection.main;
    expect(view.state.doc.toString().slice(sel.from, sel.to)).toBe('sec:method-2');
    expect(notify).toHaveBeenCalledWith('This section already has a label.', 'info');
  });

  it('the project\u2019s labels in this file come from the live text, not the index', () => {
    expect([...takenLabels('\\label{a}', [{ label: 'old', file: 'main.tex' }, { label: 'b', file: 'x.tex' }], 'main.tex')]).toEqual(['a', 'b']);
  });
});

describe('the \\label{ suggestion', () => {
  const suggest = (marked: string, taken: string[] = []) => {
    const text = marked.replace('|', '');
    const pos = marked.indexOf('|');
    const lineFrom = text.lastIndexOf('\n', pos - 1) + 1;
    const lineTo = text.indexOf('\n', pos);
    return labelSuggestion(text, pos, lineFrom, text.slice(lineFrom, lineTo < 0 ? text.length : lineTo), new Set(taken));
  };

  it('offers the name for an empty or matching argument only', () => {
    expect(suggest('\\section{Results}\n\\label{|}')).toEqual({ from: 25, name: 'sec:results' });
    expect(suggest('\\section{Results}\n\\label{sec:r|}')?.name).toBe('sec:results');
    expect(suggest('\\section{Results}\n\\label{x|}')).toBeNull();
    expect(suggest('\\section{Results}\n\\label{sec:results|}')).toBeNull();
    expect(suggest('\\section{Results}\n\\ref{|}')).toBeNull();
  });

  it('does not count the label being typed as taken', () => {
    expect(suggest('\\section{Results}\n\\label{sec:|}', ['sec:', 'sec:results'])?.name).toBe('sec:results-2');
  });
});
