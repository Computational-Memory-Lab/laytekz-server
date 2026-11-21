/**
 * Finding the words selected in the PDF in the LaTeX source (feature 19).
 * SyncTeX gives a line, never a column (pdfTeX records none), so the words
 * are looked for in the paragraph around that line. Both sides are reduced
 * to what they have in common: letters and digits, lower case, accents and
 * ligatures taken apart. On the source side comments, command names and the
 * arguments that never print as themselves (\label, \ref, \cite, …) are left
 * out, each kept character remembering where it came from. Pure functions.
 */

const KEEP = /[\p{L}\p{N}]/u;

/** The letters and digits of one character: NFKD splits ligatures (ﬁ → fi) and accents (é → e + a combining mark, dropped). */
function fold(ch: string): string {
  let out = '';
  for (const c of ch.normalize('NFKD').toLowerCase()) if (KEEP.test(c)) out += c;
  return out;
}

/** The text selected in the PDF, as a search key. */
export function pdfKey(text: string): string {
  let out = '';
  for (const ch of text.replace(/­/g, '')) out += fold(ch);
  return out;
}

/** Commands whose first mandatory argument does not print as its own letters (after any optional ones). */
const SKIP_ARG = new Set([
  'label', 'ref', 'eqref', 'pageref', 'cref', 'Cref', 'autoref', 'nameref', 'vref',
  'cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'parencite', 'textcite', 'autocite', 'footcite', 'nocite', 'Citep', 'Citet', 'Textcite', 'Parencite',
  'begin', 'end', 'includegraphics', 'input', 'include', 'usepackage', 'documentclass', 'bibliography', 'bibliographystyle',
  'vspace', 'hspace', 'color', 'textcolor', 'colorbox', 'href', 'hypersetup', 'setlength', 'addtolength', 'newcommand', 'renewcommand',
  'pagestyle', 'thispagestyle', 'linespread', 'fontsize', 'selectfont',
]);

export interface SourceKey {
  /** The kept characters, folded. */
  key: string;
  /** Source offset where the character behind key[i] starts. */
  at: number[];
  /** Source offset just after it. */
  end: number[];
}

/** Skips a balanced group opening at `i` (`open` is `{` or `[`); returns the offset after it, or `i` when none opens there. */
function skipGroup(src: string, i: number, to: number, open: '{' | '['): number {
  if (src[i] !== open) return i;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let j = i; j < to; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return to;
}

const skipSpace = (src: string, i: number, to: number): number => {
  while (i < to && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i++;
  return i;
};

/** The source between `from` and `to`, reduced like pdfKey, with where each kept character came from. */
export function sourceKey(src: string, from: number, to: number): SourceKey {
  const out: SourceKey = { key: '', at: [], end: [] };
  let i = Math.max(0, from);
  const stop = Math.min(src.length, to);
  while (i < stop) {
    const c = src[i];
    if (c === '%') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 || nl > stop ? stop : nl;
      continue;
    }
    if (c === '\\') {
      let j = i + 1;
      while (j < stop && /[A-Za-z@]/.test(src[j])) j++;
      if (j === i + 1) { i = Math.min(stop, i + 2); continue; } // a control symbol: \', \\, \%, \&, \,
      const name = src.slice(i + 1, j);
      i = j;
      if (SKIP_ARG.has(name)) {
        let k = skipSpace(src, i, stop);
        if (src[k] === '*') k++;
        for (;;) {
          const after = skipGroup(src, skipSpace(src, k, stop), stop, '[');
          if (after === skipSpace(src, k, stop)) break;
          k = after;
        }
        const brace = skipSpace(src, k, stop);
        i = src[brace] === '{' ? skipGroup(src, brace, stop, '{') : i;
      }
      continue;
    }
    const cp = src.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const folded = fold(String.fromCodePoint(cp));
    for (const k of folded) { out.key += k; out.at.push(i); out.end.push(i + len); }
    i += len;
  }
  return out;
}

