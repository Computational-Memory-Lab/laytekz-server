/**
 * The shared LaTeX context (WP08 typing-core): what kind of text a position
 * is in, the formula, table environment and command around it, and two
 * document-wide facts. Every grammar workaround of the editor-typing report
 * (§1.2–3.1) lives here and nowhere else:
 * - an empty `$¦$`, which the grammar reads as the start of `$$…`, is inline math;
 * - `\mbox`, `\hbox`, `\textup`, `\textnormal` (TEXT_IN_MATH) in math are text,
 *   and any other command's argument in math is math (`\operatorname`, `\textcolor`);
 * - `\multicolumn`'s third argument looks like a table body to the grammar: a
 *   position is at a table's top level only when no argument, brace group,
 *   nested environment or formula lies between it and the table, so an `&`
 *   inside braces (\parbox, \makecell, minipage) is text;
 * - table and verbatim environments the grammar does not know (tabular*,
 *   tblr, verbatim*, alltt, filecontents …) come from the vocabulary, the
 *   `extraTableEnvironments` facet, the preamble's own wrappers, and a name
 *   heuristic (`mytabular`, never `mytable`);
 * - commands whose arguments are literal (keys, paths, units, colours) or
 *   code (definitions, settings, options) come from the vocabulary when the
 *   grammar calls them UnknownCommand;
 * - the preamble is code except the arguments of title-like commands;
 * - comments are decided from the line (an unescaped `%` that is not inside
 *   verbatim or a URL), which also covers the end of the file.
 * Command names in the results are written without the backslash.
 */
import { Facet, type EditorState, type Text } from '@codemirror/state';
import { ensureSyntaxTree, language, syntaxTree } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';
import type { CommandSpan, Formula, TableEnv, TableFamily, TexContext, TexCtxKind } from './types';
import {
  CODE_ENVS, MONO, PREAMBLE_TEXT, ROLE_ARG_KIND, TEXT_IN_MATH, THEOREM_ENVS, VERBATIM_ENVS, VERBATIM_READ,
  commandRole, environmentRole, grammarRole, isMathEnvName, knownNonTable, literalDetail, stripStar,
  tableArgsSignature, tableLikeName, vocabTableFamily, type Role,
} from './names';
import {
  DELIMITED_MATH, ancestors, argsOf, commandNameOf, envNameIn, envNameOf, envParts, groupInner, isCommandNode,
  isEnvNode, mathSpan, type ArgSpan, type Doc, type EnvParts,
} from './tree';
import {
  argumentsEnd, cellColumn, documentClassOffset, escapedAt, mathStyleOf, packagesOf, percentOffsets,
  preambleInfo, preambleText, type PreambleInfo,
} from './scan';

export type { ArgKind, CommandSpan, Formula, TableEnv, TableFamily, TexContext, TexCtxKind } from './types';

/**
 * More environment names that hold a text table (`tabular` family), for
 * environments a class or package defines that the vocabulary does not know.
 * A feature provides `extraTableEnvironments.of(names)` (a settings list).
 */
export const extraTableEnvironments: Facet<readonly string[], ReadonlySet<string>> = Facet.define<readonly string[], ReadonlySet<string>>({
  combine: (lists) => new Set(lists.flat()),
});

/** How long a call may parse to reach the position (the editor's own parse is usually ahead). */
const PARSE_BUDGET_MS = 25;
/** How far past the position formulaAt, tableEnvAt and commandAt parse, so a construct's end is known. */
const LOOKAHEAD = 20_000;

function treeUpTo(s: EditorState, upto: number, timeout = PARSE_BUDGET_MS): Tree | null {
  if (!s.facet(language)) return null;
  return ensureSyntaxTree(s, Math.min(s.doc.length, upto), timeout);
}

/** The tree past `pos`, or what is parsed so far when that takes too long. */
function treeAround(s: EditorState, pos: number): Tree | null {
  if (!s.facet(language)) return null;
  return treeUpTo(s, pos + LOOKAHEAD, 2 * PARSE_BUDGET_MS) ?? syntaxTree(s);
}

function tableFamilyOf(s: EditorState, name: string, preamble: () => PreambleInfo): TableFamily | null {
  const known = vocabTableFamily(name);
  if (known) return known;
  if (s.facet(extraTableEnvironments).has(name)) return 'tabular';
  if (knownNonTable(name)) return null;
  const wrapped = preamble().tables.get(name);
  if (wrapped) return wrapped;
  return tableLikeName(name) ? 'tabular' : null;
}

