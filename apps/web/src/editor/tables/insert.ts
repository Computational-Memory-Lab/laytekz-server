import type { TexContext } from '../texContext/types';
import { FLOAT_ENVIRONMENTS, TABLE_ENVIRONMENTS } from '../../latex/vocab';

/**
 * The text a new table is inserted as, and where it may go. Pure: the grid
 * picker (WP18) turns `fields` into snippet fields (cells row by row, then
 * the caption, then the label key) and dispatches the text, plus the
 * booktabs package line when `needsPackage`, as one undo step.
 */

export type RuleStyle = 'booktabs' | 'hline' | 'none';

export interface TableSpec {
  cols: number;
  rows: number;
  /** a table float with a caption above the tabular and a label */
  float: boolean;
  /** a rule after the first row */
  header: boolean;
  lines: RuleStyle;
  /** every column's alignment */
  align: 'l' | 'c' | 'r';
  /** the indentation of the line the table goes on */
  indent?: string;
  /** one level of indentation (the editor's indent unit) */
  unit?: string;
}

export interface TableTemplate {
  text: string;
  /** offsets in `text`: the cells row by row, then (in a float) the caption and the label key */
  fields: Array<{ from: number; to: number; kind: 'cell' | 'caption' | 'label' }>;
  /** the first cell's offset in `text` */
  firstCell: number;
}

/** The largest grid the picker offers: 12 columns, 20 rows. */
export const MAX_COLS = 12;
export const MAX_ROWS = 20;

const RULES: Record<RuleStyle, { top: string; mid: string; bottom: string } | null> = {
  booktabs: { top: '\\toprule', mid: '\\midrule', bottom: '\\bottomrule' },
  hline: { top: '\\hline', mid: '\\hline', bottom: '\\hline' },
  none: null,
};

/**
 * The LaTeX of a new table. Every cell is empty and set like `" &  & "`, so
 * each one is a field of its own; the float puts the caption above the
 * tabular (the booktabs and APA convention). The text holds no `${`, `#{`
 * or `\{`, which snippet templates would read as fields.
 */
export function tableTemplate(spec: TableSpec): TableTemplate {
  const cols = Math.max(1, Math.min(MAX_COLS, Math.floor(spec.cols)));
  const rows = Math.max(1, Math.min(MAX_ROWS, Math.floor(spec.rows)));
  const base = spec.indent ?? '';
  const unit = spec.unit ?? '  ';
  const rules = RULES[spec.lines];
  const fields: TableTemplate['fields'] = [];
  let text = '';
  const line = (depth: number, s: string) => { text += `${base}${unit.repeat(depth)}${s}\n`; };
  const d = spec.float ? 1 : 0;
  let caption: [number, number] | null = null;
  let label: [number, number] | null = null;
  if (spec.float) {
    line(0, '\\begin{table}[htbp]');
    line(1, '\\centering');
    text += `${base}${unit}\\caption{`;
    caption = [text.length, text.length];
    text += '}\n';
    text += `${base}${unit}\\label{tab:`;
    label = [text.length, text.length];
    text += '}\n';
  }
  line(d, `\\begin{tabular}{${spec.align.repeat(cols)}}`);
  if (rules) line(d + 1, rules.top);
  for (let r = 0; r < rows; r++) {
    text += `${base}${unit.repeat(d + 1)}`;
    for (let c = 0; c < cols; c++) {
      text += c === 0 ? '' : ' & ';
      fields.push({ from: text.length, to: text.length, kind: 'cell' });
    }
    text += ' \\\\\n';
    if (r === 0 && spec.header && rows > 1 && rules) line(d + 1, rules.mid);
  }
  if (rules) line(d + 1, rules.bottom);
  line(d, '\\end{tabular}');
  if (spec.float) line(0, '\\end{table}');
  text = text.replace(/\n$/, '');
  if (caption) fields.push({ from: caption[0], to: caption[1], kind: 'caption' });
  if (label) fields.push({ from: label[0], to: label[1], kind: 'label' });
  return { text, fields, firstCell: fields[0].from };
}

/** Whether the booktabs rules need `\usepackage{booktabs}` added: the style asks for it and the preamble lacks it. */
export function needsPackage(lines: RuleStyle, packages: ReadonlySet<string>): boolean {
  return lines === 'booktabs' && !packages.has('booktabs');
}

/** The rule style a new table starts with: booktabs when the preamble loads it or is in this file, otherwise `\hline`. */
export function defaultRuleStyle(packages: ReadonlySet<string>, preambleHere: boolean): RuleStyle {
  return packages.has('booktabs') || preambleHere ? 'booktabs' : 'hline';
}

/** Why a table cannot be inserted at a position with context `ctx`, in words for the person; null when it can. */
export function insertRefusal(ctx: TexContext | null): string | null {
  if (!ctx) return null;
  if (ctx.kind === 'math') return 'A table can\'t go inside a formula: use \\begin{array} there';
  if (ctx.kind === 'comment') return 'A table can\'t go inside a comment';
  if (ctx.kind === 'verbatim' || ctx.kind === 'literal' || ctx.kind === 'code') return 'A table can\'t go here: this text is typeset exactly as written';
  return null;
}

/**
 * Why the float option is off at a position with context `ctx` (inside a
 * float or a table, where a float fails with "Not in outer par mode"), or
 * null when a float may go there.
 */
export function floatRefusal(ctx: TexContext | null): string | null {
  if (!ctx) return null;
  const floats = new Set(FLOAT_ENVIRONMENTS);
  if (ctx.table || ctx.envStack.some((e) => e in TABLE_ENVIRONMENTS)) return 'Inside a table only a bare tabular can go';
  if (ctx.envStack.some((e) => floats.has(e))) return 'Inside a figure or table float only a bare tabular can go';
  return null;
}
