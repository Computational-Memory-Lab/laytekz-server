import type { Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { familyInfo } from './families';
import type { FamilyInfo, TableFamily } from './families';

/*
 * The table model: a tabular body as rows of cells with exact source offsets.
 * Pure (no DOM, no view), shared by the Visual grid, the table operations and
 * the aligner. Moved here from visual/widgets/table.ts, which re-exports it.
 */

/**
 * A cell's source span. `slot` runs from the separator before the cell to
 * the one after it (spacing, rules and comments included): an open editor
 * finds its cell again by it after edits around the cell. `raw` says why the
 * cell is edited as source: a %-comment inside it (one string written back
 * would rewrite the comment) or a line break (a one-line field joins the lines).
 */
export interface CellSpan { from: number; to: number; text: string; slot: [number, number]; raw?: 'comment' | 'lines'; multi?: Multicolumn }

/**
 * A cell that is one `\multicolumn{n}{spec}{body}`: it spans `span` grid
 * columns. `spanAt` is where `n` is written; `body` is what its editor edits.
 */
export interface Multicolumn { span: number; spanAt: [number, number]; spec: string; body: { from: number; to: number; text: string } }

/** A column of the column spec: its source (`>{…}p{3cm}` included) and its type letter. */
export interface SpecColumn { from: number; to: number; text: string; letter: string }

/** Every offset is relative to the start of the tabular environment. */
export interface TableModel {
  rows: CellSpan[][];
  /** what "+ row" writes: an empty row after the last one */
  addRow: Array<{ from: number; insert: string }>;
  cols: number;
  /** column-spec interior range, for add-column */
  colSpec: { from: number; to: number } | null;
  /** what add-column writes into the spec (offset relative like the rest) */
  colInsert: { at: number; insert: string } | null;
  /** end offset of each row's last cell — where ` & ` lands for add-column */
  rowEnds: number[];
  /** each row's `\\` (with its `*` and `[len]`), null for a last row written without one */
  breaks: Array<[number, number] | null>;
  /** the spec's columns, or null where the editor can't map them (a `*{n}{…}` repeat) */
  specColumns: SpecColumn[] | null;
  /** the body between \\begin{tabular}{…} and \\end{tabular}, and where its last row ends (as newRow takes them) */
  body: { from: number; to: number; end: number; unbroken: boolean };
}

/** The grid columns a cell covers. */
export function cellSpan(cell: CellSpan): number {
  return cell.multi?.span ?? 1;
}

/** The balanced `{…}` group opening at `i`: its interior and the index after it. */
function braced(text: string, i: number): { inner: string; from: number; end: number } | null {
  if (text[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { inner: text.slice(i + 1, j), from: i + 1, end: j + 1 };
  }
  return null;
}

const skipWs = (text: string, i: number) => { while (i < text.length && /\s/.test(text[i])) i++; return i; };

/** A cell written as one `\multicolumn{n}{spec}{body}`, offsets relative to `at` (where the cell's text starts). */
export function multicolumnOf(text: string, at: number): Multicolumn | null {
  const m = /^\\multicolumn(?![A-Za-z])\s*/.exec(text);
  if (!m) return null;
  const n = braced(text, m[0].length);
  const spec = n && braced(text, skipWs(text, n.end));
  const body = spec && braced(text, skipWs(text, spec.end));
  if (!n || !spec || !body || skipWs(text, body.end) !== text.length || !/^\s*\d+\s*$/.test(n.inner)) return null;
  return {
    span: Number(n.inner),
    spanAt: [at + n.from, at + n.end - 1],
    spec: spec.inner,
    body: { from: at + body.from, to: at + body.end - 1, text: body.inner },
  };
}

/**
 * A column spec as its columns, `base` the offset of its interior. Rules
 * (`|`) and `@{…}`/`!{…}` stand between columns and belong to none; a
 * column's `>{…}`/`<{…}` and its width are its own. A `*{n}{…}` repeat
 * has no one place per column: null.
 */
export function specColumns(spec: string, base: number): SpecColumn[] | null {
  const cols: SpecColumn[] = [];
  let i = 0;
  const group = (at: number) => braced(spec, skipWs(spec, at));
  while (i < spec.length) {
    const ch = spec[i];
    if (/\s/.test(ch) || ch === '|') { i++; continue; }
    if (ch === '@' || ch === '!') {
      const g = group(i + 1);
      if (!g) return null;
      i = g.end;
      continue;
    }
    const start = i;
    while (spec[i] === '>') {
      const g = group(i + 1);
      if (!g) return null;
      i = skipWs(spec, g.end);
    }
    const letter = spec[i];
    if (!letter || !/[A-Za-z]/.test(letter)) return null;
    i++;
    if (spec[i] === '[') {
      const close = spec.indexOf(']', i);
      if (close < 0) return null;
      i = close + 1;
    }
    while (spec[i] === '{') i = braced(spec, i)?.end ?? spec.length + 1;
    if (i > spec.length) return null;
    for (let j = skipWs(spec, i); spec[j] === '<'; j = skipWs(spec, i)) {
      const g = group(j + 1);
      if (!g) return null;
      i = g.end;
    }
    cols.push({ from: base + start, to: base + i, text: spec.slice(start, i), letter });
  }
  return cols;
}

const RULE_RE = /^\\(?:hline|toprule|midrule|bottomrule|cline\{[^}]*\}|cmidrule(?:\([^)]*\))?\{[^}]*\}|addlinespace(?:\[[^\]]*\])?)\s*/;

