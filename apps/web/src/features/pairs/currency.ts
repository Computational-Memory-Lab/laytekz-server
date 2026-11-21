/**
 * The currency guard (WP12): `$5 ` typed in prose becomes `\$5 `, so a
 * price never opens a formula. An automatic edit (core/autoEdit.ts): one
 * undo step, Backspace right after reverts it, never for a collaborator's
 * change. When the `$` came with an automatic closer (`$5 ¦$`), the closer
 * goes in the same edit.
 */
import type { EditorState } from '@codemirror/state';
import { AUTO_EDIT_PRIORITY, type AutoEdit, type AutoEditRule, type TypedInput } from '../../editor/core/types';
import { closerAt } from '../../editor/core/brackets';
import { contextAt } from '../../editor/texContext';
import { dollarsBefore, escapedAt } from './pairs';
import { PAIRS_SETTINGS } from './settings';

/** A `$`, an amount (`5`, `1,200.50`, `3k`, `2M`, `4bn`), then the caret. */
const AMOUNT_RE = /\$(\d[\d,.]*(?:k|K|m|M|bn|B)?)$/;

/** True when an unescaped `$` other than `except` follows `pos` on its line. */
function laterDollar(state: EditorState, pos: number, except: number | null): boolean {
  const line = state.doc.lineAt(pos);
  const rest = state.doc.sliceString(pos, line.to);
  let backslashes = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '\\') { backslashes++; continue; }
    const escaped = backslashes % 2 === 1;
    backslashes = 0;
    if (ch === '%' && !escaped) return false;
    if (ch === '$' && !escaped && pos + i !== except) return true;
  }
  return false;
}

export function currencyEdit(t: TypedInput): AutoEdit | null {
  if (t.char !== ' ' || t.from !== t.to) return null;
  const s = t.before;
  const line = s.doc.lineAt(t.from);
  const m = AMOUNT_RE.exec(s.doc.sliceString(Math.max(line.from, t.from - 40), t.from));
  if (!m) return null;
  const dollar = t.from - m[0].length;
  if (escapedAt(s.doc, dollar) || s.doc.sliceString(dollar - 1, dollar) === '$') return null;
  const kind = contextAt(s, dollar)?.kind;
  if (kind !== 'text' && kind !== 'table') return null;
  // An even count before it: this `$` would open a formula, not close one.
  if (dollarsBefore(s, dollar) % 2 === 1) return null;
  const closer = closerAt(s, t.from);
  const autoCloser = closer && closer.text === '$' && closer.openerEnd === dollar + 1 ? closer : null;
  if (s.doc.sliceString(t.from, t.from + 1) === '$' && !autoCloser) return null;
  if (laterDollar(s, t.from, autoCloser ? autoCloser.from : null)) return null;
  // Positions in `after`: the space sits at t.from, an automatic closer right after it.
  const changes = autoCloser
    ? [{ from: dollar, insert: '\\' }, { from: t.from + 1, to: t.from + 2 }]
    : [{ from: dollar, insert: '\\' }];
  return {
    rule: 'pairs.currency',
    changes,
    notice: { kind: 'pairs.currency', text: `Typed $${m[1]} became \\$${m[1]}, a dollar amount. Backspace undoes it.`, settingId: PAIRS_SETTINGS.currency },
  };
}

export const currencyRule: AutoEditRule = {
  id: 'pairs.currency',
  priority: AUTO_EDIT_PRIORITY.currencyGuard,
  settingId: PAIRS_SETTINGS.currency,
  run: currencyEdit,
};
