import { tableModelFromSource } from './model';
import type { CellSpan, EnvTableModel } from './model';
import type { TableFamily } from './families';
import { displayWidth } from './width';

/**
 * Aligns a table's columns, TeXstudio style, by changing whitespace only:
 * one space after each `&`, padding before it (at least one space), and the
 * `\\` of every full row lined up one space past the widest one. Cells are
 * padded by their column's letter in the spec (r right, c centred, anything
 * else left), or always left when asked or when the family says so.
 *
 * Line breaks never move ("keep lines"). A row is aligned only when it is
 * written on one line of its own (a rule or `\rowcolor` may start that
 * line); a row with a comment, a tab or a line break inside it, a row that
 * shares its line with another, and a single-cell row in a wider table
 * (a longtable `\caption{…}\\`, `\endhead`) are left exactly as written and
 * do not widen any column. A `\multicolumn` fills the columns it spans when
 * it fits and overflows when it does not: the columns do not widen and the
 * rest of its row is set one space apart. So does a cell wider than
 * `maxWidth`. A table written on one line is never touched.
 *
 * Every change replaces one run of whitespace with another, so characters
 * keep their identity in the shared document: collaborators' carets and
 * comment anchors stay on the same text. Running it twice changes nothing.
 */

export interface Change { from: number; to: number; insert: string }

export interface AlignOptions {
  /** 'spec' pads by the column spec (the default), 'left' always pads on the right */
  justify?: 'spec' | 'left';
  /** a cell wider than this many columns overflows; 0: no limit (default 40) */
  maxWidth?: number;
  /** the family of an environment the vocabulary does not list */
  family?: TableFamily | null;
}

/** Rule and colour commands that may start a row's line and are not part of its first cell. */
const LEADING = /^\\(?:hline|toprule|midrule|bottomrule|cline\{[^}]*\}|cmidrule(?:\([^)]*\))?\{[^}]*\}|addlinespace(?:\[[^\]]*\])?|rowcolor(?:\[[^\]]*\])?\{[^}]*\}|noalign\{[^}]*\})\s*/;
const BLANK = /^[ \t]*$/;

interface Cell { text: string; width: number; g: number; span: number; letter: string }
interface Row {
  r: number;
  /** where the diffed region starts and ends (relative to the table) */
  from: number;
  to: number;
  /** the region starts at its line's start: the row takes the table's indent */
  atLineStart: boolean;
  /** the first cell's content starts after a rule or colour command on the same line */
  prefixed: boolean;
  /** leading whitespace as written (rows that start their line) */
  indent: string;
  cells: Cell[];
  broken: boolean;
}

const lineStart = (src: string, i: number) => src.lastIndexOf('\n', i - 1) + 1;

/** The first cell's content start: past rule and colour commands at its front. */
function contentStart(src: string, cell: CellSpan): number {
  let s = cell.from;
  for (;;) {
    const m = LEADING.exec(src.slice(s, cell.to));
    if (!m) return s;
    s += m[0].length;
  }
}

function letterOf(model: EnvTableModel, g: number, justify: 'spec' | 'left'): string {
  if (justify === 'left' || model.info.justify === 'left') return 'l';
  const sc = model.specColumns;
  if (!sc || sc.length !== model.cols) return 'l';
  return sc[g]?.letter ?? 'l';
}

/** A \\multicolumn spec's alignment: its first column letter (rules, `@{…}` and widths skipped). */
function multiLetter(spec: string): string {
  const letter = /[A-Za-z]/.exec(spec.replace(/[@!<>]?\{[^{}]*\}/g, ''))?.[0] ?? 'l';
  return /^[lcr]$/.test(letter) ? letter : 'l';
}

/** The rows the aligner may touch, with their cells' content and widths. */
function eligibleRows(model: EnvTableModel, src: string, justify: 'spec' | 'left'): Row[] {
  const out: Row[] = [];
  const align = model.info.keepAfterAmp;
  model.rows.forEach((row, r) => {
    if (row.some((c) => c.raw)) return;
    if (row.length < 2 && model.cols > 1) return;
    const brk = model.breaks[r];
    const first = contentStart(src, row[0]);
    const end = brk ? brk[0] : row[row.length - 1].to;
    if (/[\n\t]/.test(src.slice(first, end))) return;
    const ls = lineStart(src, first);
    if (ls < model.body.from) return; // shares the \begin line
    const before = src.slice(ls, first);
    let from: number;
    let atLineStart = false;
    let prefixed = false;
    if (BLANK.test(before)) {
      from = ls;
      atLineStart = true;
    } else {
      // only rules and colour commands may stand before the first cell
      let rest = before.replace(/^[ \t]+/, '');
      for (let m = LEADING.exec(rest); m; m = LEADING.exec(rest)) rest = rest.slice(m[0].length);
      if (rest.trim()) return;
      from = ls + before.trimEnd().length;
      prefixed = true;
    }
    let g = 0;
    const cells: Cell[] = row.map((cell, k) => {
      const span = cell.multi?.span ?? 1;
      let text = k === 0 ? src.slice(first, cell.to) : cell.text;
      // equation alignment keeps the spaces after `&` as typed: they count as the cell's own
      if (align && k > 0 && cell.from < cell.to) text = src.slice(cell.slot[0], cell.to);
      const letter = cell.multi ? multiLetter(cell.multi.spec) : letterOf(model, g, justify);
      const c = { text, width: displayWidth(text), g, span, letter: align ? 'l' : justify === 'left' ? 'l' : letter };
      g += span;
      return c;
    });
    out.push({ r, from, to: end, atLineStart, prefixed, indent: atLineStart ? before : '', cells, broken: !!brk });
  });
  return out;
}

