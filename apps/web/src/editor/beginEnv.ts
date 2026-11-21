import { Facet, Prec, type EditorState, type TransactionSpec } from '@codemirror/state';
import { indentUnit } from '@codemirror/language';
import { EditorView } from '@codemirror/view';

/* Galley: V2 (WP31) one environment closer. Typing the } of \begin{name}, Enter
   at the end of a \begin line and an environment completion all ask
   planEnvClose, which adds \end{name} only when no \end is waiting for it.
   The envclose feature runs it as an automatic edit (its own undo step,
   Backspace reverts it); without the feature, closeBeginBrace below keeps
   Version 1's `}` behaviour, minus the duplicate \end. */

/** How far around the caret the environment scans read, each way. */
const SCAN_LIMIT = 200_000;

/** Environments whose body TeX reads as raw text: no \begin or \end inside counts. */
const RAW_ENVS = new Set([
  'verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'BVerbatim', 'LVerbatim',
  'lstlisting', 'minted', 'comment', 'filecontents', 'filecontents*',
]);

/** Environments that start with a mandatory argument: closing one leaves the caret in `{¦}`. */
export const ARG_ENVS: ReadonlySet<string> = new Set([
  'tabular', 'tabular*', 'tabularx', 'tabulary', 'array', 'minipage', 'multicols', 'multicols*',
  'wrapfigure', 'subfigure', 'thebibliography',
]);

/** A complete `\begin{name}` or `\end{name}`: `from`/`to` span it, `nameFrom`/`nameTo` the name. */
export interface EnvToken {
  kind: 'begin' | 'end';
  name: string;
  from: number;
  to: number;
  nameFrom: number;
  nameTo: number;
}

export interface EnvScan {
  tokens: EnvToken[];
  /** Comments, \verb arguments and raw environment bodies (inclusive ends). */
  raw: { from: number; to: number }[];
}

const TOKEN_RE = /\\(begin|end)[ \t]*\{([^{}\n%\\]*)\}|\\verb\*?(?![A-Za-z])|\\[\s\S]|%/g;

/** The environment tokens of `text` (which starts at document position `offset`). */
export function scanEnvText(text: string, offset = 0): EnvScan {
  const tokens: EnvToken[] = [];
  const raw: { from: number; to: number }[] = [];
  const re = new RegExp(TOKEN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const at = m.index;
    if (m[0] === '%') {
      const eol = text.indexOf('\n', at);
      const end = eol < 0 ? text.length : eol;
      raw.push({ from: offset + at, to: offset + end });
      re.lastIndex = end;
      continue;
    }
    if (m[1]) {
      const kind = m[1] as 'begin' | 'end';
      const nameFrom = at + m[0].indexOf('{') + 1;
      const tok: EnvToken = { kind, name: m[2], from: offset + at, to: offset + at + m[0].length, nameFrom: offset + nameFrom, nameTo: offset + nameFrom + m[2].length };
      tokens.push(tok);
      if (kind === 'begin' && RAW_ENVS.has(m[2])) {
        const close = text.indexOf(`\\end{${m[2]}}`, re.lastIndex);
        const end = close < 0 ? text.length : close;
        raw.push({ from: offset + re.lastIndex, to: offset + end });
        if (close < 0) break;
        re.lastIndex = close;
      }
      continue;
    }
    if (m[0].startsWith('\\verb')) {
      const delim = text[re.lastIndex];
      if (!delim || delim === '\n') continue;
      const close = text.indexOf(delim, re.lastIndex + 1);
      const eol = text.indexOf('\n', re.lastIndex);
      const end = close < 0 || (eol >= 0 && close > eol) ? (eol < 0 ? text.length : eol) : close + 1;
      raw.push({ from: offset + re.lastIndex, to: offset + end });
      re.lastIndex = end;
    }
  }
  return { tokens, raw };
}

/** The tokens of the lines around `pos`, at most SCAN_LIMIT characters each way. */
export function envScan(state: EditorState, pos: number): EnvScan {
  const doc = state.doc;
  const from = doc.lineAt(Math.max(0, pos - SCAN_LIMIT)).from;
  const to = doc.lineAt(Math.min(doc.length, pos + SCAN_LIMIT)).to;
  return scanEnvText(doc.sliceString(from, to), from);
}

