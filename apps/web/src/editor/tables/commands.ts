import type { EditorView } from '@codemirror/view';
import { applyExplicitEdit } from '../core/autoEdit';
import { tableEdit, unavailable } from '../visual/tableEdit';
import type { TableOp } from '../visual/tableEdit';
import { alignTableAt, alignTablesIn, cellAt, tableAt, tablesIn } from './locate';
import type { AlignOptions, Change } from './align';

/**
 * The table commands as editor actions, for the feature module (WP18) to
 * put in the palette, the table button and the ⇧⌥A keybinding. Each one is
 * one undo step of its own (`applyExplicitEdit`), with a userEvent that
 * keep-aligned and the auto-edit core ignore.
 */

export const ALIGN_EVENT = 'input.align';

/** What the align command says when it changes nothing. */
export const ALIGN_MESSAGES = {
  none: 'Put the cursor in a table to align its columns',
  already: 'This table is already aligned',
  alreadyAll: 'The tables are already aligned',
  noTables: 'This file has no tables to align',
} as const;

export type AlignOutcome = 'aligned' | keyof typeof ALIGN_MESSAGES;

function dispatchChanges(view: EditorView, changes: Change[], userEvent: string) {
  applyExplicitEdit(view, { changes: changes.map((c) => ({ from: c.from, to: c.to, insert: c.insert })), scrollIntoView: false }, userEvent);
}

/**
 * "Align table columns": the table at the cursor, or every table the
 * selection touches. Returns what happened, so the caller can say why
 * nothing changed (ALIGN_MESSAGES).
 */
export function alignTableCommand(view: EditorView, opts: AlignOptions = {}): AlignOutcome {
  const { state } = view;
  const sel = state.selection.main;
  const around = tableAt(state, sel.head);
  if (sel.empty || !tablesIn(state, sel.from, sel.to).length) {
    const changes = alignTableAt(state, sel.head, opts);
    if (!changes) return 'none';
    if (!changes.length) return 'already';
    dispatchChanges(view, changes, ALIGN_EVENT);
    return 'aligned';
  }
  const from = around ? Math.min(around.from, sel.from) : sel.from;
  const changes = alignTablesIn(state, opts, from, sel.to);
  if (!changes.length) return 'already';
  dispatchChanges(view, changes, ALIGN_EVENT);
  return 'aligned';
}

/** "Align all tables in this file". */
export function alignAllTablesCommand(view: EditorView, opts: AlignOptions = {}): AlignOutcome {
  if (!tablesIn(view.state).length) return 'noTables';
  const changes = alignTablesIn(view.state, opts);
  if (!changes.length) return 'alreadyAll';
  dispatchChanges(view, changes, ALIGN_EVENT);
  return 'aligned';
}

/** Why `op` cannot run on the cell at the cursor (Source mode), or null when it can. */
export function tableOpProblem(view: EditorView, op: TableOp): string | null {
  const t = tableAt(view.state, view.state.selection.main.head);
  if (!t) return 'Put the cursor in a table first.';
  const cell = cellAt(t.model, view.state.selection.main.head - t.from);
  if (!cell) return 'Put the cursor in a cell of the table first.';
  return unavailable(t.model, op, cell.r, cell.c);
}

/**
 * A row or column operation on the cell at the cursor, in Source mode; the
 * caret then goes to the start of the cell the operation names. False when
 * it is unavailable (tableOpProblem says why).
 */
export function runTableOp(view: EditorView, op: TableOp): boolean {
  const { state } = view;
  const t = tableAt(state, state.selection.main.head);
  const cell = t && cellAt(t.model, state.selection.main.head - t.from);
  const edit = t && cell ? tableEdit(t.model, t.src, op, cell.r, cell.c) : null;
  if (!t || !edit) return false;
  dispatchChanges(view, edit.changes.map((c) => ({ from: t.from + c.from, to: t.from + c.to, insert: c.insert })), 'input.table');
  // the caret goes to the focused cell of the table as it is now
  const now = tableAt(view.state, t.from + 1);
  const row = now?.model.rows[edit.focus.r];
  if (now && row) {
    let g = 0;
    const target = row.find((c) => { const hit = g + (c.multi?.span ?? 1) > edit.focus.g; g += c.multi?.span ?? 1; return hit; }) ?? row[row.length - 1];
    view.dispatch({ selection: { anchor: now.from + target.from }, scrollIntoView: true });
  }
  return true;
}
