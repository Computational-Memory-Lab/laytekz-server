import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { latexLanguage } from '../../texContext/__tests__/helpers';
import { alignAllTablesCommand, alignTableCommand, runTableOp, tableOpProblem } from '../commands';
import { marksTable } from '../keepAligned';

/** Enough of an EditorView for the commands: a state that each dispatch replaces. */
function fakeView(doc: string, cursor: number) {
  let state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [latexLanguage()] });
  ensureSyntaxTree(state, doc.length, 5_000);
  const events: string[] = [];
  const view = {
    get state() { return state; },
    dispatch(spec: TransactionSpec) {
      const tr = state.update(spec);
      if (spec.userEvent) events.push(spec.userEvent);
      state = tr.state;
      ensureSyntaxTree(state, state.doc.length, 5_000);
    },
  } as unknown as EditorView;
  return { view, events, doc: () => state.doc.toString(), head: () => state.selection.main.head };
}

const DOC = 'Text.\n\\begin{tabular}{ll}\na & b \\\\\nccc & d \\\\\n\\end{tabular}\nEnd.';

describe('the table commands (F4)', () => {
  it('aligns the table at the cursor as one input.align edit, then says it is already aligned', () => {
    const v = fakeView(DOC, DOC.indexOf('ccc'));
    expect(alignTableCommand(v.view)).toBe('aligned');
    expect(v.doc()).toBe(DOC.replace('a & b', 'a   & b'));
    expect(v.events).toEqual(['input.align']);
    expect(alignTableCommand(v.view)).toBe('already');
    expect(fakeView(DOC, 2).view && alignTableCommand(fakeView(DOC, 2).view)).toBe('none');
    const all = fakeView(DOC, 0);
    expect(alignAllTablesCommand(all.view)).toBe('aligned');
    expect(alignAllTablesCommand(all.view)).toBe('alreadyAll');
    expect(alignAllTablesCommand(fakeView('No tables.', 0).view)).toBe('noTables');
  });

  it('runs a row or column operation on the cell at the cursor in Source mode', () => {
    const v = fakeView(DOC, DOC.indexOf('ccc') + 1);
    expect(tableOpProblem(v.view, 'rowDown')).toBe('This is the table\'s last row.');
    expect(runTableOp(v.view, 'rowUp')).toBe(true);
    expect(v.doc()).toBe(DOC.replace('a & b \\\\\nccc & d', 'ccc & d \\\\\na & b'));
    expect(v.doc().slice(v.head(), v.head() + 3)).toBe('ccc');
    expect(tableOpProblem(fakeView(DOC, 2).view, 'rowUp')).toMatch(/in a table/);
  });
});

describe('what starts keep-aligned', () => {
  it('only the person\'s own typing and deleting', () => {
    const s = EditorState.create({ doc: 'abc' });
    const tr = (userEvent?: string) => s.update({ changes: { from: 1, insert: 'x' }, ...(userEvent ? { userEvent } : {}) });
    expect(marksTable(tr('input.type'))).toBe(true);
    expect(marksTable(tr('delete.backward'))).toBe(true);
    expect(marksTable(tr('input.paste'))).toBe(true);
    expect(marksTable(tr())).toBe(false); // a collaborator's edit, or Yjs undo
    expect(marksTable(tr('input.align'))).toBe(false);
    expect(marksTable(tr('input.format'))).toBe(false);
    expect(marksTable(tr('input.visual'))).toBe(false);
    expect(marksTable(tr('input.auto'))).toBe(false);
    expect(marksTable(tr('undo'))).toBe(false);
    expect(marksTable(s.update({ selection: { anchor: 1 }, userEvent: 'select' }))).toBe(false);
  });
});