/** `text` padded to `width` columns by `letter`. */
function pad(text: string, width: number, w: number, letter: string): string {
  const extra = Math.max(0, width - w);
  if (letter === 'r') return ' '.repeat(extra) + text;
  if (letter === 'c') {
    const left = Math.floor(extra / 2);
    return ' '.repeat(left) + text + ' '.repeat(extra - left);
  }
  return text + ' '.repeat(extra);
}

/**
 * The whitespace runs of `orig` that differ from `want`'s, as changes at
 * `base`; null when the two differ in anything but whitespace.
 */
export function whitespaceChanges(orig: string, want: string, base: number): Change[] | null {
  const changes: Change[] = [];
  let i = 0;
  let j = 0;
  const ws = (ch: string | undefined) => ch === ' ' || ch === '\t';
  for (;;) {
    const i0 = i;
    const j0 = j;
    while (ws(orig[i])) i++;
    while (ws(want[j])) j++;
    const a = orig.slice(i0, i);
    const b = want.slice(j0, j);
    if (a !== b) changes.push({ from: base + i0, to: base + i, insert: b });
    if (i >= orig.length && j >= want.length) return changes;
    if (orig[i] !== want[j]) return null;
    i++;
    j++;
  }
}

/**
 * The changes that align the table `src` (its `\begin` to its `\end{…}`),
 * offsets relative to `src`; [] when it is aligned already, is written on
 * one line, or is not a table.
 */
export function alignTable(src: string, opts: AlignOptions = {}): Change[] {
  const model = tableModelFromSource(src, opts.family);
  if (!model) return [];
  if (!src.slice(model.body.from, model.body.to).includes('\n')) return [];
  const justify = opts.justify ?? 'spec';
  const maxWidth = opts.maxWidth ?? 40;
  const rows = eligibleRows(model, src, justify);
  if (!rows.length) return [];
  const fits = (c: Cell) => maxWidth <= 0 || c.width <= maxWidth;

  const widths = Array<number>(model.cols).fill(0);
  for (const row of rows) for (const c of row.cells) if (c.span === 1 && fits(c) && c.g < widths.length) widths[c.g] = Math.max(widths[c.g], c.width);
  const spanWidth = (g: number, span: number) => {
    let w = 3 * (span - 1);
    for (let k = g; k < g + span && k < widths.length; k++) w += widths[k];
    return w;
  };

  // the table's indentation: the shallowest of the rows whose first cell has
  // text (a right or centred first column pads some rows' fronts); with no
  // such row, rows keep their own fronts
  const fronts = rows.filter((r) => r.atLineStart && r.cells[0].text).map((r) => r.indent);
  const indent = fronts.length ? fronts.reduce((a, b) => (b.length < a.length ? b : a)) : null;
  const sepAfter = model.info.keepAfterAmp ? ' &' : ' & ';

  const changes: Change[] = [];
  for (const row of rows) {
    // no row's first cell has text: each row keeps its front, which already pads its first `&`
    const keepFront = row.atLineStart && indent === null;
    let want = keepFront ? row.indent : row.atLineStart ? indent ?? '' : row.prefixed ? ' ' : '';
    let overflow = false;
    let covered = 0;
    row.cells.forEach((c, k) => {
      const last = k === row.cells.length - 1;
      const room = spanWidth(c.g, c.span);
      if (!overflow && (!fits(c) || c.width > room)) overflow = true;
      const front = k === 0 && keepFront;
      let field = overflow || front ? c.text : pad(c.text, room, c.width, c.letter);
      if (last && !row.broken) field = field.trimEnd();
      want += field;
      if (!last) want += front ? sepAfter.slice(1) : sepAfter;
      covered = c.g + c.span;
    });
    if (row.broken) {
      let tail = ' ';
      if (!overflow) for (let g = covered; g < widths.length; g++) tail += ' '.repeat(widths[g] + 3);
      want += tail;
    }
    // an empty cell in equation alignment is set like any other: `& &`
    const orig = src.slice(row.from, row.to);
    const got = whitespaceChanges(orig, want, row.from);
    if (!got) return [];
    changes.push(...got);
  }
  return changes;
}

/**
 * Whether the table `src` counts as aligned: aligning it changes nothing and
 * some `&` or `\\` has more than one space before it. A plain `a & b \\`
 * table never counts, so keep-aligned leaves tables nobody aligned alone.
 */
export function isAligned(src: string, opts: AlignOptions = {}): boolean {
  const model = tableModelFromSource(src, opts.family);
  if (!model) return false;
  const body = src.slice(model.body.from, model.body.to);
  if (!body.includes('\n') || !/\S {2,}(?:&|\\\\)/.test(body)) return false;
  return alignTable(src, opts).length === 0;
}

/**
 * Keep-aligned's decision, pure: the changes that realign `after` (the
 * table once edited) when `before` (the same table before the person's
 * first edit in it) was aligned; [] otherwise.
 */
export function realignIfWasAligned(before: string, after: string, opts: AlignOptions = {}): Change[] {
  return isAligned(before, opts) ? alignTable(after, opts) : [];
}
