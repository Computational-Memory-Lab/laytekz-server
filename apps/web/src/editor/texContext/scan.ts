/**
 * Text scans texContext needs beside the syntax tree: comments, the
 * document's delimiter style and packages, the preamble's own table and
 * theorem environments, the cell a position is in, and a table
 * environment's arguments. Results that depend only on the document are
 * cached per `Text`; the preamble's are also kept while its text is
 * unchanged, since every keystroke in the body makes a new `Text`.
 */
import type { Text } from '@codemirror/state';
import type { TableFamily } from './types';
import { vocabTableFamily } from './names';

/** Whether the character at `i` is escaped (an odd run of backslashes before it). */
export function escapedAt(text: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && text.charCodeAt(j) === 92; j--) n++;
  return n % 2 === 1;
}

/** Offsets of every unescaped `%` in `text` before `upto`. */
export function percentOffsets(text: string, upto = text.length): number[] {
  const out: number[] = [];
  for (let i = text.indexOf('%'); i >= 0 && i < upto; i = text.indexOf('%', i + 1)) {
    if (!escapedAt(text, i)) out.push(i);
  }
  return out;
}

/** `text` with every %-comment replaced by spaces, so offsets stay valid. A
 *  slice that starts inside a line reads that line from the slice's start. */
export function blankComments(text: string): string {
  if (!text.includes('%')) return text;
  return text.replace(/[^\n]*/g, (line) => {
    const at = percentOffsets(line)[0];
    return at === undefined ? line : line.slice(0, at) + ' '.repeat(line.length - at);
  });
}

const HEAD = 20_000;
const SCAN = 200_000;
const classAt = new WeakMap<Text, number | null>();

/** The offset of an uncommented \documentclass in the first 20 KB, or null (a file \input by another). */
export function documentClassOffset(doc: Text): number | null {
  let hit = classAt.get(doc);
  if (hit !== undefined) return hit;
  const m = /\\documentclass(?![A-Za-z@])/.exec(blankComments(doc.sliceString(0, Math.min(doc.length, HEAD))));
  hit = m ? m.index : null;
  classAt.set(doc, hit);
  return hit;
}

const BEGIN_DOCUMENT = /\\begin\s*\{document\}/;

/** The source before \begin{document} with comments blanked; the whole head (up to 200 KB) when there is none. */
export function preambleText(doc: Text, documentFrom?: number): string {
  if (documentFrom !== undefined) return blankComments(doc.sliceString(0, documentFrom));
  const head = blankComments(doc.sliceString(0, Math.min(doc.length, SCAN)));
  const m = BEGIN_DOCUMENT.exec(head);
  return m ? head.slice(0, m.index) : head;
}

const styles = new WeakMap<Text, 'dollar' | 'paren'>();

/** `\(…\)` when the first 200 KB hold more `\(` than `$…$` formulas; `$` otherwise (ties and empty files included). */
export function mathStyleOf(doc: Text): 'dollar' | 'paren' {
  const hit = styles.get(doc);
  if (hit) return hit;
  const text = blankComments(doc.sliceString(0, Math.min(doc.length, SCAN)));
  let parens = 0;
  let dollars = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 92 /* \ */) {
      if (text[i + 1] === '(') parens++;
      i++;
    } else if (c === 36 /* $ */) {
      if (text[i + 1] === '$') i++;
      else dollars++;
    }
  }
  const style = parens > dollars / 2 ? 'paren' : 'dollar';
  styles.set(doc, style);
  return style;
}

const PACKAGE_RE = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g;
const packageSets = new WeakMap<Text, ReadonlySet<string>>();
let lastPackages: { preamble: string; set: ReadonlySet<string> } | null = null;

export function packagesOf(doc: Text): ReadonlySet<string> {
  const hit = packageSets.get(doc);
  if (hit) return hit;
  const preamble = preambleText(doc);
  let set: ReadonlySet<string>;
  if (lastPackages && lastPackages.preamble === preamble) set = lastPackages.set;
  else {
    const out = new Set<string>();
    for (const m of preamble.matchAll(PACKAGE_RE)) {
      for (const name of m[1].split(',')) if (name.trim()) out.add(name.trim());
    }
    set = out;
    lastPackages = { preamble, set };
  }
  packageSets.set(doc, set);
  return set;
}

