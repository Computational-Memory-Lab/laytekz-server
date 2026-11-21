/**
 * F12 auto-close pairs (WP12): the LaTeX pairs closeBrackets does not know,
 * typing over closers the editor added, Backspace inside a new pair, Tab out
 * of a closer, and Enter inside `\[¦\]`. Plain `( [ {` stay with
 * closeBrackets (core/brackets.ts); this file only widens where they close.
 *
 * Everything here acts on one local keystroke with one empty cursor in a
 * writable document. Remote and undo transactions carry no input event, so
 * nothing here runs for them. Where the syntax tree is not ready
 * (`contextAt` returns null) the LaTeX pairs do nothing and typing is plain.
 */
import { EditorSelection, EditorState, Facet, Prec, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getIndentUnit, indentString } from '@codemirror/language';
import { closerAt, closerAutoTrack, closerField, trackClosers, untrackCloser, type TrackedCloser } from '../../editor/core/brackets';
import { contextAt } from '../../editor/texContext';

export interface PairsConfig {
  /** Wider closeBrackets, completion braces tracked, type-over. */
  brackets: boolean;
  /** `$`, `\(\)`, `\[\]`, `\{\}` in math, `\left…\right`. */
  math: boolean;
  /** `` `' `` and ``` ``'' ```. */
  quotes: boolean;
  /** Tab steps out of a tracked closer. */
  tabOut: boolean;
}

export const NO_PAIRS: PairsConfig = { brackets: false, math: false, quotes: false, tabOut: false };

/** The switches in force in this editor (the feature's compartment provides it). */
export const pairsConfig = Facet.define<PairsConfig, PairsConfig>({
  combine: (v) => v[v.length - 1] ?? NO_PAIRS,
});

/** Characters before which `( [ {` close, besides whitespace and the end of
 *  the line (LaTeX Workshop's list plus `'` `~` `&`). */
export const BRACKET_BEFORE = ")]}:;>.,=$\\'`~&";
/** Characters before which `$`, `` ` `` and the LaTeX delimiters pair. */
const PAIR_BEFORE = ")]}:;.,!?'~&";

const TEXT_KINDS = new Set(['text', 'table']);

/** An odd run of backslashes ends at `pos`: the character typed there is escaped. */
export function escapedAt(doc: { sliceString(from: number, to: number): string }, pos: number): boolean {
  let n = 0;
  const start = Math.max(0, pos - 64);
  const before = doc.sliceString(start, pos);
  for (let i = before.length - 1; i >= 0 && before[i] === '\\'; i--) n++;
  return n % 2 === 1;
}

function canPairBefore(next: string, list: string): boolean {
  return next === '' || /\s/.test(next) || list.includes(next);
}

/**
 * The number of unescaped `$` between the start of the paragraph and `pos`,
 * comments left out: even means a `$` typed at `pos` opens a formula.
 */
export function dollarsBefore(state: EditorState, pos: number): number {
  let line = state.doc.lineAt(pos);
  const lines: string[] = [state.doc.sliceString(line.from, pos)];
  let budget = 4000;
  while (line.number > 1 && budget > 0) {
    line = state.doc.line(line.number - 1);
    if (!line.text.trim()) break;
    lines.unshift(line.text);
    budget -= line.length;
  }
  let count = 0;
  for (const text of lines) {
    let backslashes = 0;
    for (const ch of text) {
      if (ch === '\\') { backslashes++; continue; }
      const escaped = backslashes % 2 === 1;
      backslashes = 0;
      if (ch === '%' && !escaped) break;
      if (ch === '$' && !escaped) count++;
    }
  }
  return count;
}

function kindAt(state: EditorState, pos: number): string | null {
  return contextAt(state, pos)?.kind ?? null;
}

/** Insert `open` + `close` at `pos`, caret between, the closer tracked. */
function insertPair(view: EditorView, pos: number, open: string, close: string, opener: string): true {
  const caret = pos + open.length;
  const closer: TrackedCloser = { from: caret, to: caret + close.length, text: close, openerEnd: caret, open: opener };
  view.dispatch({
    changes: { from: pos, insert: open + close },
    selection: { anchor: caret },
    effects: trackClosers.of([closer]),
    userEvent: 'input.type',
    scrollIntoView: true,
  });
  return true;
}

const LEFT_RE = /(?:^|[^\\])(?:\\\\)*\\(left|bigl|Bigl|biggl|Biggl)(\\?)$/;
const RIGHT_OF: Record<string, string> = { left: 'right', bigl: 'bigr', Bigl: 'Bigr', biggl: 'biggr', Biggl: 'Biggr' };
const DELIM_CLOSE: Record<string, string> = { '(': ')', '[': ']', '.': '.', '|': '|', '{': '\\}' };