/** A table environment's body starts after its arguments: the vocabulary's signature when it has one, else what the parser took. */
function tableBodyFrom(doc: Text, name: string, parts: EnvParts): number {
  const group = parts.begin.getChild('EnvNameGroup');
  if (!group || !vocabTableFamily(name)) return parts.bodyFrom;
  return argumentsEnd(doc, group.to, tableArgsSignature(name) ?? '') ?? parts.bodyFrom;
}

function isDocumentEnv(n: SyntaxNode, doc: Doc): boolean {
  return n.name === 'DocumentEnvironment' || (isEnvNode(n) && envNameOf(n, doc) === 'document');
}

interface TableLayer { env: string; family: TableFamily; bodyFrom: number }
interface HardLayer { t: 'hard'; kind: 'verbatim' | 'literal' | 'code'; detail: string }
interface MathLayer { t: 'math'; delim: '$' | '$$' | '\\(' | '\\[' | 'env'; display: boolean; env?: string; table?: TableLayer }
interface TextLayer { t: 'text'; preambleText: boolean }
/** An argument, brace group, nested environment or math argument: not a table's top level any more. */
interface CrossLayer { t: 'cross' }
type Layer = HardLayer | MathLayer | TextLayer | CrossLayer | ({ t: 'table' } & TableLayer);

/** Whether a command node sits in math (MathCommand > KnownCommand > TextColorCommand, MathUnknownCommand). */
function commandInMath(n: SyntaxNode, a: ArgSpan): boolean {
  return a.names.includes('MathArgument') || n.name.startsWith('Math')
    || n.parent?.name === 'MathCommand' || n.parent?.parent?.name === 'MathCommand';
}

/** Whether the character at `at` is taken as written (verbatim content, a URL, \path), so a `%` there starts no comment. */
function literalAt(tree: Tree, doc: Doc, at: number): boolean {
  for (const n of ancestors(tree.resolveInner(at, 1))) {
    if (n.name === 'VerbatimContent' || n.name === 'VerbContent' || n.name === 'LstInlineContent' || n.name === 'LiteralArgContent') return true;
    if (isEnvNode(n)) {
      const parts = envParts(n);
      if (at >= parts.bodyFrom && at < parts.bodyTo && (n.name === 'VerbatimEnvironment' || VERBATIM_ENVS.has(envNameOf(n, doc)))) return true;
    } else if (isCommandNode(n) && VERBATIM_READ.has(stripStar(commandNameOf(n, doc)))) {
      if (argsOf(n, doc).some((a) => a.from <= at && at <= a.to)) return true;
    }
  }
  return false;
}

/** Whether an unescaped `%` before `pos` on its line starts a comment. */
function inComment(tree: Tree, doc: Text, pos: number): boolean {
  const line = doc.lineAt(pos);
  for (const i of percentOffsets(line.text, pos - line.from)) {
    if (!literalAt(tree, doc, line.from + i)) return true;
  }
  return false;
}

/** An empty `$¦$`: the grammar opened `$$` at `pos - 1` and runs it on to the next blank line. */
function emptyDollarPair(tree: Tree, doc: Text, pos: number): boolean {
  if (pos < 1 || pos >= doc.length || doc.sliceString(pos - 1, pos + 1) !== '$$') return false;
  if (doc.sliceString(Math.max(0, pos - 2), pos - 1) === '$' || doc.sliceString(pos + 1, pos + 2) === '$') return false;
  const lead = doc.sliceString(Math.max(0, pos - 41), pos - 1);
  if (escapedAt(lead, lead.length)) return false;
  for (let n: SyntaxNode | null = tree.resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'DollarMath') return n.from === pos - 1;
  }
  return false;
}

/**
 * The context at `pos`; null when the document has no LaTeX tree or the
 * tree does not reach `pos` yet (callers then do nothing). `side` picks the
 * node a boundary position resolves into first, as Tree.resolveInner does.
 */
