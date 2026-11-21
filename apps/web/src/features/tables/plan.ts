import type { EditorState } from '@codemirror/state';
import type { TableTemplate } from '../../editor/tables/insert';

/**
 * Pure pieces of inserting a table: the snippet template the editor turns
 * into Tab fields, where the table goes, and the booktabs package line.
 */

/**
 * The snippet template for `t` (made with indent '' and unit '\t', so the
 * snippet indents every line under the line it goes on and turns each tab
 * into the editor's indent unit). Tab visits the cells row by row, then the
 * caption, then the label key, and ends after the table (`${0}`).
 * `leadingNewline` starts the table on a line of its own.
 */
export function snippetTemplate(t: TableTemplate, leadingNewline: boolean): string {
  const marks = t.fields.map((f, i) => ({ at: f.from, mark: `\${${i + 1}}` }));
  marks.sort((a, b) => b.at - a.at);
  let text = t.text;
  for (const m of marks) text = text.slice(0, m.at) + m.mark + text.slice(m.at);
  return `${leadingNewline ? '\n' : ''}${text}\${0}`;
}

/**
 * Where a table goes for a caret at `pos`: a float on its own lines after the
 * current line when that line has text (it never splits a sentence), at the
 * caret on a blank line; a bare tabular at the caret.
 */
export function placement(state: EditorState, pos: number, float: boolean): { from: number; newline: boolean } {
  const line = state.doc.lineAt(pos);
  if (!float || !line.text.trim()) return { from: pos, newline: false };
  return { from: line.to, newline: true };
}

/** Whether this file holds the preamble (a `\documentclass` before `\begin{document}`). */
export function preambleHere(text: string): boolean {
  const begin = text.search(/\\begin\s*\{document\}/);
  const cls = text.search(/^[^%\n]*\\documentclass/m);
  return begin >= 0 && cls >= 0 && cls < begin;
}

/**
 * The change that loads booktabs in this file's preamble: a line after the
 * last `\usepackage` line, or before `\begin{document}` when there is none.
 * Null when the file holds no preamble.
 */
export function booktabsChange(text: string): { from: number; insert: string } | null {
  if (!preambleHere(text)) return null;
  const begin = text.search(/\\begin\s*\{document\}/);
  const head = text.slice(0, begin);
  const re = /^[^%\n]*\\usepackage\b[^\n]*$/gm;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(head); m; m = re.exec(head)) last = m;
  if (last) return { from: last.index + last[0].length, insert: '\n\\usepackage{booktabs}' };
  const lineFrom = text.lastIndexOf('\n', begin - 1) + 1;
  return { from: lineFrom, insert: '\\usepackage{booktabs}\n' };
}

/** Whether a preamble's text loads booktabs (uncommented `\usepackage{…booktabs…}`). */
export function loadsBooktabs(text: string): boolean {
  return /^[^%\n]*\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\bbooktabs\b[^}]*\}/m.test(text);
}