/** Typing over (or typing out) a tracked closer at `pos`. */
function typeOver(view: EditorView, pos: number, ch: string): boolean {
  const state = view.state;
  const c = closerAt(state, pos);
  if (!c) return false;
  if (c.text === ch) {
    view.dispatch({ selection: { anchor: c.to }, effects: untrackCloser.of(c.from), userEvent: 'input.type', scrollIntoView: true });
    return true;
  }
  if (c.text.length > 1 && c.text.endsWith(ch) && c.openerEnd != null) {
    // `\` then `)` before `\)`, `\right` then `)` before `\right)`: the typed part goes, the caret steps over.
    const prefix = c.text.slice(0, -1);
    const start = pos - prefix.length;
    if (start < c.openerEnd || state.doc.sliceString(start, pos) !== prefix) return false;
    if (prefix.startsWith('\\') && escapedAt(state.doc, start)) return false;
    view.dispatch({
      changes: { from: start, to: pos },
      selection: { anchor: start + c.text.length },
      effects: untrackCloser.of(start),
      userEvent: 'input.type',
      scrollIntoView: true,
    });
    return true;
  }
  return false;
}

/** A second `$` in an empty `$¦$` the editor just made gives display math: `$$¦$$`. */
function doubleDollar(view: EditorView, pos: number): boolean {
  const state = view.state;
  const c = closerAt(state, pos);
  if (c && c.text === '$' && c.openerEnd === pos && state.doc.sliceString(pos - 1, pos) === '$') {
    view.dispatch({
      changes: { from: pos, insert: '$$' },
      selection: { anchor: pos + 1 },
      effects: [untrackCloser.of(pos + 2), trackClosers.of([{ from: pos + 1, to: pos + 3, text: '$$', openerEnd: pos + 1, open: '$$' }])],
      userEvent: 'input.type',
      scrollIntoView: true,
    });
    return true;
  }
  return false;
}

function typeDollar(view: EditorView, pos: number): boolean {
  const state = view.state;
  if (escapedAt(state.doc, pos)) return false;
  if (!canPairBefore(state.doc.sliceString(pos, pos + 1), PAIR_BEFORE)) return false;
  if (state.doc.sliceString(pos - 1, pos) === '$') return false;
  const kind = kindAt(state, pos);
  if (!kind || !TEXT_KINDS.has(kind)) return false;
  if (dollarsBefore(state, pos) % 2 === 1) return false;
  return insertPair(view, pos, '$', '$', '$');
}

function typeBacktick(view: EditorView, pos: number): boolean {
  const state = view.state;
  const c = closerAt(state, pos);
  if (c && c.text === "'" && c.openerEnd === pos && state.doc.sliceString(pos - 1, pos) === '`') {
    view.dispatch({
      changes: { from: pos, insert: "`'" },
      selection: { anchor: pos + 1 },
      effects: [untrackCloser.of(pos + 2), trackClosers.of([{ from: pos + 1, to: pos + 3, text: "''", openerEnd: pos + 1, open: '``' }])],
      userEvent: 'input.type',
      scrollIntoView: true,
    });
    return true;
  }
  const prev = state.doc.sliceString(pos - 1, pos);
  // `\`` is the grave accent, `"`` a babel shorthand, and a backtick inside a word is not a quote.
  if (prev === '\\' || prev === '"' || prev === '`' || /[\p{L}\p{N}]/u.test(prev)) return false;
  if (!canPairBefore(state.doc.sliceString(pos, pos + 1), PAIR_BEFORE)) return false;
  const kind = kindAt(state, pos);
  if (!kind || !TEXT_KINDS.has(kind)) return false;
  return insertPair(view, pos, '`', "'", '`');
}

/** `(` `[` `{` `.` `|` typed after a backslash, or after `\left`. */
function typeDelimiter(view: EditorView, pos: number, ch: string): boolean {
  const state = view.state;
  const line = state.doc.lineAt(pos);
  const before = state.doc.sliceString(Math.max(line.from, pos - 80), pos);
  const left = LEFT_RE.exec(before);
  if (left && (left[2] ? ch === '{' : '([.|'.includes(ch))) {
    if (kindAt(state, pos) !== 'math') return false;
    const close = `\\${RIGHT_OF[left[1]]}${DELIM_CLOSE[ch]}`;
    return insertPair(view, pos, ch, close, `\\${left[1]}${left[2]}${ch}`);
  }
  if (!'([{'.includes(ch) || !escapedAt(state.doc, pos)) return false;
  const kind = kindAt(state, pos);
  if (!kind) return false;
  if (ch === '{') {
    if (kind === 'math') return insertPair(view, pos, '{', '\\}', '\\{');
    if (!TEXT_KINDS.has(kind)) return false;
    // `\{` in text is a literal brace: no `}` closer, which would unbalance the group.
    view.dispatch({ changes: { from: pos, insert: '{' }, selection: { anchor: pos + 1 }, userEvent: 'input.type', scrollIntoView: true });
    return true;
  }
  if (!TEXT_KINDS.has(kind) || !canPairBefore(state.doc.sliceString(pos, pos + 1), BRACKET_BEFORE)) return false;
  return insertPair(view, pos, ch, ch === '(' ? '\\)' : '\\]', `\\${ch}`);
}

