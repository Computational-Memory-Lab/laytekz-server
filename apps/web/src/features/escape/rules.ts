/**
 * Feature 1 (WP10): the escape rules, pure functions of one keystroke. They
 * read the LaTeX context from before the keystroke (WP08's contextAt) and
 * return the backslash to insert in front of the typed character:
 *
 * | Typed | Text  | Table (top level of a cell) | Math | Comment, verbatim, literal, code |
 * |-------|-------|-----------------------------|------|----------------------------------|
 * | `&`   | `\&`  | raw (separates cells)       | raw  | raw                              |
 * | `%`   | `\%` only straight after a number, otherwise raw (a comment) | same | same | raw |
 * | `#`   | `\#`  | `\#`                        | `\#` | raw (`#1`, URL fragments)        |
 *
 * Nothing happens after an odd run of backslashes (`\&` typed by hand), when
 * the syntax tree is not ready (contextAt returns null), or when the
 * keystroke replaced a selection. The automatic-edit core decides when rules
 * run at all (one local keystroke, never a collaborator's change).
 */
import type { Text } from '@codemirror/state';
import { contextAt, type TexContext } from '../../editor/texContext';
import { AUTO_EDIT_PRIORITY, type AutoEdit, type AutoEditRule, type TypedInput } from '../../editor/core/types';

export const ESCAPE_SETTING = { amp: 'escape.amp', percent: 'escape.percent', hash: 'escape.hash', paste: 'escape.paste', chip: 'escape.chip' } as const;

/** Whether the character at `pos` is escaped by the backslashes in front of it (an odd run). */
export function escapedAt(doc: Text, pos: number): boolean {
  let n = 0;
  const start = Math.max(0, pos - 200);
  const before = doc.sliceString(start, pos);
  for (let i = before.length - 1; i >= 0 && before[i] === '\\'; i--) n++;
  return n % 2 === 1;
}

/**
 * Whether a `%` typed at `pos` follows a number: a digit run (`50`, `3.5`,
 * `1,000`), optionally with a thin space after it (`12\,`), whose start is
 * not part of a control word's argument (`\penalty10000`, `\kern-3`) or a
 * key-value pair (`width=50`).
 */
export function percentFollowsNumber(doc: Text, pos: number): boolean {
  const start = Math.max(0, pos - 80);
  let s = doc.sliceString(start, pos);
  // A thin space `\,` straight after the number (one backslash, not `\\,`).
  if (s.endsWith('\\,') && !s.endsWith('\\\\,')) s = s.slice(0, -2);
  const m = /\d+(?:[.,]\d+)*$/.exec(s);
  if (!m) return false;
  let i = m.index;
  if (i > 0 && (s[i - 1] === '-' || s[i - 1] === '+')) i--;
  if (i === 0) return start === 0;
  const prev = s[i - 1];
  if (prev === '=') return false;
  if (/[A-Za-z@]/.test(prev)) {
    // Letters before the number: a control word's argument when they follow a backslash.
    let j = i - 1;
    while (j >= 0 && /[A-Za-z@]/.test(s[j])) j--;
    if (j < 0) return true;
    let slashes = 0;
    for (let k = j; k >= 0 && s[k] === '\\'; k--) slashes++;
    return slashes % 2 === 0;
  }
  return true;
}

/** The contexts in which a typed character is escaped. */
const AMP_KINDS = new Set<TexContext['kind']>(['text']);
const SPECIAL_KINDS = new Set<TexContext['kind']>(['text', 'table', 'math']);

/** The context at the keystroke, or null when nothing may happen there. */
function eligible(t: TypedInput, char: string): TexContext | null {
  if (t.char !== char || t.from !== t.to) return null;
  if (escapedAt(t.before.doc, t.from)) return null;
  return contextAt(t.before, t.from);
}

const edit = (rule: string, t: TypedInput, notice: string): AutoEdit => ({
  rule,
  changes: { from: t.from, insert: '\\' },
  notice: { kind: rule, text: notice, settingId: rule },
});

export const ampRule: AutoEditRule = {
  id: ESCAPE_SETTING.amp,
  priority: AUTO_EDIT_PRIORITY.escape,
  settingId: ESCAPE_SETTING.amp,
  run(t) {
    const cx = eligible(t, '&');
    if (!cx || !AMP_KINDS.has(cx.kind)) return null;
    return edit(ESCAPE_SETTING.amp, t, 'Typed & became \\& (a plain & only works in tables and math). Backspace undoes it.');
  },
};

export const percentRule: AutoEditRule = {
  id: ESCAPE_SETTING.percent,
  priority: AUTO_EDIT_PRIORITY.escape,
  settingId: ESCAPE_SETTING.percent,
  run(t) {
    const cx = eligible(t, '%');
    if (!cx || !SPECIAL_KINDS.has(cx.kind)) return null;
    if (!percentFollowsNumber(t.before.doc, t.from)) return null;
    return edit(ESCAPE_SETTING.percent, t, 'Typed % after a number became \\%. Anywhere else % starts a comment. Backspace undoes it.');
  },
};

export const hashRule: AutoEditRule = {
  id: ESCAPE_SETTING.hash,
  priority: AUTO_EDIT_PRIORITY.escape,
  settingId: ESCAPE_SETTING.hash,
  run(t) {
    const cx = eligible(t, '#');
    if (!cx || !SPECIAL_KINDS.has(cx.kind)) return null;
    return edit(ESCAPE_SETTING.hash, t, 'Typed # became \\#. Backspace undoes it.');
  },
};

export const ESCAPE_RULES: readonly AutoEditRule[] = [ampRule, percentRule, hashRule];
