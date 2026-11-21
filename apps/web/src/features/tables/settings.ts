import type { AnySettingDef, SettingDef } from '../../settings/types';

/** The 'tables.*' settings (WP18; the engine is editor/tables, WP14). Pure data: import types only, never the store or UI code. */

export const TABLES_SETTING_IDS = {
  button: 'tables.button',
  keepAligned: 'tables.keepAligned',
  formatAligns: 'tables.formatAligns',
  justify: 'tables.justify',
  maxWidth: 'tables.maxWidth',
  insertFloat: 'tables.insertFloat',
  insertHeader: 'tables.insertHeader',
  insertLines: 'tables.insertLines',
  insertAlign: 'tables.insertAlign',
} as const;

export type Justify = 'spec' | 'left';
/** 'auto': booktabs when the preamble loads it or sits in this file, otherwise \hline. */
export type LinesChoice = 'auto' | 'booktabs' | 'hline' | 'none';
export type ColumnAlign = 'l' | 'c' | 'r';

const ids = TABLES_SETTING_IDS;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const oneOf = <T extends string | number>(values: readonly T[]) => (v: unknown): v is T => values.includes(v as T);
const isWidth = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 400;

const button: SettingDef<boolean> = {
  id: ids.button, section: 'tables', label: 'Show the table button',
  hint: 'A button in the editor header that inserts a table from a grid and holds the table tools.',
  keywords: 'table tabular grid picker insert toolbar button',
  scope: 'account', default: true, validate: isBool, control: { kind: 'switch' }, order: 100,
};

const keepAligned: SettingDef<boolean> = {
  id: ids.keepAligned, section: 'tables', label: 'Keep aligned tables aligned',
  hint: 'After you type in a table whose columns were already lined up, Laytekz lines them up again when the cursor leaves the table. One undo takes it back.',
  keywords: 'table align columns ampersand keep automatic realign tabular',
  scope: 'account', default: true, validate: isBool, control: { kind: 'switch' }, automatic: true, palette: true, order: 200,
};

const formatAligns: SettingDef<boolean> = {
  id: ids.formatAligns, section: 'tables', label: 'Format document aligns table columns',
  hint: 'Format document also lines up each table the way Align table columns does, in the same undo step.',
  keywords: 'table align format document latexindent columns',
  scope: 'account', default: true, validate: isBool, control: { kind: 'switch' }, order: 210,
};

const justify: SettingDef<Justify> = {
  id: ids.justify, section: 'tables', label: 'Pad cells',
  hint: (v) => (v === 'spec' ? 'r columns are padded on the left, c columns on both sides, the rest on the right.' : 'Every cell is padded on the right.'),
  keywords: 'table align justify pad right centre center left column spec',
  scope: 'account', default: 'spec', validate: oneOf(['spec', 'left'] as const),
  control: { kind: 'segmented', options: [{ value: 'spec', label: 'By column alignment' }, { value: 'left', label: 'Always left' }] },
  order: 220,
};

const maxWidth: SettingDef<number> = {
  id: ids.maxWidth, section: 'tables', label: 'Widest cell that sets a column\'s width',
  hint: (v) => (v === 0 ? 'No limit: every cell widens its column.' : `A cell wider than ${v} characters overflows instead of widening its column. 0 means no limit.`),
  keywords: 'table align width overflow wide cell limit',
  scope: 'account', default: 40, validate: isWidth, control: { kind: 'number', min: 0, max: 400 }, order: 230,
};

const insertFloat: SettingDef<boolean> = {
  id: ids.insertFloat, section: 'tables', label: 'New tables get a caption and label',
  hint: 'A table float with \\caption and \\label around the tabular. Inside another table or float only a bare tabular goes in.',
  keywords: 'table insert float caption label new',
  scope: 'device', default: true, validate: isBool, control: { kind: 'switch' }, order: 300,
};

const insertHeader: SettingDef<boolean> = {
  id: ids.insertHeader, section: 'tables', label: 'New tables get a header row',
  hint: 'A rule follows the first row.',
  keywords: 'table insert header row rule new',
  scope: 'device', default: true, validate: isBool, control: { kind: 'switch' }, order: 310,
};

const insertLines: SettingDef<LinesChoice> = {
  id: ids.insertLines, section: 'tables', label: 'Rules in new tables',
  hint: (v) => (v === 'auto' ? 'Booktabs when the preamble loads it or is in the same file (it is then added), otherwise \\hline.' : ''),
  keywords: 'table insert booktabs hline rules lines toprule midrule',
  scope: 'device', default: 'auto', validate: oneOf(['auto', 'booktabs', 'hline', 'none'] as const),
  control: { kind: 'segmented', options: [{ value: 'auto', label: 'Automatic' }, { value: 'booktabs', label: 'Booktabs' }, { value: 'hline', label: '\\hline' }, { value: 'none', label: 'None' }] },
  order: 320,
};

const insertAlign: SettingDef<ColumnAlign> = {
  id: ids.insertAlign, section: 'tables', label: 'Columns in new tables',
  keywords: 'table insert column alignment left centre center right',
  scope: 'device', default: 'l', validate: oneOf(['l', 'c', 'r'] as const),
  control: { kind: 'segmented', options: [{ value: 'l', label: 'Left' }, { value: 'c', label: 'Centered' }, { value: 'r', label: 'Right' }] },
  order: 330,
};

export const settings: readonly AnySettingDef[] = [button, keepAligned, formatAligns, justify, maxWidth, insertFloat, insertHeader, insertLines, insertAlign];