/** Offsets where each line starts (line n starts at result[n - 1]). */
export function lineStarts(doc: string): number[] {
  const starts = [0];
  for (let i = doc.indexOf('\n'); i >= 0; i = doc.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

const isBlank = (doc: string, starts: number[], n: number): boolean => {
  const from = starts[n - 1], to = n < starts.length ? starts[n] - 1 : doc.length;
  return doc.slice(from, to).trim() === '';
};

/** The paragraph(s) from line `first` to line `last`, up to blank lines, at most `cap` lines past each end; as offsets. */
export function paragraphSpan(doc: string, starts: number[], first: number, last: number, cap = 60): { from: number; to: number } {
  let a = first, b = last;
  while (a > 1 && first - a < cap && !isBlank(doc, starts, a - 1)) a--;
  while (b < starts.length && b - last < cap && !isBlank(doc, starts, b + 1)) b++;
  return { from: starts[a - 1], to: b < starts.length ? starts[b] : doc.length };
}

function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

export interface Located {
  from: number;
  to: number;
  /** Every selected word was found in order; false: the selection's start and end were found, and the range runs between them. */
  exact: boolean;
}

/** Below this many letters a partial match (start and end only) is not tried: too likely to land on the wrong words. */
const MIN_PARTIAL = 12;
/** Letters taken from each end of the selection for a partial match, longest first. */
const PARTS = [24, 16, 10, 6];
/** Lines added on each side when the paragraph does not hold the words. */
const WIDEN = 30;

/**
 * Where the text selected in the PDF is in `doc`, given the source line
 * SyncTeX gave for its start (and, when known, for its end). The occurrence
 * nearest that line wins; null when the words are not near it at all.
 */
export function locateSelection(doc: string, line: number, text: string, opts: { endLine?: number } = {}): Located | null {
  const key = pdfKey(text);
  if (!key) return null;
  const starts = lineStarts(doc);
  const clamp = (n: number) => Math.min(Math.max(1, Math.round(n)), starts.length);
  const first = clamp(line);
  const last = clamp(Math.max(opts.endLine ?? first, first));
  const lineFrom = starts[first - 1];
  const lineTo = first < starts.length ? starts[first] - 1 : doc.length;
  const distance = (pos: number) => (pos < lineFrom ? lineFrom - pos : pos > lineTo ? pos - lineTo : 0);
  const nearest = (sk: SourceKey, list: number[]) => {
    let best = -1, bestD = Infinity;
    for (const i of list) {
      const d = distance(sk.at[i]);
      if (d < bestD) { best = i; bestD = d; }
    }
    return best;
  };
  const para = paragraphSpan(doc, starts, first, last);
  const wide = { from: starts[clamp(first - WIDEN) - 1], to: Math.max(para.to, clamp(last + WIDEN) < starts.length ? starts[clamp(last + WIDEN)] : doc.length) };
  for (const region of [para, { from: Math.min(wide.from, para.from), to: wide.to }]) {
    const sk = sourceKey(doc, region.from, region.to);
    const hit = nearest(sk, occurrences(sk.key, key));
    if (hit >= 0) return { from: sk.at[hit], to: sk.end[hit + key.length - 1], exact: true };
    if (key.length < MIN_PARTIAL) continue;
    // A citation or reference prints what the source does not hold ([1], 2.3): try the selection's two ends, shorter each time.
    const maxSpan = key.length * 2 + 40;
    for (const part of PARTS) {
      if (part > Math.floor(key.length / 2)) continue;
      const head = key.slice(0, part), tail = key.slice(key.length - part);
      // Each start near the line, nearest first, with the first end after it that is not too far.
      const heads = occurrences(sk.key, head).sort((x, y) => distance(sk.at[x]) - distance(sk.at[y]));
      for (const h of heads) {
        const t = sk.key.indexOf(tail, h + part);
        if (t >= 0 && t + part - h <= maxSpan) return { from: sk.at[h], to: sk.end[t + part - 1], exact: false };
      }
    }
  }
  return null;
}