export function contextAt(s: EditorState, pos: number, o?: { side?: -1 | 1 }): TexContext | null {
  const doc = s.doc;
  if (pos < 0 || pos > doc.length) return null;
  const tree = treeUpTo(s, pos);
  if (!tree) return null;
  const chain = ancestors(tree.resolveInner(pos, o?.side ?? -1));
  const docEnv = chain.find((n) => isDocumentEnv(n, doc)) ?? null;
  let info: PreambleInfo | null = null;
  const preamble = (): PreambleInfo => (info ??= preambleInfo(preambleText(doc, docEnv ? docEnv.from : undefined)));

  const layers: Layer[] = [];
  const envs: string[] = [];
  let arg: TexContext['arg'] = null;
  let mono = false;
  let inBody = false;
  let afterDocument = false;

  const push = (role: Role, command: string, base: string, index: number, a: ArgSpan, titleText: boolean) => {
    const argKind = ROLE_ARG_KIND[role];
    if (argKind && !arg) arg = { command, kind: argKind, index, from: a.from, to: a.to };
    switch (role) {
      case 'V': layers.push({ t: 'hard', kind: 'verbatim', detail: base }); mono = true; return;
      case 'M': layers.push({ t: 'cross' }); return;
      case 'T': layers.push({ t: 'text', preambleText: titleText }); return;
      case 'N': case 'D': layers.push({ t: 'hard', kind: 'code', detail: 'definition' }); return;
      case 'O': layers.push({ t: 'hard', kind: 'code', detail: 'option' }); return;
      default: layers.push({ t: 'hard', kind: 'literal', detail: literalDetail(role, base) });
    }
  };

  for (const n of chain) {
    if (isEnvNode(n)) {
      const name = envNameOf(n, doc);
      const parts = envParts(n);
      const beginArgs = argsOf(parts.begin, doc);
      const bi = beginArgs.findIndex((a) => a.from <= pos && pos <= a.to);
      if (bi >= 0) {
        const a = beginArgs[bi];
        if (a.names[0] === 'EnvNameGroup') push('E', 'begin', 'begin', bi, a, false);
        else {
          const k = beginArgs.slice(0, bi).filter((b) => b.optional === a.optional && b.names[0] !== 'EnvNameGroup').length;
          const theorem = a.optional && (THEOREM_ENVS.has(name) || preamble().theorems.has(name));
          push(environmentRole(name, a.optional, k, theorem), 'begin', name, bi, a, false);
        }
        continue;
      }
      const endName = parts.end ? argsOf(parts.end, doc).find((a) => a.names[0] === 'EnvNameGroup' && a.from <= pos && pos <= a.to) : undefined;
      if (endName) {
        push('E', 'end', 'end', 0, endName, false);
        continue;
      }
      if (pos < parts.bodyFrom || pos > parts.bodyTo) {
        if (isDocumentEnv(n, doc) && parts.end && pos >= parts.end.to) afterDocument = true;
        continue;
      }
      envs.push(name);
      if (isDocumentEnv(n, doc)) { inBody = true; continue; }
      if (n.name === 'VerbatimEnvironment' || VERBATIM_ENVS.has(name)) {
        layers.push({ t: 'hard', kind: 'verbatim', detail: name });
        mono = true;
        continue;
      }
      if (n.name === 'TikzPictureEnvironment' || CODE_ENVS.has(name)) {
        layers.push({ t: 'hard', kind: 'code', detail: name });
        continue;
      }
      const family = tableFamilyOf(s, name, preamble);
      const table = family ? { env: name, family, bodyFrom: tableBodyFrom(doc, name, parts) } : undefined;
      if (n.name === 'EquationEnvironment' || n.name === 'EquationArrayEnvironment' || isMathEnvName(name)) {
        layers.push({ t: 'math', delim: 'env', display: name !== 'math', env: name, table });
      } else if (table) {
        layers.push({ t: 'table', ...table });
      } else {
        layers.push({ t: 'cross' });
      }
      continue;
    }
    if (DELIMITED_MATH.has(n.name)) {
      const m = mathSpan(n);
      if (m && pos >= m.innerFrom && pos <= m.innerTo) layers.push({ t: 'math', delim: m.delim, display: m.display });
      continue;
    }
    if (isCommandNode(n)) {
      const name = commandNameOf(n, doc);
      const base = stripStar(name);
      const args = argsOf(n, doc);
      const i = args.findIndex((a) => a.from <= pos && pos <= a.to);
      if (i < 0) continue;
      const a = args[i];
      const k = args.slice(0, i).filter((b) => b.optional === a.optional).length;
      let role: Role = grammarRole(a.names) ?? commandRole(base, a.optional, k) ?? (a.optional ? 'O' : 'T');
      if (role === 'T' && !TEXT_IN_MATH.has(base) && commandInMath(n, a)) role = 'M';
      if (MONO.has(base)) mono = true;
      push(role, name, base, i, a, PREAMBLE_TEXT.has(base));
      continue;
    }
    if ((n.name === 'Group' || n.name === 'NonEmptyGroup') && n.firstChild?.name === 'OpenBrace') {
      const [from, to] = groupInner(n);
      if (pos >= from && pos <= to) layers.push({ t: 'cross' });
      continue;
    }
    if (n.name === 'TrailingContent') afterDocument = true;
  }

  if (!layers.some((l) => l.t === 'math') && emptyDollarPair(tree, doc, pos)) layers.unshift({ t: 'math', delim: '$', display: false });

  const preambleHere = !inBody && !afterDocument && !docEnv && documentClassOffset(doc) !== null;
  const base = {
    env: envs[0] ?? null,
    envStack: [...envs].reverse(),
    preamble: preambleHere,
    inDocument: inBody || (!docEnv && !preambleHere && !afterDocument),
  };

  if (inComment(tree, doc, pos)) {
    return { kind: 'comment', detail: '', ...base, math: null, table: null, arg: null, mono: false };
  }

  const mi = layers.findIndex((l) => l.t === 'math');
  const math = mi >= 0 ? mathInfo(layers, mi) : null;
  const table = tableInfo(layers, doc, pos);
  const hard = layers.find((l): l is HardLayer => l.t === 'hard');
  let kind: TexCtxKind;
  let detail = '';
  if (hard) {
    kind = hard.kind;
    detail = hard.detail;
  } else if (math) {
    kind = math.info.textInside ? 'text' : 'math';
    detail = math.info.textInside ? 'text in math' : math.detail;
  } else if (table?.topLevel) {
    kind = 'table';
    detail = `cell ${table.column + 1}`;
  } else if (preambleHere && !layers.some((l) => l.t === 'text' && l.preambleText)) {
    kind = 'code';
    detail = 'preamble';
  } else if (afterDocument) {
    kind = 'code';
    detail = 'after document';
  } else {
    kind = 'text';
  }
  return { kind, detail, ...base, math: math?.info ?? null, table, arg, mono };
}

