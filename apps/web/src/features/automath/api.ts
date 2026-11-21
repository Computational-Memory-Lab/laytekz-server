/**
 * Public API of automatic math mode (WP11, feature 2). Other features import
 * automath only through this file.
 *
 * `autoMathFormatters` lets a feature format what automatic math mode is about
 * to wrap (WP38's statistics: `t(28) = 2.31` typed in prose gets the house
 * style instead of a plain `$…$`). The wrap rule asks every formatter, in the
 * order they were provided, before its own rules; the first non-null result is
 * the automatic edit (one undo step, Backspace right after reverts it, and a
 * reverted spot never fires again).
 */
import { Facet, type EditorState } from '@codemirror/state';

export interface AutoMathFormatterInput {
  /** The editor state before the keystroke. Every position up to `at` is the same after it. */
  readonly state: EditorState;
  /** Where the boundary character was typed (the end of the word). */
  readonly at: number;
  /** The boundary character: a space, `, . ; : ! ?`, or a closing `) ] }`. */
  readonly char: string;
  /** The start of the line, and the line's text from there up to `at`. */
  readonly lineFrom: number;
  readonly text: string;
  /** The inline delimiters a wrap uses in this file (`$`/`$`, or `\(`/`\)`). */
  readonly open: string;
  readonly close: string;
}

/** Replaces `from..to` (lineFrom <= from <= to <= at) with `insert`. */
export interface AutoMathFormatterResult { from: number; to: number; insert: string }

export interface AutoMathFormatter {
  id: string;
  /** Pure: no view, DOM, clock or storage. Null leaves the word to automatic math mode's own rules. */
  format(input: AutoMathFormatterInput): AutoMathFormatterResult | null;
}

/** Provide with `autoMathFormatters.of(formatter)` in a feature's editor extension. */
export const autoMathFormatters: Facet<AutoMathFormatter, readonly AutoMathFormatter[]> = Facet.define<AutoMathFormatter>();

/** The rule names automatic math mode's edits carry (AutoEdit.rule, `autoEditMark`). */
export const AUTO_MATH_RULES = { wrap: 'automath.wrap', identifier: 'automath.identifier' } as const;
