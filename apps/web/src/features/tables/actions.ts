import { snippet } from '@codemirror/autocomplete';
import { EditorSelection } from '@codemirror/state';
import type { ChangeSpec, EditorState, TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { contextAt, documentPackages } from '../../editor/texContext';
import { defaultRuleStyle, floatRefusal, insertRefusal, needsPackage, tableTemplate } from '../../editor/tables/insert';
import type { RuleStyle } from '../../editor/tables/insert';
import { undoBoundary } from '../../editor/visual/history';
import { openTableCellAt } from '../../editor/visual/widgets/table';
import { booktabsChange, placement, preambleHere, snippetTemplate } from './plan';
import type { ColumnAlign, LinesChoice } from './settings';

/** The userEvent of an inserted table: keep-aligned and the automatic edits leave it alone. */
export const INSERT_EVENT = 'input.table';

/** What the picker knows about the caret before a table goes in. */
export interface InsertContext {
  /** why no table can go here (a formula, a comment, verbatim, a read-only file), or null */
  refusal: string | null;
  /** why only a bare tabular can go here (inside a float or a table), or null */
  floatRefusal: string | null;
  /** the rule style 'auto' stands for here */
  autoLines: RuleStyle;
  /** this file holds the preamble */
  preambleHere: boolean;
  /** booktabs is loaded (here, or in the main file's preamble when it was read) */
  booktabs: boolean;
}

export function insertContext(state: EditorState, rootLoadsBooktabs: boolean | null = null): InsertContext {
  const pos = state.selection.main.head;
  const ctx = contextAt(state, pos);
  const here = preambleHere(state.doc.sliceString(0, Math.min(state.doc.length, 200_000)));
  const packages = new Set(documentPackages(state));
  if (!here && rootLoadsBooktabs) packages.add('booktabs');
  return {
    refusal: state.readOnly ? 'This file is read-only' : insertRefusal(ctx),
    floatRefusal: floatRefusal(ctx),
    autoLines: defaultRuleStyle(packages, here),
    preambleHere: here,
    booktabs: packages.has('booktabs'),
  };
}

export interface InsertOptions {
  cols: number;
  rows: number;
  float: boolean;
  header: boolean;
  lines: LinesChoice;
  align: ColumnAlign;
  mode: 'source' | 'visual';
  /** whether the main file's preamble loads booktabs, when this file has none; null when unknown */
  rootLoadsBooktabs?: boolean | null;
}

export type InsertResult = { ok: true; needsBooktabs: boolean } | { ok: false; reason: string };

/** The table spec as a transaction: the snippet's own spec, made against a stand-in state so nothing is dispatched yet. */
function snippetSpec(state: EditorState, template: string, at: number): TransactionSpec {
  let captured: TransactionSpec | null = null;
  // a cursor at `at`: the snippet would otherwise replace a selection starting there
  const proxy = Object.create(state, {
    selection: { value: EditorSelection.single(at) },
    update: { value: (spec: TransactionSpec) => { captured = spec; return null; } },
  }) as EditorState;
  snippet(template)({ state: proxy, dispatch: () => {} } as unknown as EditorView, null, at, at);
  if (!captured) throw new Error('The table template made no change');
  return captured;
}

/**
 * Inserts a new table at the caret as one undo step, the booktabs package
 * line included when this file holds the preamble and lacks it. In Source
 * the cells, then the caption, then the label are Tab fields; in Visual the
 * caret goes after the table and its first cell opens for typing. A
 * selection is never replaced.
 */
export function insertTable(view: EditorView, o: InsertOptions): InsertResult {
  const { state } = view;
  const ctx = insertContext(state, o.rootLoadsBooktabs ?? null);
  if (ctx.refusal) return { ok: false, reason: ctx.refusal };
  const float = o.float && !ctx.floatRefusal;
  const lines: RuleStyle = o.lines === 'auto' ? ctx.autoLines : o.lines;
  const pos = state.selection.main.head;
  const place = placement(state, pos, float);
  const tpl = tableTemplate({ cols: o.cols, rows: o.rows, float, header: o.header, lines, align: o.align, indent: '', unit: '\t' });
  const spec = snippetSpec(state, snippetTemplate(tpl, place.newline), place.from);
  const inserted = (spec.changes as { insert: { toString(): string } }).insert.toString();
  const end = place.from + inserted.length;
  const first: TransactionSpec = o.mode === 'visual'
    ? { changes: spec.changes, selection: { anchor: end }, scrollIntoView: true, userEvent: INSERT_EVENT }
    : { ...spec, userEvent: INSERT_EVENT };
  const specs: TransactionSpec[] = [first];
  const missing = needsPackage(lines, ctx.booktabs ? new Set(['booktabs']) : new Set());
  let needsBooktabs = false;
  let shift = 0;
  if (missing) {
    const pkg = ctx.preambleHere ? booktabsChange(state.doc.toString()) : null;
    if (pkg) {
      specs.push({ changes: pkg as ChangeSpec });
      if (pkg.from <= place.from) shift = pkg.insert.length;
    } else needsBooktabs = true;
  }
  const boundary = state.facet(undoBoundary);
  boundary();
  view.dispatch(...specs);
  boundary();
  view.focus();
  if (o.mode === 'visual') {
    const tabular = inserted.indexOf('\\begin{tabular}');
    // the package line, when it went in above the table, moved it down
    if (tabular >= 0 && view.contentDOM) openTableCellAt(view, place.from + shift + tabular, 0, 0);
  }
  return { ok: true, needsBooktabs };
}

/** Whether a collaborator's focused caret is in `from`…`to` of this document (keep-aligned waits for them). */
export function peerCaretInside(awareness: Awareness, ydoc: Y.Doc, ytext: Y.Text, from: number, to: number): boolean {
  for (const [id, st] of awareness.getStates()) {
    if (id === awareness.clientID || !st) continue;
    if ((st as { focused?: boolean }).focused === false) continue;
    const head = (st as { cursor?: { head?: unknown } }).cursor?.head;
    if (!head) continue;
    try {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(head), ydoc);
      if (abs && abs.type === ytext && abs.index >= from && abs.index <= to) return true;
    } catch { /* a malformed peer state never blocks */ }
  }
  return false;
}
