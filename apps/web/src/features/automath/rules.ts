/**
 * Automatic math mode's rules (WP11, feature 2): pure functions of one
 * keystroke, run by the automatic-edit core (editor/core/autoEdit.ts).
 *
 * Lazy, like autocorrect: they act only when a word ends (a space,
 * `, . ; : ! ?`, or a closing `) ] }`, closeBrackets stepping over its own
 * closer included), in text or at a table's top level, and look at the word
 * that ends at the caret. Enter is not a boundary.
 * - T1: a single letter, a digit run (with `^` only), a math command, a bare
 *   operator name or a parenthesis group without words, with one or two
 *   scripts: `x_i` `x^10` `x_max` `lim_n` `(a+b)^2` `\alpha_1`.
 * - T2: a math-only command with its arguments: `\alpha` `\frac{1}{2}` `\mathbb{R}`,
 *   and the document's own macros whose definition is math.
 * - T3: a relation between a letter (or a T1/T2 word) and a number or a letter: `p < .05` `n = 30`.
 * - T5: a math word after a formula this run of typing created, on the same
 *   line, with only operators, numbers and single letters between: `$x_1$ + y_2` → `$x_1 + y_2$`.
 * Wrapping braces a script longer than one character and puts a backslash
 * before an operator name. A word that is not math but has an `_` between
 * letters or digits (`my_var`, `results_final.csv`) gets `\_` instead (its
 * own rule and setting). In monospace text (`\texttt{x_1}`) only the
 * underscore rule runs. Math, comments, verbatim, literal arguments
 * (`\cite{a_b}`, `\label`, paths, URLs) and code are never touched, nor is a
 * word led by a command that is not math (`\foo_1`, `\cite{a_b}`).
 */
import { Facet, StateField, type EditorState, type Extension, type Text, type Transaction } from '@codemirror/state';
import { contextAt, inlineMathStyle, type TexContext } from '../../editor/texContext';
import { autoEditMark } from '../../editor/core/autoEdit';
import { AUTO_EDIT_PRIORITY, type AutoEdit, type AutoEditRule, type TypedInput } from '../../editor/core/types';
import { GREEK_LETTERS, MATH_ONLY_COMMANDS, MATH_OPERATOR_NAMES } from '../../latex/vocab';
import { AUTO_MATH_RULES, autoMathFormatters, type AutoMathFormatterInput } from './api';
import { AUTO_MATH_SETTING_IDS, type DelimiterChoice } from './settings';

// ---- configuration the editor extension provides (settings that are not on/off switches) ----

export interface AutoMathConfig { delimiter: DelimiterChoice; tabOut: boolean }
export const DEFAULT_CONFIG: AutoMathConfig = { delimiter: 'auto', tabOut: true };

export const autoMathConfig: Facet<AutoMathConfig, AutoMathConfig> = Facet.define<AutoMathConfig, AutoMathConfig>({
  combine: (values) => values[values.length - 1] ?? DEFAULT_CONFIG,
});

/** The inline delimiters a wrap uses in this document. */
export function delimitersFor(state: EditorState): { open: string; close: string } {
  const choice = state.facet(autoMathConfig).delimiter;
  const style = choice === 'auto' ? inlineMathStyle(state.doc) : choice;
  return style === 'paren' ? { open: '\\(', close: '\\)' } : { open: '$', close: '$' };
}

// ---- vocabulary ----

const OPERATOR_NAMES: ReadonlySet<string> = new Set(MATH_OPERATOR_NAMES);
const MATH_COMMANDS: ReadonlySet<string> = new Set([...GREEK_LETTERS, ...MATH_ONLY_COMMANDS, ...MATH_OPERATOR_NAMES]);
/** Commands that mean nothing on their own (sizes and delimiters): never wrapped without more. */
const NOT_ALONE: ReadonlySet<string> = new Set([
  'left', 'right', 'middle', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr',
]);
/** Relations and binary operators: on their own right after a word they wait for the right-hand side (T3, T5). */
const INFIX: ReadonlySet<string> = new Set([
  'le', 'leq', 'ge', 'geq', 'neq', 'ne', 'approx', 'sim', 'simeq', 'equiv', 'in', 'notin', 'to', 'cong', 'propto',
  'cdot', 'times', 'pm', 'mp', 'div', 'subset', 'subseteq', 'supset', 'supseteq', 'll', 'gg', 'mapsto',
]);