/** `$` or `` ` `` over a selection in text wraps it. */
function wrapSelection(view: EditorView, from: number, to: number, ch: string, cfg: PairsConfig): boolean {
  if (!((ch === '$' && cfg.math) || (ch === '`' && cfg.quotes))) return false;
  const state = view.state;
  if (escapedAt(state.doc, from)) return false;
  const kind = kindAt(state, from);
  if (!kind || !TEXT_KINDS.has(kind)) return false;
  const close = ch === '$' ? '$' : "'";
  view.dispatch({
    changes: [{ from, insert: ch }, { from: to, insert: close }],
    selection: EditorSelection.single(from + 1, to + 1),
    userEvent: 'input.type',
    scrollIntoView: true,
  });
  return true;
}

/** The input handler: runs after keyBraceGuard and \begin's `}`, before closeBrackets. */
export const pairsInput: Extension = Prec.high(EditorView.inputHandler.of((view, from, to, text) => {
  if (text.length !== 1 || view.composing) return false;
  const state = view.state;
  if (state.readOnly || state.selection.ranges.length !== 1) return false;
  const cfg = state.facet(pairsConfig);
  if (from !== to) return wrapSelection(view, from, to, text, cfg);
  if (cfg.math && text === '$' && doubleDollar(view, from)) return true;
  if (typeOver(view, from, text)) return true;
  if (cfg.math && text === '$') return typeDollar(view, from);
  if (cfg.quotes && text === '`') return typeBacktick(view, from);
  if (cfg.math && '([{.|'.includes(text)) return typeDelimiter(view, from, text);
  return false;
}));

function singleCaret(state: EditorState): number | null {
  const sel = state.selection;
  if (state.readOnly || sel.ranges.length !== 1 || !sel.main.empty) return null;
  return sel.main.head;
}

/** Backspace 90: inside a pair the editor just made (`$¦$`, `\(¦\)`, `\left(¦\right)`, `` `¦' ``). */
export function deletePair(view: EditorView): boolean {
  const state = view.state;
  const pos = singleCaret(state);
  if (pos == null) return false;
  const c = closerAt(state, pos);
  if (!c || !c.open || c.openerEnd !== pos || c.open.length < 1) return false;
  if (state.doc.sliceString(pos - c.open.length, pos) !== c.open) return false;
  // closeBrackets' own `(¦)` `[¦]` `{¦}` are its Backspace's (80).
  if (c.open.length === 1 && '([{'.includes(c.open)) return false;
  if (c.text === '$$' || c.text === "''") {
    const single = c.text[0];
    view.dispatch({
      changes: [{ from: pos - 1, to: pos }, { from: pos, to: pos + 1 }],
      selection: { anchor: pos - 1 },
      effects: [untrackCloser.of(pos - 1), trackClosers.of([{ from: pos - 1, to: pos, text: single, openerEnd: pos - 1, open: single === '$' ? '$' : '`' }])],
      userEvent: 'delete.backward',
    });
    return true;
  }
  view.dispatch({
    changes: [{ from: pos - 1, to: pos }, { from: c.from, to: c.to }],
    selection: { anchor: pos - 1 },
    effects: untrackCloser.of(pos - 1),
    userEvent: 'delete.backward',
  });
  return true;
}

/** Tab 72: the caret steps past the closer right after it. */
export function stepOut(view: EditorView): boolean {
  const state = view.state;
  if (!state.facet(pairsConfig).tabOut) return false;
  const pos = singleCaret(state);
  if (pos == null) return false;
  const c = closerAt(state, pos);
  if (!c) return false;
  view.dispatch({ selection: { anchor: c.to }, effects: untrackCloser.of(c.from), userEvent: 'select', scrollIntoView: true });
  return true;
}

/** Enter 90: `\[¦\]` becomes three lines with the caret on the middle one. */
export function splitDisplay(view: EditorView): boolean {
  const state = view.state;
  if (!state.facet(pairsConfig).math) return false;
  const pos = singleCaret(state);
  if (pos == null) return false;
  if (state.doc.sliceString(pos - 2, pos + 2) !== '\\[\\]' || escapedAt(state.doc, pos - 2)) return false;
  const line = state.doc.lineAt(pos);
  const lead = /^\s*/.exec(line.text)![0];
  const inner = lead + indentString(state, getIndentUnit(state));
  view.dispatch({
    changes: { from: pos, insert: `\n${inner}\n${lead}` },
    selection: { anchor: pos + 1 + inner.length },
    effects: untrackCloser.of(pos + 2 + inner.length + lead.length),
    userEvent: 'input',
    scrollIntoView: true,
  });
  return true;
}

/** The editor extension for these switches; nothing at all when every switch is off. */
export function pairsExtension(cfg: PairsConfig, o: { visual?: boolean } = {}): Extension {
  // Visual mode draws formulas and quotes itself: there only the bracket behaviour runs.
  const eff: PairsConfig = o.visual ? { ...cfg, math: false, quotes: false } : cfg;
  if (!eff.brackets && !eff.math && !eff.quotes && !eff.tabOut) return [];
  return [
    pairsConfig.of(eff),
    closerField,
    closerAutoTrack.of(eff.brackets || eff.tabOut),
    eff.brackets ? Prec.highest(EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{'], before: BRACKET_BEFORE } }])) : [],
    pairsInput,
  ];
}
