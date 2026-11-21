import type { ChangeSpec, EditorState } from '@codemirror/state';
import { tableEnvAt } from '../texContext';
import type { TableEnv } from '../texContext/types';
import { TABLE_FAMILY_NAMES } from './families';
import { tableModelFromSource } from './model';
import type { EnvTableModel } from './model';
import { alignTable, isAligned } from './align';
import type { AlignOptions, Change } from './align';

/**
 * Finding tables in an editor state: the one at a position, every one in a
 * range, the cell holding an offset, and the alignment changes for them as
 * document positions. This is what the align command, keep-aligned and
 * Format document (WP18) call.
 */

/** A table environment in the document: its span, family and model. */
export interface DocTable extends TableEnv { src: string; model: EnvTableModel }

/** The innermost table at `pos` with its model, or null (none there, or the syntax tree is not ready). */
export function tableAt(state: EditorState, pos: number): DocTable | null {
  const env = tableEnvAt(state, pos);
  if (!env) return null;
  const src = state.doc.sliceString(env.from, env.to);
  const model = tableModelFromSource(src, env.family);
  return model ? { ...env, src, model } : null;
}

const BEGIN = /\\begin\s*\{([^{}]+)\}/g;

/**
 * Every table environment that starts in `from`…`to`, outermost first where
 * they nest. An environment the vocabulary does not list is found when
 * texContext knows it (a user's list, a wrapper) and its `\begin` sits in the
 * range.
 */
export function tablesIn(state: EditorState, from = 0, to = state.doc.length): DocTable[] {
  const text = state.doc.sliceString(0, state.doc.length);
  const known = new Set(TABLE_FAMILY_NAMES);
  const out: DocTable[] = [];
  const seen = new Set<number>();
  BEGIN.lastIndex = 0;
  for (let m = BEGIN.exec(text); m; m = BEGIN.exec(text)) {
    const at = m.index;
    if (at > to) break;
    const name = m[1].trim();
    if (!known.has(name) && !/tab(?!le)|tbl/i.test(name)) continue;
    // inside the \begin's name, so this environment (not an outer one) answers
    const t = tableAt(state, at + m[0].length - 1);
    if (!t || t.from !== at || seen.has(t.from)) continue;
    if (t.to < from) continue;
    seen.add(t.from);
    out.push(t);
  }
  return out;
}

/** The row and cell of `model` holding `offset` (relative to the table), by the cells' slots; null outside every cell. */
export function cellAt(model: EnvTableModel, offset: number): { r: number; c: number } | null {
  for (let r = 0; r < model.rows.length; r++) {
    const row = model.rows[r];
    for (let c = 0; c < row.length; c++) {
      const [s, e] = row[c].slot;
      if (offset >= s && offset <= e) return { r, c };
    }
  }
  return null;
}

const shift = (changes: Change[], by: number): Change[] => changes.map((c) => ({ from: c.from + by, to: c.to + by, insert: c.insert }));

/** The changes, as document positions, that align the table at `pos`; null when `pos` is in no table. */
export function alignTableAt(state: EditorState, pos: number, opts: AlignOptions = {}): Change[] | null {
  const t = tableAt(state, pos);
  if (!t) return null;
  return shift(alignTable(t.src, { ...opts, family: t.family }), t.from);
}

/**
 * The changes that align every table starting in `from`…`to` (the whole
 * document by default), sorted and never overlapping: what Format document
 * and "Align all tables" dispatch. A table nested in another's cell is
 * aligned only where the outer table leaves that text alone.
 */
export function alignTablesIn(state: EditorState, opts: AlignOptions = {}, from = 0, to = state.doc.length): Change[] {
  const all: Change[] = [];
  for (const t of tablesIn(state, from, to)) all.push(...shift(alignTable(t.src, { ...opts, family: t.family }), t.from));
  all.sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Change[] = [];
  for (const c of all) {
    const prev = out[out.length - 1];
    if (prev && c.from < prev.to) continue;
    if (prev && c.from === prev.from && c.to === prev.to) continue;
    out.push(c);
  }
  return out;
}

/** Whether the table at `pos` counts as aligned (keep-aligned's test, before an edit). */
export function tableAlignedAt(state: EditorState, pos: number, opts: AlignOptions = {}): boolean {
  const t = tableAt(state, pos);
  return !!t && isAligned(t.src, { ...opts, family: t.family });
}

/** `afterFormat`'s shape: the whole document's table alignment as one ChangeSpec, or null when nothing changes. */
export function alignAfterFormat(state: EditorState, opts: AlignOptions = {}): ChangeSpec | null {
  const changes = alignTablesIn(state, opts);
  return changes.length ? changes : null;
}