const BOUNDARY = new Set([' ', ',', '.', ';', ':', '!', '?', ')', ']', '}']);
const PUNCTUATION_END = /[.,;:!?]+$/;
const NUMBER = /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const RELATION_SRC = String.raw`(=|<|>|≤|≥|≠|\\(?:leq?|geq?|neq?|approx|sim|equiv|in|to)(?![A-Za-z]))`;
/** Left operand, gap, relation, gap, right operand, ending at the word's end. */
const RELATION_RE = new RegExp(String.raw`(^|[\s(\[{~])([^\s(\[{~]+?)(\s*)` + RELATION_SRC + String.raw`(\s*)(\S+)$`);
const UNICODE_RELATION: Readonly<Record<string, string>> = { '≤': '\\le', '≥': '\\ge', '≠': '\\neq' };
/** One item between a fresh formula and the next math word (T5). */
const GAP_ITEM = String.raw`(?:[-+*/=<>≤≥≠]|\\(?:cdot|times|pm|mp|le|leq|ge|geq|neq|ne|approx|sim|equiv|in|to)(?![A-Za-z])|[-+]?(?:\d+(?:\.\d+)?|\.\d+)|[A-Za-z])`;
const GAP_RE = new RegExp(String.raw`^(?:\s+${GAP_ITEM})*\s+$`);
const GAP_OPERATOR = /[-+*/=<>≤≥≠]|\\[A-Za-z]+/;

// ---- the document's own math macros ----

const MACRO_SCAN = 60_000;
const NEWCOMMAND_RE = /\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z]+)\}?\s*(?:\[\d\])?\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g;
const MATH_OPERATOR_RE = /\\DeclareMathOperator\*?\s*\{?\\([A-Za-z]+)\}?/g;
const macroCache = new WeakMap<Text, ReadonlySet<string>>();

function isMathBody(body: string): boolean {
  if (/\$|\\(?:ensuremath|text|mbox|textbf|textit|emph)\b/.test(body)) return false;
  for (const m of body.matchAll(/\\([A-Za-z]+)/g)) if (MATH_COMMANDS.has(m[1])) return true;
  return /[_^]/.test(body);
}

/** Macros the document defines as math (`\newcommand{\R}{\mathbb{R}}`, `\DeclareMathOperator{\Var}{Var}`). */
export function documentMathMacros(doc: Text): ReadonlySet<string> {
  const hit = macroCache.get(doc);
  if (hit) return hit;
  const text = doc.sliceString(0, Math.min(doc.length, MACRO_SCAN)).replace(/(^|[^\\])%.*$/gm, '$1');
  const names = new Set<string>();
  for (const m of text.matchAll(NEWCOMMAND_RE)) if (isMathBody(m[2])) names.add(m[1]);
  for (const m of text.matchAll(MATH_OPERATOR_RE)) names.add(m[1]);
  macroCache.set(doc, names);
  return names;
}

// ---- parsing a word ----

/** The index of the bracket closing the one at `open`, or -1. */
function closeOf(s: string, open: number): number {
  const o = s[open];
  const c = o === '{' ? '}' : o === '(' ? ')' : ']';
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === o) depth++;
    else if (s[i] === c && --depth === 0) return i;
  }
  return -1;
}

/** The index of the bracket opening the one at `close`, or -1. */
function openOf(s: string, close: number): number {
  const c = s[close];
  const o = c === '}' ? '{' : c === ')' ? '(' : '[';
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (i > 0 && s[i - 1] === '\\') continue;
    if (s[i] === c) depth++;
    else if (s[i] === o && --depth === 0) return i;
  }
  return -1;
}

const STOP = new Set([' ', '\t', ' ', '(', '[', '{', '~', '`', '"']);

/** Where the word ending at `end` starts: back to a space, the line's start or an opening bracket; brackets it closes are skipped whole. */
export function wordStart(text: string, end: number): number {
  let i = end;
  while (i > 0) {
    const c = text[i - 1];
    if ((c === '}' || c === ')' || c === ']') && !(i > 1 && text[i - 2] === '\\')) {
      const open = openOf(text, i - 1);
      if (open < 0) break;
      i = open;
      continue;
    }
    if (STOP.has(c)) break;
    i--;
  }
  return i;
}