/**
 * Scan a tabular body into cells with exact source offsets. Braces guard
 * nested `&`/`\\`; %-comments are never cells and never separate them; the
 * optional `[len]` after `\\` belongs to the row break; rule commands are
 * display-stripped. A row ended by `\\` counts even when empty; what follows
 * the last `\\` is a row only when it holds text. Anything the scanner can't
 * confidently map keeps the construct raw (caller falls back to a chip).
 */
export function parseTabular(body: string, base: number): { rows: CellSpan[][]; rowEnds: number[]; addRow: TableModel['addRow']; breaks: TableModel['breaks']; tail: { end: number; unbroken: boolean } } | null {
  const rows: CellSpan[][] = [];
  const rowEnds: number[] = [];
  const breaks: TableModel['breaks'] = [];
  const comments: Array<[number, number]> = [];
  let cells: CellSpan[] = [];
  let cellStart = 0;
  let depth = 0;
  let lastBreak = -1;
  let i = 0;
  const pushCell = (end: number) => {
    let s = cellStart;
    let e = end;
    for (;;) {
      while (s < e && /\s/.test(body[s])) s++;
      const c = comments.find(([f, t]) => f === s && t <= e);
      if (c) { s = c[1]; continue; }
      const m = RULE_RE.exec(body.slice(s, e));
      if (m) { s += m[0].length; continue; }
      break;
    }
    for (;;) {
      while (e > s && /\s/.test(body[e - 1])) e--;
      const c = comments.find(([f, t]) => t === e && f >= s);
      if (c) { e = c[0]; continue; }
      break;
    }
    const text = body.slice(s, e);
    const raw = comments.some(([f, t]) => f >= s && t <= e) ? 'comment' : /[\r\n]/.test(text) ? 'lines' : undefined;
    const multi = raw ? null : multicolumnOf(text, base + s);
    cells.push({ from: base + s, to: base + e, text, slot: [base + cellStart, base + end], ...(raw ? { raw } : {}), ...(multi ? { multi } : {}) });
  };
  const pushRow = (end: number, broken: boolean): boolean => {
    pushCell(end);
    const row = cells;
    cells = [];
    if (!broken && row.length === 1 && row[0].text === '') return false;
    rows.push(row);
    rowEnds.push(row[row.length - 1].to);
    breaks.push(null);
    return true;
  };
  // nested environments (a tabular in a cell) guard their `&` and `\\` like braces do
  let envDepth = 0;
  const top = () => depth === 0 && envDepth === 0;
  /** The `\\` (or `\tabularnewline`) of `len` characters at `i` ends a row: returns where the break ends. */
  const rowBreak = (len: number): number => {
    pushRow(i, true);
    const breakAt = i;
    i += len;
    if (body[i] === '*') i++;
    // LaTeX looks past spaces and one line break for the [len] of \\[len]
    let j = i;
    while (body[j] === ' ' || body[j] === '\t') j++;
    if (body[j] === '\n') { j++; while (body[j] === ' ' || body[j] === '\t') j++; }
    if (body[j] === '[') {
      const close = body.indexOf(']', j);
      if (close > 0) i = close + 1;
    }
    breaks[breaks.length - 1] = [base + breakAt, base + i];
    lastBreak = i;
    cellStart = i;
    return i;
  };
  while (i < body.length) {
    const ch = body[i];
    if (ch === '%') {
      const nl = body.indexOf('\n', i);
      const end = nl < 0 ? body.length : nl;
      comments.push([i, end]);
      i = end;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === '\\' && body[i + 1] === '\\' && top()) {
      rowBreak(2);
      continue;
    } else if (ch === '&' && top()) {
      pushCell(i);
      i += 1;
      cellStart = i;
      continue;
    } else if (ch === '\\') {
      const name = /^\\([A-Za-z]+)/.exec(body.slice(i, i + 20))?.[1];
      if (name === 'tabularnewline' && top()) { rowBreak(15); continue; }
      if (name === 'begin') envDepth++;
      else if (name === 'end') envDepth = Math.max(0, envDepth - 1);
      else if (name === 'verb') {
        // \verb|a&b|: its delimiter, not braces, ends it, on the same line
        let j = i + 5;
        if (body[j] === '*') j++;
        const delim = body[j];
        const close = delim && !/[\s\w]/.test(delim) ? body.indexOf(delim, j + 1) : -1;
        if (close > 0 && !body.slice(j, close).includes('\n')) { i = close + 1; continue; }
      }
      i += name ? name.length + 1 : 2; // a command name, or an escaped character
      continue;
    }
    i += 1;
  }
  const unbroken = pushRow(body.length, false);
  if (!rows.length) return null;
  const end = unbroken ? rowEnds[rowEnds.length - 1] - base : lastBreak;
  return { rows, rowEnds, breaks, tail: { end, unbroken }, addRow: newRow(body, base, end, unbroken, emptyRow(gridColumns(rows))) };
}