/** Whether `pos` lies in a comment, a \verb argument or a raw environment's body. */
export function rawAt(scan: EnvScan, pos: number): boolean {
  return scan.raw.some((r) => r.from <= pos && pos <= r.to);
}

/** The \begin tokens before `pos` that no \end before `pos` closes, outermost first. */
export function openEnvsBefore(tokens: readonly EnvToken[], pos: number): EnvToken[] {
  const stack: EnvToken[] = [];
  for (const t of tokens) {
    if (t.to > pos) break;
    if (t.kind === 'begin') stack.push(t);
    else stack.pop();
  }
  return stack;
}

/** The \end tokens after `pos` that no \begin after `pos` opens, nearest first. */
export function unmatchedEndsAfter(tokens: readonly EnvToken[], pos: number): EnvToken[] {
  const out: EnvToken[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.from < pos) continue;
    if (t.kind === 'begin') depth++;
    else if (depth) depth--;
    else out.push(t);
  }
  return out;
}

/**
 * Whether a `\begin{name}` spanning `beginFrom`…`afterPos` already has its
 * \end: the \end tokens after it that nothing after it opens outnumber the
 * environments still open before it, and the nearest of them is `\end{name}`.
 */
export function envAlreadyClosed(scan: EnvScan, beginFrom: number, afterPos: number, name: string): boolean {
  const open = openEnvsBefore(scan.tokens, beginFrom);
  const ends = unmatchedEndsAfter(scan.tokens, afterPos);
  return ends.length > open.length && ends[0].name === name;
}

/** The innermost environment open at `pos` (for `\end{`), or null. */
export function innermostOpenEnv(state: EditorState, pos: number): string | null {
  const open = openEnvsBefore(envScan(state, pos).tokens, pos);
  return open.length ? open[open.length - 1].name : null;
}

/** An odd run of backslashes ends at `pos`: the character there is escaped. */
function escapedBefore(state: EditorState, pos: number): boolean {
  let n = 0;
  while (pos - n - 1 >= 0 && state.sliceDoc(pos - n - 1, pos - n) === '\\') n++;
  return n % 2 === 1;
}

const NAME_RE = /^[A-Za-z@][A-Za-z0-9@:*-]*$/;

export interface EnvClosePlan {
  changes: { from: number; insert: string };
  selection: { anchor: number };
  name: string;
  /** The environment takes an argument: the caret waits in `{¦}` on the \begin line. */
  args: boolean;
}

/**
 * What closing the `\begin{name}` that ends right before `pos` inserts, or
 * null when it must not close: the rest of the line is not blank, the
 * \begin is in a comment or raw text, or an \end is already waiting for it.
 * `args`: an argument environment gets `{¦}` (ARG_ENVS).
 */
export function planEnvClose(state: EditorState, pos: number, o: { args?: boolean } = {}): EnvClosePlan | null {
  const line = state.doc.lineAt(pos);
  if (state.sliceDoc(pos, line.to).trim()) return null;
  const m = /\\begin[ \t]*\{([^{}\n%\\]*)\}$/.exec(state.sliceDoc(line.from, pos));
  if (!m || !NAME_RE.test(m[1])) return null;
  const beginFrom = line.from + m.index;
  if (escapedBefore(state, beginFrom)) return null;
  const scan = envScan(state, pos);
  if (rawAt(scan, beginFrom) || envAlreadyClosed(scan, beginFrom, pos, m[1])) return null;
  const lead = /^[ \t]*/.exec(line.text)![0];
  const inner = lead + state.facet(indentUnit);
  const end = `\\end{${m[1]}}`;
  if (o.args && ARG_ENVS.has(m[1])) {
    return { changes: { from: pos, insert: `{}\n${inner}\n${lead}${end}` }, selection: { anchor: pos + 1 }, name: m[1], args: true };
  }
  return { changes: { from: pos, insert: `\n${inner}\n${lead}${end}` }, selection: { anchor: pos + 1 + inner.length }, name: m[1], args: false };
}

/**
 * What Enter at `pos` (the end of a `\begin{name}…` line, arguments allowed)
 * should close: the name and the line's indentation, or null.
 */