/** A math operand, normalised; `bare` marks a letter or number alone (math only next to a relation). */
export interface Operand { tex: string; bare: 'letter' | 'number' | null; lone?: string }

/**
 * Reads `s` as one math word. Null: not math. 'command': led by a command
 * that is not math (never touched, not even its underscores).
 */
export function parseOperand(s: string, macros: ReadonlySet<string> = new Set()): Operand | 'command' | null {
  if (!s) return null;
  if (NUMBER.test(s)) return { tex: s, bare: 'number' };
  let i: number;
  let base: string;
  let kind: 'letter' | 'digits' | 'cmd' | 'op' | 'paren';
  let name = '';
  const c = s[0];
  if (c === '\\') {
    const m = /^\\([A-Za-z]+)/.exec(s);
    if (!m) return null;
    name = m[1];
    if (!MATH_COMMANDS.has(name) && !macros.has(name)) return 'command';
    i = m[0].length;
    if (s[i] === '[') {
      const j = closeOf(s, i);
      if (j < 0) return null;
      i = j + 1;
    }
    while (s[i] === '{') {
      const j = closeOf(s, i);
      if (j < 0) return null;
      i = j + 1;
    }
    base = s.slice(0, i);
    kind = 'cmd';
  } else if (c >= '0' && c <= '9') {
    const m = /^\d+/.exec(s)!;
    base = m[0];
    i = base.length;
    kind = 'digits';
  } else if (/[A-Za-z]/.test(c)) {
    const word = /^[A-Za-z]+/.exec(s)![0];
    i = word.length;
    if (word.length === 1) { base = word; kind = 'letter'; }
    else if (OPERATOR_NAMES.has(word)) { base = `\\${word}`; kind = 'op'; }
    else return null;
  } else if (c === '(') {
    const j = closeOf(s, 0);
    if (j < 1) return null;
    const inner = s.slice(1, j);
    if (!inner.trim() || /[A-Za-z]{2,}/.test(inner.replace(/\\[A-Za-z]+/g, '')) || /[$%&#]/.test(inner)) return null;
    base = s.slice(0, j + 1);
    i = j + 1;
    kind = 'paren';
  } else return null;

  const marks = new Set<string>();
  let scripts = '';
  while (i < s.length) {
    const mark = s[i];
    if ((mark !== '_' && mark !== '^') || marks.has(mark)) return null;
    marks.add(mark);
    i++;
    let arg: string;
    if (s[i] === '{') {
      const j = closeOf(s, i);
      if (j < 0) return null;
      arg = s.slice(i, j + 1);
      i = j + 1;
    } else if (s[i] === '\\') {
      const m = /^\\[A-Za-z]+/.exec(s.slice(i));
      if (!m) return null;
      let k = i + m[0].length;
      while (s[k] === '{') {
        const j = closeOf(s, k);
        if (j < 0) return null;
        k = j + 1;
      }
      const raw = s.slice(i, k);
      arg = k > i + m[0].length ? `{${raw}}` : raw;
      i = k;
    } else {
      const m = /^(?:[A-Za-z0-9]+|[-+]\d+)/.exec(s.slice(i));
      if (!m) return null;
      arg = m[0].length > 1 ? `{${m[0]}}` : m[0];
      i += m[0].length;
    }
    scripts += mark + arg;
  }
  if (kind === 'digits') return marks.has('^') && !marks.has('_') ? { tex: base + scripts, bare: null } : null;
  if (!marks.size) {
    if (kind === 'letter') return { tex: base, bare: 'letter' };
    if (kind !== 'cmd' || NOT_ALONE.has(name)) return null;
    return { tex: base, bare: null, lone: INFIX.has(name) && base === `\\${name}` ? name : undefined };
  }
  return { tex: base + scripts, bare: null };
}

/** A name with an `_` between letters or digits: `my_var`, `snake_case_name`, `file_1.tex`, `j_doe@x.com`. */
function rawUnderscores(word: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < word.length - 1; i++) {
    if (word[i] === '_' && word[i - 1] !== '\\' && /[A-Za-z0-9]/.test(word[i - 1]) && /[A-Za-z0-9]/.test(word[i + 1])) out.push(i);
  }
  return out;
}

// ---- the formula this run of typing created (T5) ----

interface Fresh { from: number; to: number }

/** The span of the last formula automatic math mode wrote, while the caret stays on its line and nothing moves it. */
export const freshFormula: StateField<Fresh | null> = StateField.define<Fresh | null>({
  create: () => null,
  update(value, tr: Transaction) {
    if (tr.annotation(autoEditMark) === AUTO_MATH_RULES.wrap && tr.docChanged) {
      let from = Infinity;
      let to = -1;
      tr.changes.iterChangedRanges((_fa, _ta, fb, tb) => { from = Math.min(from, fb); to = Math.max(to, tb); });
      if (value) {
        const prevFrom = tr.changes.mapPos(value.from, 1);
        const prevTo = tr.changes.mapPos(value.to, -1);
        if (from >= prevFrom && from <= prevTo) from = prevFrom;
      }
      return to >= from ? { from, to } : null;
    }
    if (!value) return null;
    let next = value;
    if (tr.docChanged) {
      let inside = false;
      tr.changes.iterChangedRanges((fa, ta) => { if (ta > value.from && fa < value.to) inside = true; });
      if (inside) return null;
      next = { from: tr.changes.mapPos(value.from, 1), to: tr.changes.mapPos(value.to, -1) };
    } else if (tr.selection) return null;
    const head = tr.state.selection.main.head;
    const doc = tr.state.doc;
    if (head < next.to || doc.lineAt(head).number !== doc.lineAt(next.to).number) return null;
    return next;
  },
});

// ---- the rules ----

type Plan =
  | { kind: 'wrap'; changes: { from: number; to?: number; insert: string }[]; shown: string }
  | { kind: 'identifier'; changes: { from: number; insert: string }[]; shown: string };

function textual(ctx: TexContext | null): boolean {
  return !!ctx && (ctx.kind === 'text' || ctx.kind === 'table') && !ctx.math;
}

function replacement(from: number, to: number, original: string, tex: string, open: string, close: string): { from: number; to?: number; insert: string }[] {
  return original === tex
    ? [{ from, insert: open }, { from: to, insert: close }]
    : [{ from, to, insert: open + tex + close }];
}

/** What a word ending at `t.from` calls for, if anything. Pure. */
export function planFor(t: TypedInput): Plan | null {
  if (t.from !== t.to || t.char.length !== 1 || !BOUNDARY.has(t.char)) return null;
  const state = t.before;
  const at = t.from;
  const line = state.doc.lineAt(at);
  const text = line.text.slice(0, at - line.from);
  const start = wordStart(text, text.length);
  if (start >= text.length) return null;
  const word = text.slice(start, text.length);
  if (word.includes('$')) return null;
  const ctx = contextAt(state, at);
  if (!textual(ctx) || !textual(contextAt(state, line.from + start, { side: 1 }))) return null;

  const core = word.replace(PUNCTUATION_END, '');
  if (!core) return null;
  const coreEnd = start + core.length;

  if (ctx!.mono) return identifierPlan(word, line.from + start);

  const macros = word.includes('\\') ? documentMathMacros(state.doc) : new Set<string>();
  const { open, close } = delimitersFor(state);

  // A feature's formatter first (WP38's statistics).
  const formatters = state.facet(autoMathFormatters);
  if (formatters.length) {
    const input: AutoMathFormatterInput = { state, at, char: t.char, lineFrom: line.from, text, open, close };
    for (const f of formatters) {
      let r: ReturnType<typeof f.format> = null;
      try { r = f.format(input); } catch { r = null; }
      if (r && r.from >= line.from && r.from <= r.to && r.to <= at) {
        return { kind: 'wrap', changes: [{ from: r.from, to: r.to, insert: r.insert }], shown: state.sliceDoc(r.from, r.to) };
      }
    }
  }

  const operand = parseOperand(core, macros);
  if (operand === 'command') return null;

  // A decimal point is not the end of a number: wait for its digits.
  const decimalPending = (o: Operand) => t.char === '.' && o.bare === 'number' && !o.tex.includes('.');

  // T5: a math word after the formula this run created, with only operators, numbers and letters between.
  const fresh = state.field(freshFormula, false);
  if (operand && fresh && fresh.to <= line.from + start && fresh.from >= line.from && !decimalPending(operand)) {
    const gap = text.slice(fresh.to - line.from, start);
    const freshText = state.sliceDoc(fresh.from, fresh.to);
    const closer = freshText.endsWith('\\)') ? '\\)' : freshText.endsWith('$') && !freshText.endsWith('\\$') ? '$' : '';
    if (closer && GAP_RE.test(gap) && GAP_OPERATOR.test(gap)) {
      const tex = gap.replace(/[≤≥≠]/g, (u) => UNICODE_RELATION[u]) + operand.tex;
      return {
        kind: 'wrap',
        changes: [{ from: fresh.to - closer.length, to: line.from + coreEnd, insert: tex + closer }],
        shown: state.sliceDoc(fresh.from, line.from + coreEnd),
      };
    }
  }

  // T3: a relation between a letter or math word and a number, a letter or a math word.
  const rel = RELATION_RE.exec(text.slice(0, coreEnd));
  if (rel) {
    const left = parseOperand(rel[2], macros);
    const right = parseOperand(rel[6], macros);
    if (left && left !== 'command' && left.bare !== 'number' && right && right !== 'command') {
      if (decimalPending(right)) return null;
      const from = line.from + rel.index + rel[1].length;
      const to = line.from + coreEnd;
      if (textual(contextAt(state, from, { side: 1 }))) {
        const relation = UNICODE_RELATION[rel[4]] ?? rel[4];
        const tex = left.tex + rel[3] + relation + rel[5] + right.tex;
        return { kind: 'wrap', changes: replacement(from, to, state.sliceDoc(from, to), tex, open, close), shown: state.sliceDoc(from, to) };
      }
    }
  }

  // T1 and T2: a math word on its own.
  if (operand && operand.bare === null) {
    if (operand.lone) {
      // A relation right after a word waits for its right-hand side.
      const before = text.slice(0, start).trimEnd();
      if (before && /[A-Za-z0-9})$]$/.test(before)) return null;
    }
    const from = line.from + start;
    const to = line.from + coreEnd;
    return { kind: 'wrap', changes: replacement(from, to, core, operand.tex, open, close), shown: core };
  }
  if (operand) return null;
  if (word.startsWith('\\') && /^\\[A-Za-z]/.test(word)) return null;
  return identifierPlan(word, line.from + start);
}