/** How many grid columns the widest row covers. */
export function gridColumns(rows: CellSpan[][]): number {
  return Math.max(...rows.map((r) => r.reduce((n, c) => n + cellSpan(c), 0)));
}

/** A row of `cols` empty cells, as "+ row" writes it: `&  \\`. */
export function emptyRow(cols: number): string {
  return `${' &'.repeat(cols - 1).replace(/&/g, ' & ').trimStart()} \\\\`;
}

/**
 * "+ row": an empty row right after the last one, so it lands inside the
 * table and above a closing rule, on a line of its own unless the table is
 * written on one line. A last row without `\\` gets one; a comment ending the
 * last row's line stays on that line. `end` is where the last row ends (after
 * its `\\` and `[len]`, or after its last cell).
 */
export function newRow(body: string, base: number, end: number, unbroken: boolean, cells: string): TableModel['addRow'] {
  const oneLine = !body.includes('\n');
  const row = oneLine ? ` ${cells.trimStart()}` : `\n${cells}`;
  const nl = body.indexOf('\n', end);
  const at = !oneLine && nl >= 0 && /^[ \t]*(?:%.*)?$/.test(body.slice(end, nl)) ? nl : end;
  if (!unbroken) return [{ from: base + at, insert: row }];
  if (at === end) return [{ from: base + end, insert: ` \\\\${row}` }];
  return [{ from: base + end, insert: ' \\\\' }, { from: base + at, insert: row }];
}

/** Start of the braced group that ends at `close` (the index of its `}`), or -1. */
function groupStart(spec: string, close: number): number {
  let depth = 0;
  for (let j = close; j >= 0; j--) {
    if (spec[j] === '}') depth++;
    else if (spec[j] === '{' && --depth === 0) return j;
  }
  return -1;
}

function skipSpaceBack(spec: string, i: number): number {
  while (i > 0 && /\s/.test(spec[i - 1])) i--;
  return i;
}

/**
 * What add-column writes into a column spec, and where: after the last
 * column, before the outer rule and padding that close the table (trailing
 * `|`, `@{…}`, `!{…}`). A braced group after anything else (`p{3cm}`) is a
 * column and ends the scan. When the last column is ruled off from the one
 * before it, the new one is too.
 */
export function specAddColumn(spec: string): { at: number; insert: string } {
  let end = spec.length;
  for (;;) {
    const i = skipSpaceBack(spec, end);
    if (i > 0 && spec[i - 1] === '|') { end = i - 1; continue; }
    if (i > 0 && spec[i - 1] === '}') {
      const open = groupStart(spec, i - 1);
      const k = skipSpaceBack(spec, open);
      if (open > 0 && (spec[k - 1] === '@' || spec[k - 1] === '!')) { end = k - 1; continue; }
    }
    end = i;
    break;
  }
  // the last column's type letter, past a p{…}/m{…}/b{…} width
  let col = end;
  if (col > 0 && spec[col - 1] === '}') {
    const open = groupStart(spec, col - 1);
    col = open > 0 ? open - 1 : 0;
  } else if (col > 0) col--;
  const before = skipSpaceBack(spec, col);
  const ruled = before > 0 && spec[before - 1] === '|';
  return { at: end, insert: ruled ? '|l' : 'l' };
}

