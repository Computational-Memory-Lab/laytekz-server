/**
 * Bracket handling in the code editor (WP05 editor-host, core extraction with
 * no behaviour change): matching, closing and its Backspace, and the closing
 * of a \begin{…} brace. It groups what @codemirror/language,
 * @codemirror/autocomplete, editor/latexExtras.ts and editor/beginEnv.ts
 * export; those files are not changed here. CodePane places each part where
 * V1 had it: the order of input handlers and keymaps decides which runs first.
 */
import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension, type Transaction } from '@codemirror/state';
import { keymap, type KeyBinding } from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { keyBraceGuard, latexCloseBrackets } from '../latexExtras';
import { closeBeginBrace, closeBeginBraceInput } from '../beginEnv';

/** Matching-bracket highlight, then closing brackets: (, [ and { everywhere, " in a .bib file. */
export function bracketExtensions(filePath: string): Extension {
  return [
    bracketMatching(),
    closeBrackets(),
    latexCloseBrackets(filePath),
  ];
}

/** `}` after \begin{name} adds the \end{name} block (the key and the typed
 *  character, for layouts that type it without a key event); then the guard
 *  that keeps a completed key from gaining a second closing brace. */
export function beginBraceExtensions(): Extension {
  return [
    Prec.high(keymap.of([{ key: '}', run: closeBeginBrace }])),
    closeBeginBraceInput,
    keyBraceGuard,
  ];
}

/** Backspace between an empty pair deletes both; in the editor's main keymap. */
export const bracketKeymap: readonly KeyBinding[] = closeBracketsKeymap;

// ---- closer tracking (WP12 auto-pairs) ----
//
// A closer the editor put after the caret: a brace a completion inserted
// (`\textbf{¦}`), the `}` of a pair closeBrackets inserted, or a LaTeX pair's
// closer (`$`, `\)`, `\right)`, `'`). Typing the closer, or typing it out
// (`\` then `)` before `\)`), steps over it instead of doubling it, and Tab
// steps out of it. The field exists only while the pairs feature runs; the
// effects are harmless without it. Like closeBrackets' own state, a closer
// is forgotten once the caret leaves its line or its text changes.

export interface TrackedCloser {
  from: number;
  to: number;
  /** The closer's text (`}`, `$$`, `\right)`). */
  text: string;
  /** Where the opener ends (the caret's place when the pair was made), for
   *  Backspace and for typing a closer out; absent for a completion's brace. */
  openerEnd?: number;
  /** The opener's text (`$`, `\(`, `\left(`), when the editor made the pair. */
  open?: string;
}

/** Track these closers (positions in the transaction's new document). */
export const trackClosers = StateEffect.define<readonly TrackedCloser[]>();
/** Forget the closer that starts at this position (in the new document). */
export const untrackCloser = StateEffect.define<number>();
/** True: braces a completion inserts after the caret and closeBrackets' own
 *  pairs are tracked too (the pairs feature's "brackets" or "Tab" switch). */
export const closerAutoTrack = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) });

const CLOSER_CHARS = /[)\]}]/;
const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** The closers a local transaction itself put after the caret, on the caret's line. */
function autoTracked(tr: Transaction): TrackedCloser[] {
  if (!tr.docChanged || !tr.state.facet(closerAutoTrack)) return [];
  const sel = tr.state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return [];
  const head = sel.main.head;
  const line = tr.state.doc.lineAt(head);
  const out: TrackedCloser[] = [];
  if (tr.isUserEvent('input.complete')) {
    tr.changes.iterChanges((_fa, _ta, fromB, _tb, inserted) => {
      const text = inserted.toString();
      for (let i = 0; i < text.length; i++) {
        const pos = fromB + i;
        if (pos >= head && pos < line.to && CLOSER_CHARS.test(text[i])) out.push({ from: pos, to: pos + 1, text: text[i] });
      }
    });
  } else if (tr.isUserEvent('input.type') && !tr.isUserEvent('input.type.compose')) {
    // closeBrackets' pair: one change inserting exactly `()`, `[]` or `{}` with the caret inside.
    const changes: { empty: boolean; fromB: number; text: string }[] = [];
    tr.changes.iterChanges((fa, ta, fromB, _tb, inserted) => { changes.push({ empty: fa === ta, fromB, text: inserted.toString() }); });
    const c = changes.length === 1 && changes[0].empty ? changes[0] : null;
    if (c && c.text.length === 2 && PAIRS[c.text[0]] === c.text[1] && head === c.fromB + 1) {
      out.push({ from: head, to: head + 1, text: c.text[1], openerEnd: head, open: c.text[0] });
    }
  }
  return out;
}

function mapCloser(c: TrackedCloser, tr: Transaction): TrackedCloser | null {
  const from = tr.changes.mapPos(c.from, 1);
  const to = tr.changes.mapPos(c.to, -1);
  if (to - from !== c.text.length || tr.state.doc.sliceString(from, to) !== c.text) return null;
  const openerEnd = c.openerEnd == null ? undefined : tr.changes.mapPos(c.openerEnd, -1);
  return { ...c, from, to, openerEnd };
}

export const closerField: StateField<readonly TrackedCloser[]> = StateField.define<readonly TrackedCloser[]>({
  create: () => [],
  update(value, tr) {
    let next: TrackedCloser[] = tr.docChanged
      ? value.map((c) => mapCloser(c, tr)).filter((c): c is TrackedCloser => c !== null)
      : [...value];
    for (const e of tr.effects) {
      if (e.is(untrackCloser)) next = next.filter((c) => c.from !== e.value);
      else if (e.is(trackClosers)) {
        for (const c of e.value) {
          if (tr.state.doc.sliceString(c.from, c.to) !== c.text) continue;
          next = next.filter((o) => o.from !== c.from);
          next.push(c);
        }
      }
    }
    for (const c of autoTracked(tr)) {
      if (!next.some((o) => o.from === c.from)) next.push(c);
    }
    if (tr.selection || tr.docChanged) {
      const line = tr.state.doc.lineAt(tr.state.selection.main.head);
      next = next.filter((c) => c.from >= line.from && c.from <= line.to);
    }
    return next.length === value.length && next.every((c, i) => c === value[i]) ? value : next;
  },
});

/** The tracked closer that starts at `pos`, if any. */
export function closerAt(state: EditorState, pos: number): TrackedCloser | null {
  const list = state.field(closerField, false);
  return list?.find((c) => c.from === pos) ?? null;
}