/** The balanced `{…}` group opening at `i`: its interior and the offset after it. */
function group(text: string, i: number): { body: string; end: number } | null {
  if (text[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { body: text.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

export interface PreambleInfo {
  /** Environments the preamble defines around a table environment (\newenvironment{results}{\begin{tabular}…}). */
  tables: ReadonlyMap<string, TableFamily>;
  /** Theorem-like environments the preamble declares (\newtheorem, \declaretheorem). */
  theorems: ReadonlySet<string>;
}

const NEW_ENV = /\\(?:re)?newenvironment\*?\s*\{\s*([^{}\s]+)\s*\}((?:\s*\[[^\]]*\])*)\s*(?=\{)/g;
const DOC_ENV = /\\(?:New|Renew|Provide|Declare)DocumentEnvironment\s*\{\s*([^{}\s]+)\s*\}\s*\{[^{}]*\}\s*(?=\{)/g;
const INNER_BEGIN = /\\begin\s*\{([^{}]+)\}/g;
const INNER_MACRO = /\\(tabularx|tabulary|tabular\*?|longtable|xltabular|tblr|array)(?![A-Za-z@])/;
const NEW_THEOREM = /\\newtheorem\*?\s*\{\s*([^{}\s]+)\s*\}/g;
const DECLARE_THEOREM = /\\declaretheorem\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g;
let lastInfo: { preamble: string; info: PreambleInfo } | null = null;

export function preambleInfo(preamble: string): PreambleInfo {
  if (lastInfo && lastInfo.preamble === preamble) return lastInfo.info;
  const tables = new Map<string, TableFamily>();
  for (const re of [NEW_ENV, DOC_ENV]) {
    for (const m of preamble.matchAll(re)) {
      const body = group(preamble, m.index! + m[0].length)?.body;
      if (!body) continue;
      let family: TableFamily | null = null;
      for (const b of body.matchAll(INNER_BEGIN)) {
        family = vocabTableFamily(b[1].trim());
        if (family) break;
      }
      if (!family) {
        const macro = INNER_MACRO.exec(body);
        if (macro) family = vocabTableFamily(macro[1]);
      }
      if (family) tables.set(m[1], family);
    }
  }
  const theorems = new Set<string>();
  for (const m of preamble.matchAll(NEW_THEOREM)) theorems.add(m[1]);
  for (const m of preamble.matchAll(DECLARE_THEOREM)) for (const n of m[1].split(',')) if (n.trim()) theorems.add(n.trim());
  const info = { tables, theorems };
  lastInfo = { preamble, info };
  return info;
}

const CONTROL = /\\(?:([A-Za-z@]+)|.)/y;
const ROW_ENDS = new Set(['tabularnewline', 'cr', 'crcr']);

/**
 * The cell (0-based) `pos` is in, counting the `&` at the table body's top
 * level since the last row end (`\\`, \tabularnewline, \cr). An `&` inside
 * braces or a nested environment, escaped, or in a comment does not count.
 */
export function cellColumn(doc: Text, bodyFrom: number, pos: number): number {
  const text = doc.sliceString(bodyFrom, Math.max(bodyFrom, pos));
  let column = 0;
  let depth = 0;
  let envs = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === '\\') {
        if (depth === 0 && envs === 0) column = 0;
        i++;
        continue;
      }
      CONTROL.lastIndex = i;
      const m = CONTROL.exec(text);
      if (!m) continue;
      const word = m[1];
      if (word === 'begin') envs++;
      else if (word === 'end') envs = Math.max(0, envs - 1);
      else if (word && ROW_ENDS.has(word) && depth === 0 && envs === 0) column = 0;
      else if (word === 'verb' || word === 'lstinline') {
        let j = i + m[0].length;
        if (text[j] === '*') j++;
        if (j >= text.length) break;
        const close = text.indexOf(text[j] === '{' ? '}' : text[j], j + 1);
        if (close < 0) break;
        i = close;
        continue;
      }
      i += m[0].length - 1;
      continue;
    }
    if (c === '%') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '&' && depth === 0 && envs === 0) column++;
  }
  return column;
}

/**
 * Where a table environment's arguments end, reading `signature` (`{`
 * mandatory, `[` optional) from `from`, just after `\begin{name}`. Null when a
 * mandatory argument is missing or unclosed (still being typed).
 */
export function argumentsEnd(doc: Text, from: number, signature: string): number | null {
  const text = doc.sliceString(from, Math.min(doc.length, from + 4_000));
  let i = 0;
  for (const want of signature) {
    let j = i;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    if (want === '{') {
      const g = group(text, j);
      if (!g) return null;
      i = g.end;
    } else if (text[j] === '[') {
      let depth = 0;
      let k = j + 1;
      for (; k < text.length; k++) {
        const ch = text[k];
        if (ch === '\\') { k++; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === ']' && depth === 0) break;
      }
      if (k >= text.length) return null;
      i = k + 1;
    }
  }
  return from + i;
}