export function planEnterClose(state: EditorState, pos: number): { name: string; lead: string } | null {
  const line = state.doc.lineAt(pos);
  if (state.sliceDoc(pos, line.to).trim()) return null;
  const m = /\\begin[ \t]*\{([^{}\n%\\]*)\}((?:[ \t]*(?:\[[^\]\n]*\]|\{[^{}\n]*\}))*)[ \t]*$/.exec(state.sliceDoc(line.from, pos));
  if (!m || !NAME_RE.test(m[1])) return null;
  const beginFrom = line.from + m.index;
  if (escapedBefore(state, beginFrom)) return null;
  const scan = envScan(state, pos);
  if (rawAt(scan, beginFrom) || envAlreadyClosed(scan, beginFrom, pos, m[1])) return null;
  return { name: m[1], lead: /^[ \t]*/.exec(line.text)![0] };
}

/** The name group of a `\begin{…}`/`\end{…}` holding `from`…`to` (ends included), or null. */
export function envNameAt(state: EditorState, from: number, to = from): EnvToken | null {
  const line = state.doc.lineAt(from);
  if (to > line.to) return null;
  const re = /\\(begin|end)[ \t]*\{([^{}\n%\\]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.text))) {
    const nameFrom = line.from + m.index + m[0].indexOf('{') + 1;
    const nameTo = nameFrom + m[2].length;
    if (nameFrom > from) break;
    if (to <= nameTo && !escapedBefore(state, line.from + m.index)) {
      return { kind: m[1] as 'begin' | 'end', name: m[2], from: line.from + m.index, to: line.from + m.index + m[0].length, nameFrom, nameTo };
    }
  }
  return null;
}

/** The \end of a \begin token, or the \begin of an \end token, matched by position; null outside the scan or in raw text. */
export function envPartner(state: EditorState, tok: EnvToken, scan: EnvScan = envScan(state, tok.from)): EnvToken | null {
  const i = scan.tokens.findIndex((t) => t.from === tok.from && t.kind === tok.kind);
  if (i < 0) return null;
  let depth = 0;
  if (tok.kind === 'begin') {
    for (let j = i + 1; j < scan.tokens.length; j++) {
      const t = scan.tokens[j];
      if (t.kind === 'begin') depth++;
      else if (depth) depth--;
      else return t;
    }
  } else {
    for (let j = i - 1; j >= 0; j--) {
      const t = scan.tokens[j];
      if (t.kind === 'end') depth++;
      else if (depth) depth--;
      else return t;
    }
  }
  return null;
}

/** True while the envclose feature runs in this editor: it closes environments
 *  itself (or, switched off, not at all), so closeBeginBrace stands aside. */
export const envCloseOwned = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) });

/**
 * The `}` that finishes `\begin{name`: closes the environment in the same
 * transaction (Version 1's behaviour where the envclose feature does not
 * run), stepping over closeBrackets' own `}` when one follows the caret. An
 * environment that already has its \end gets the brace alone.
 */
export function closeBeginBrace(view: { state: EditorState; dispatch(spec: TransactionSpec): void }): boolean {
  // Galley: V2 (WP31) stands aside for the envclose feature; otherwise both brace cases, through planEnvClose.
  const { state } = view;
  if (state.facet(envCloseOwned)) return false;
  if (state.selection.ranges.length > 1) return false;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (!/\\begin\{([^{}]+)$/.test(state.sliceDoc(line.from, sel.head))) return false;
  const stepOver = state.sliceDoc(sel.head, sel.head + 1) === '}';
  const braced = stepOver ? state : state.update({ changes: { from: sel.head, insert: '}' } }).state;
  const plan = planEnvClose(braced, sel.head + 1);
  if (!plan) return false;
  view.dispatch({
    changes: stepOver ? plan.changes : [{ from: sel.head, insert: '}' }, { from: sel.head, insert: plan.changes.insert }],
    selection: plan.selection,
    scrollIntoView: true,
    userEvent: 'input.type',
  });
  return true;
}

/**
 * closeBeginBrace for a `}` that arrives as typed text instead of through the
 * key binding: CodeMirror matches no `}` binding when the character needs
 * Option (macOS German and similar layouts), and closeBrackets' own input
 * handler would only step over its brace, leaving the environment unclosed.
 */
export const closeBeginBraceInput = Prec.high(EditorView.inputHandler.of((view, from, to, text) =>
  text === '}' && from === to && view.state.selection.main.head === from && closeBeginBrace(view)));