/** A tabular node's grid model, or null when the body can't be mapped to cells. */
export function tableModel(doc: Text, node: SyntaxNode): TableModel | null {
  const begin = node.getChild('BeginEnv');
  const end = node.getChild('EndEnv');
  if (!begin || !end) return null;
  const base = node.from;
  const parsed = parseTabular(doc.sliceString(begin.to, end.from), begin.to - base);
  if (!parsed) return null;
  // The column spec is \begin{tabular}'s last braced argument (tabular*'s
  // first one is the width). Its range comes from the argument node's own
  // bounds: brace children of @{}-style specs are the inner braces.
  const spec = begin.getChildren('TextArgument').pop();
  const specOk = spec
    && doc.sliceString(spec.from, spec.from + 1) === '{'
    && doc.sliceString(spec.to - 1, spec.to) === '}';
  return {
    rows: parsed.rows,
    rowEnds: parsed.rowEnds,
    breaks: parsed.breaks,
    body: { from: begin.to - base, to: end.from - base, ...parsed.tail },
    cols: gridColumns(parsed.rows),
    addRow: parsed.addRow,
    colSpec: specOk ? { from: spec!.from + 1 - base, to: spec!.to - 1 - base } : null,
    specColumns: specOk ? specColumns(doc.sliceString(spec!.from + 1, spec!.to - 1), spec!.from + 1 - base) : null,
    colInsert: specOk ? (() => {
      const c = specAddColumn(doc.sliceString(spec!.from + 1, spec!.to - 1));
      return { at: spec!.from + 1 - base + c.at, insert: c.insert };
    })() : null,
  };
}


/** What a cell's editor edits: a merged cell's content, any other cell whole. */
export function editable(cell: CellSpan): { from: number; to: number; text: string } {
  return cell.multi?.body ?? cell;
}

/** A table environment's model read from its source alone, with what its family means for alignment. */
export interface EnvTableModel extends TableModel { name: string; info: FamilyInfo }

/** The `[…]` group opening at `i` (braces guard a `]`): the index after it. */
function bracketed(text: string, i: number): number {
  let depth = 0;
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === ']' && depth <= 0) return j + 1;
  }
  return -1;
}

/**
 * The model of a whole table-like environment, `src` running from its
 * `\begin` to the end of its `\end{…}`, offsets relative to `src`. The
 * arguments follow the family's signature (families.ts), so `tabular*`'s
 * width, `tblr`'s options and `alignat`'s column count are never cells.
 * `family` names the family of an environment the vocabulary does not list.
 * Null when `src` is not one such environment or its body has no cells.
 */
export function tableModelFromSource(src: string, family?: TableFamily | null): EnvTableModel | null {
  const begin = /^\\begin\s*\{([^{}]+)\}/.exec(src);
  if (!begin) return null;
  const name = begin[1].trim();
  const info = familyInfo(name, family);
  if (!info) return null;
  let i = begin[0].length;
  let spec: { from: number; to: number } | null = null;
  for (let k = 0; k < info.args.length; k++) {
    if (info.args[k] === '{') {
      const j = skipWs(src, i);
      const g = braced(src, j);
      if (!g) break;
      if (k === info.specArg) spec = { from: g.from, to: g.end - 1 };
      i = g.end;
    } else {
      let j = i;
      while (src[j] === ' ' || src[j] === '\t') j++;
      if (src[j] !== '[') continue;
      const end = bracketed(src, j);
      if (end < 0) break;
      i = end;
    }
  }
  const endAt = src.lastIndexOf('\\end');
  if (endAt < i) return null;
  const close = /^\\end\s*\{([^{}]+)\}\s*$/.exec(src.slice(endAt));
  if (!close || close[1].trim() !== name) return null;
  const parsed = parseTabular(src.slice(i, endAt), i);
  if (!parsed) return null;
  const sp = spec as { from: number; to: number } | null;
  const specText = sp ? src.slice(sp.from, sp.to) : '';
  const added = sp ? specAddColumn(specText) : null;
  return {
    name,
    info,
    rows: parsed.rows,
    rowEnds: parsed.rowEnds,
    breaks: parsed.breaks,
    body: { from: i, to: endAt, ...parsed.tail },
    cols: gridColumns(parsed.rows),
    addRow: parsed.addRow,
    colSpec: sp,
    specColumns: sp ? specColumns(specText, sp.from) : null,
    colInsert: sp && added ? { at: sp.from + added.at, insert: added.insert } : null,
  };
}