/** The formula the innermost math layer belongs to: math layers outward until text or code interrupts. */
function mathInfo(layers: readonly Layer[], mi: number): { info: NonNullable<TexContext['math']>; detail: string } {
  const first = layers[mi] as MathLayer;
  const textInside = layers.slice(0, mi).some((l) => l.t === 'text');
  let outer = first;
  let innerEnv = first.env;
  for (let j = mi + 1; j < layers.length; j++) {
    const l = layers[j];
    if (l.t === 'math') {
      outer = l;
      innerEnv ??= l.env;
    } else if (l.t !== 'cross') break;
  }
  const info: NonNullable<TexContext['math']> = { delim: outer.delim, display: outer.display, textInside };
  if (outer.delim === 'env' && outer.env) info.env = outer.env;
  return { info, detail: innerEnv ?? (outer.display ? 'display' : 'inline') };
}

function tableInfo(layers: readonly Layer[], doc: Text, pos: number): TexContext['table'] {
  const ti = layers.findIndex((l) => l.t === 'table' || (l.t === 'math' && l.table));
  if (ti < 0) return null;
  const l = layers[ti];
  const t = l.t === 'table' ? l : (l as MathLayer).table!;
  return { env: t.env, family: t.family, column: cellColumn(doc, t.bodyFrom, pos), topLevel: ti === 0 };
}

/** Math the grammar parses but a formula previewer cannot draw. */
const NOT_FORMULAS = new Set(['tikzcd']);
const ENV_NODES = new Set(['Environment', 'EquationEnvironment', 'EquationArrayEnvironment']);

function formulaOf(n: SyntaxNode, doc: Doc): Formula | null {
  if (DELIMITED_MATH.has(n.name)) {
    const m = mathSpan(n);
    if (!m || !m.closed) return null;
    return {
      from: n.from, to: n.to, innerFrom: m.innerFrom, innerTo: m.innerTo,
      source: doc.sliceString(m.innerFrom, m.innerTo), display: m.display, kind: m.display ? 'display' : 'inline',
    };
  }
  if (!isEnvNode(n)) return null;
  const name = envNameOf(n, doc);
  if (NOT_FORMULAS.has(name) || !(n.name === 'EquationEnvironment' || n.name === 'EquationArrayEnvironment' || isMathEnvName(name))) return null;
  const parts = envParts(n);
  if (!parts.end || parts.end.to !== n.to || envNameIn(parts.end, doc) !== name) return null;
  return {
    from: n.from, to: n.to, innerFrom: parts.bodyFrom, innerTo: parts.bodyTo,
    source: doc.sliceString(parts.bodyFrom, parts.bodyTo), display: name !== 'math', kind: 'env', env: name,
  };
}