function identifierPlan(word: string, from: number): Plan | null {
  const spots = rawUnderscores(word);
  if (!spots.length) return null;
  return { kind: 'identifier', changes: spots.map((i) => ({ from: from + i, insert: '\\' })), shown: word };
}

function short(s: string): string {
  return s.length > 32 ? `${s.slice(0, 31)}…` : s;
}

export const wrapRule: AutoEditRule = {
  id: AUTO_MATH_RULES.wrap,
  priority: AUTO_EDIT_PRIORITY.autoMath,
  settingId: AUTO_MATH_SETTING_IDS.wrap,
  run(t): AutoEdit | null {
    const plan = planFor(t);
    if (!plan || plan.kind !== 'wrap') return null;
    return {
      rule: AUTO_MATH_RULES.wrap,
      changes: plan.changes,
      notice: { kind: AUTO_MATH_RULES.wrap, text: `Laytekz put ${short(plan.shown)} in math mode. Backspace right after undoes it.`, settingId: AUTO_MATH_SETTING_IDS.wrap },
    };
  },
};

export const identifierRule: AutoEditRule = {
  id: AUTO_MATH_RULES.identifier,
  priority: AUTO_EDIT_PRIORITY.identifierUnderscore,
  settingId: AUTO_MATH_SETTING_IDS.identifiers,
  run(t): AutoEdit | null {
    const plan = planFor(t);
    if (!plan || plan.kind !== 'identifier') return null;
    return {
      rule: AUTO_MATH_RULES.identifier,
      changes: plan.changes,
      notice: { kind: AUTO_MATH_RULES.identifier, text: `Laytekz escaped the underscore in ${short(plan.shown)}. Backspace right after undoes it.`, settingId: AUTO_MATH_SETTING_IDS.identifiers },
    };
  },
};

/** The editor extension: the settings the rules and Tab read, and the fresh-formula field. */
export function autoMathExtension(config: AutoMathConfig): Extension {
  return [autoMathConfig.of(config), freshFormula];
}
