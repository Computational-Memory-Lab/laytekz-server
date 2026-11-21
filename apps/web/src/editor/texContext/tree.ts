/**
 * Reading codemirror-lang-latex's tree: environments, commands and their
 * arguments, and the inner span of each math construct. The grammar gives a
 * known command a node of its own (Cite, UrlCommand, …) and an unknown one
 * UnknownCommand; both start with a `…CtrlSeq` token followed by their
 * arguments, which is what these helpers rely on.
 */
import type { SyntaxNode } from '@lezer/common';

export interface Doc { sliceString(from: number, to?: number): string; readonly length: number }

/** One argument: `from`/`to` bound its content, between the delimiters. An
 *  unclosed argument runs to the end of what the parser gave it. */
export interface ArgSpan {
  from: number;
  to: number;
  optional: boolean;
  closed: boolean;
  /** Node names from the argument's outer node down to the one holding the delimiters. */
  names: readonly string[];
}

export function isEnvNode(n: SyntaxNode): boolean {
  return n.firstChild?.name === 'BeginEnv';
}

/** The name in `\begin{…}` (or `\end{…}`): the text between the braces of its EnvNameGroup. */
export function envNameIn(beginOrEnd: SyntaxNode, doc: Doc): string {
  const group = beginOrEnd.getChild('EnvNameGroup');
  if (!group) return '';
  return doc.sliceString(...groupInner(group)).trim();
}

export function envNameOf(env: SyntaxNode, doc: Doc): string {
  return env.firstChild ? envNameIn(env.firstChild, doc) : '';
}

/** The span between a group's braces (to its end when the closing brace is missing). */
export function groupInner(group: SyntaxNode): [number, number] {
  const open = group.firstChild;
  const close = group.lastChild;
  const from = open && (open.name === 'OpenBrace' || open.name === 'OpenBracket') ? open.to : group.from;
  const to = close && close !== open && (close.name === 'CloseBrace' || close.name === 'CloseBracket') ? close.from : group.to;
  return [from, Math.max(from, to)];
}

export interface EnvParts {
  begin: SyntaxNode;
  end: SyntaxNode | null;
  /** The body: after \begin{…} and the arguments the parser gave it, up to \end (or the node's end). */
  bodyFrom: number;
  bodyTo: number;
}

export function envParts(env: SyntaxNode): EnvParts {
  const begin = env.firstChild!;
  const end = env.getChild('EndEnv');
  return { begin, end, bodyFrom: begin.to, bodyTo: end ? end.from : env.to };
}

export function isCommandNode(n: SyntaxNode): boolean {
  const f = n.firstChild;
  return !!f && (f.name.endsWith('CtrlSeq') || n.name === 'LineBreak');
}

/** The command's name without the backslash, with a `*` written right after it (`section*`). */
export function commandNameOf(n: SyntaxNode, doc: Doc): string {
  const f = n.firstChild!;
  const raw = doc.sliceString(f.from, f.to);
  const name = raw.startsWith('\\') ? raw.slice(1) : raw;
  return doc.sliceString(f.to, f.to + 1) === '*' ? `${name}*` : name;
}

const OPEN = new Set(['OpenBrace', 'OpenBracket']);

/**
 * The delimited arguments among `parent`'s children, after the first `skip`
 * children: argument nodes (possibly wrapped, BibKeyArgument >
 * ShortTextArgument > {…}), braces that are direct children (\newcommand's
 * first argument), and \verb-style content.
 */
export function argsOf(parent: SyntaxNode, doc: Doc, skip = 1): ArgSpan[] {
  const out: ArgSpan[] = [];
  let c = parent.firstChild;
  for (let i = 0; i < skip && c; i++) c = c.nextSibling;
  for (; c; c = c.nextSibling) {
    if (OPEN.has(c.name)) {
      const closeName = c.name === 'OpenBrace' ? 'CloseBrace' : 'CloseBracket';
      let last: SyntaxNode = c;
      let e = c.nextSibling;
      while (e && e.name !== closeName && !OPEN.has(e.name)) { last = e; e = e.nextSibling; }
      const closed = e?.name === closeName;
      out.push({ from: c.to, to: closed ? e!.from : last.to, optional: c.name === 'OpenBracket', closed, names: [] });
      if (closed) c = e!;
      else c = last;
      continue;
    }
    if (c.name === 'VerbContent' || c.name === 'LstInlineContent') {
      const text = doc.sliceString(c.from, c.to);
      const closer = text[0] === '{' ? '}' : text[0];
      const closed = text.length >= 2 && text[text.length - 1] === closer;
      out.push({ from: Math.min(c.to, c.from + 1), to: closed ? c.to - 1 : c.to, optional: false, closed, names: [c.name] });
      continue;
    }
    const names: string[] = [];
    let w: SyntaxNode | null = c;
    for (let depth = 0; w && depth < 4; depth++) {
      names.push(w.name);
      const f: SyntaxNode | null = w.firstChild;
      if (!f) { w = null; break; }
      if (OPEN.has(f.name)) break;
      w = f;
    }
    const open = w?.firstChild;
    if (!w || !open || !OPEN.has(open.name)) continue;
    const close = w.lastChild;
    const closeName = open.name === 'OpenBrace' ? 'CloseBrace' : 'CloseBracket';
    const closed = !!close && close !== open && close.name === closeName;
    out.push({ from: open.to, to: closed ? close!.from : w.to, optional: open.name === 'OpenBracket', closed, names });
  }
  return out;
}

export type MathDelim = '$' | '$$' | '\\(' | '\\[';

export interface MathSpan { innerFrom: number; innerTo: number; delim: MathDelim; display: boolean; closed: boolean }

export const DELIMITED_MATH = new Set(['DollarMath', 'ParenMath', 'BracketMath']);

/** The inner span of `$…$`, `$$…$$`, `\(…\)` or `\[…\]` (to the node's end while unclosed). */
export function mathSpan(n: SyntaxNode): MathSpan | null {
  if (n.name === 'DollarMath') {
    const dollars = n.getChildren('Dollar');
    const open = dollars[0];
    if (!open || open.from !== n.from) return null;
    const display = n.getChild('DisplayMath');
    if (display && display.from === open.to) {
      const inner = display.getChildren('Dollar');
      const innerFrom = inner[0] ? inner[0].to : display.from;
      const innerTo = inner.length >= 2 ? inner[inner.length - 1].from : display.to;
      return { innerFrom, innerTo: Math.max(innerFrom, innerTo), delim: '$$', display: true, closed: inner.length >= 2 && dollars.length >= 2 };
    }
    const closed = dollars.length >= 2;
    return { innerFrom: open.to, innerTo: closed ? dollars[dollars.length - 1].from : n.to, delim: '$', display: false, closed };
  }
  if (n.name === 'ParenMath' || n.name === 'BracketMath') {
    const paren = n.name === 'ParenMath';
    const open = n.getChild(paren ? 'OpenParenMath' : 'OpenBracketMath');
    const close = n.getChild(paren ? 'CloseParenMath' : 'CloseBracketMath');
    const innerFrom = open ? open.to : n.from + 2;
    const innerTo = close ? close.from : n.to;
    return { innerFrom, innerTo: Math.max(innerFrom, innerTo), delim: paren ? '\\(' : '\\[', display: !paren, closed: !!close };
  }
  return null;
}

/** Ancestors of `n`, innermost first, `n` included. */
export function ancestors(n: SyntaxNode | null): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = n; c; c = c.parent) out.push(c);
  return out;
}