/**
 * The outermost closed formula around `pos` (`$…$`, `$$…$$`, `\(…\)`,
 * `\[…\]`, a math environment). One that contains `pos` strictly wins;
 * otherwise one ending at `pos` (the caret right after it), then one starting
 * there. To ask about the character after `pos` (a hover), pass `pos + 1`.
 */
export function formulaAt(s: EditorState, pos: number): Formula | null {
  const tree = treeAround(s, pos);
  if (!tree || pos < 0 || pos > s.doc.length) return null;
  let strict: Formula | null = null;
  let ending: Formula | null = null;
  let starting: Formula | null = null;
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
      if (n.from > pos || n.to < pos) continue;
      const f = formulaOf(n, s.doc);
      if (!f) continue;
      if (f.from < pos && pos < f.to) { if (!strict || f.from < strict.from || f.to > strict.to) strict = f; }
      else if (f.to === pos) { if (!ending || f.from < ending.from) ending = f; }
      else if (!starting || f.to > starting.to) starting = f;
    }
  }
  return strict ?? ending ?? starting;
}

/** The outermost closed formulas that overlap `from..to`, in document order. */
export function formulasIn(s: EditorState, from: number, to: number): Formula[] {
  const tree = treeAround(s, to);
  if (!tree) return [];
  const out: Formula[] = [];
  tree.iterate({
    from: Math.max(0, from),
    to: Math.min(s.doc.length, to),
    enter: (ref) => {
      if (!DELIMITED_MATH.has(ref.name) && !ENV_NODES.has(ref.name)) return;
      const f = formulaOf(ref.node, s.doc);
      if (!f) return;
      if (f.to >= from && f.from <= to) out.push(f);
      return false;
    },
  });
  return out;
}

/** The innermost table-like environment whose span (\begin to \end) holds `pos`. */
export function tableEnvAt(s: EditorState, pos: number): TableEnv | null {
  const tree = treeAround(s, pos);
  if (!tree || pos < 0 || pos > s.doc.length) return null;
  const doc = s.doc;
  for (const side of [-1, 1] as const) {
    const chain = ancestors(tree.resolveInner(pos, side));
    const docEnv = chain.find((n) => isDocumentEnv(n, doc)) ?? null;
    let info: PreambleInfo | null = null;
    const preamble = (): PreambleInfo => (info ??= preambleInfo(preambleText(doc, docEnv ? docEnv.from : undefined)));
    for (const n of chain) {
      if (!isEnvNode(n) || n.from > pos || n.to < pos) continue;
      const name = envNameOf(n, doc);
      const family = tableFamilyOf(s, name, preamble);
      if (!family) continue;
      const parts = envParts(n);
      return { name, family, from: n.from, to: n.to, bodyFrom: tableBodyFrom(doc, name, parts), bodyTo: parts.bodyTo };
    }
  }
  return null;
}

/**
 * The innermost command around `pos`: name without the backslash (a `*`
 * right after it included), its span from the backslash to the end of its
 * last argument, and each argument's content span. One that holds `pos`
 * strictly wins over one that only touches it (ending there first).
 */
export function commandAt(s: EditorState, pos: number): CommandSpan | null {
  const tree = treeAround(s, pos);
  if (!tree || pos < 0 || pos > s.doc.length) return null;
  let strict: SyntaxNode | null = null;
  let touching: SyntaxNode | null = null;
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
      if (!isCommandNode(n) || n.from > pos || n.to < pos) continue;
      if (n.from < pos && pos < n.to) {
        if (!strict || n.to - n.from < strict.to - strict.from) strict = n;
        break;
      }
      touching ??= n;
    }
  }
  const n = strict ?? touching;
  if (!n) return null;
  return {
    name: commandNameOf(n, s.doc),
    from: n.from,
    to: n.to,
    args: argsOf(n, s.doc).map(({ from, to, optional }) => ({ from, to, optional })),
  };
}

/** The file's dominant inline delimiter: `$…$` or `\(…\)`. */
export function inlineMathStyle(doc: Text): 'dollar' | 'paren' {
  return mathStyleOf(doc);
}

/** Packages loaded in the preamble (\usepackage, \RequirePackage), cached per document. */
export function documentPackages(s: EditorState): ReadonlySet<string> {
  return packagesOf(s.doc);
}
