/**
 * "Insert label here" and the `\label{` suggestion (WP26, feature 17): which
 * label name fits the caret's context and where the `\label` must go. Pure:
 * works on the document's text, so it is tested without an editor.
 *
 * - In a float (figure, table, listing, algorithm, their sub- and starred
 *   forms) the label goes right after `\caption{…}`: a label before the
 *   caption numbers the section, not the float. The name is `fig:`/`tab:`
 *   plus a slug of the caption (else of the `\includegraphics` file name).
 * - In an equation environment it goes at the end of the caret's row,
 *   before the row's `\\`; the name is the next free `eq:<n>`.
 * - In a theorem-like environment it goes right after `\begin{…}[note]`.
 * - In an enumerate it goes right after the caret's `\item`.
 * - Elsewhere it labels the section the caret is in, on the heading's line
 *   after its `}`; `ch:` for chapters, `app:` after `\appendix`.
 * - If the place already has a label, that label is selected instead.
 */

export type LabelPlace = 'float' | 'equation' | 'theorem' | 'item' | 'heading' | 'text';

export interface LabelPlan {
  place: LabelPlace;
  /** "fig:", "tab:", "eq:", "sec:" … */
  prefix: string;
  /** The suggested name after the prefix; empty means numbered (`eq:1`). */
  slug: string;
  /** Where the `\label{…}` is inserted. */
  at: number;
  /** Text to put before the `\label` (a space when it would touch a word). */
  pad: string;
  /** The label already there: the range of its name, to select. */
  existing: { from: number; to: number } | null;
  /** The label lands away from the caret (toast the reason). */
  moved: boolean;
  /** For the toast: what the label names ("figure", "section"). */
  what: string;
}

const FLOATS: Record<string, string> = {
  figure: 'fig:', 'figure*': 'fig:', wrapfigure: 'fig:', sidewaysfigure: 'fig:', SCfigure: 'fig:', subfigure: 'fig:',
  table: 'tab:', 'table*': 'tab:', wraptable: 'tab:', sidewaystable: 'tab:', longtable: 'tab:', 'longtable*': 'tab:',
  xltabular: 'tab:', supertabular: 'tab:', SCtable: 'tab:', subtable: 'tab:',
  listing: 'lst:', algorithm: 'alg:', 'algorithm*': 'alg:',
};
const EQUATIONS = new Set(['equation', 'align', 'alignat', 'gather', 'multline', 'flalign', 'eqnarray', 'subequations', 'dmath', 'dgroup', 'xalignat', 'xxalignat']);
const THEOREM_PREFIX: Record<string, string> = {
  theorem: 'thm:', lemma: 'lem:', corollary: 'cor:', proposition: 'prop:', definition: 'def:', remark: 'rem:',
  example: 'ex:', conjecture: 'conj:', hypothesis: 'hyp:', claim: 'claim:', assumption: 'asm:', axiom: 'ax:',
  exercise: 'exe:', problem: 'prob:', observation: 'obs:', fact: 'fact:', notation: 'not:', question: 'q:',
  property: 'prop:', criterion: 'crit:', condition: 'cond:',
};
const HEADING_RE = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]\n]*\]\s*)?\{/g;
const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'for', 'and', 'or', 'to', 'with', 'by', 'at', 'from', 'as', 'is', 'are',
  'be', 'vs', 'versus', 'via', 'its', 'into', 'over', 'under', 'between', 'among', 'per', 'across', 'during', 'than', 'that', 'this']);

/** `text` with comments blanked to spaces (offsets kept; `\%` is text). */
export function maskComments(text: string): string {
  return text.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, (m: string, pre: string, bs: string) => pre + bs + ' '.repeat(m.length - pre.length - bs.length));
}

/** The end (exclusive) of the balanced `{…}` or `[…]` group opening at `open`, or -1. */
export function groupEnd(text: string, open: number): number {
  const o = text[open];
  const c = o === '{' ? '}' : o === '[' ? ']' : '';
  if (!c) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i + 1;
  }
  return -1;
}

/** De-TeXes, folds accents, drops stop words: "Mean \emph{reaction} times ($ms$)" → "mean-reaction-times". At most four words and 32 characters. */
export function slugify(tex: string, max = 32): string {
  const plain = tex
    .replace(/\$[^$]*\$|\\\([\s\S]*?\\\)/g, ' ')
    .replace(/\\(?:label|ref|cref|Cref|cite[a-zA-Z]*|parencite|textcite|footnote)\*?\s*(?:\[[^\]]*\])*\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/\\./g, ' ')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/æ/gi, 'ae').replace(/ø/gi, 'o')
    .toLowerCase();
  const words = plain.split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).slice(0, 4);
  let out = '';
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  return out || (words[0] ?? '').slice(0, max);
}

/** Every `\label{…}` name in the text (comments ignored). */
export function labelsInText(text: string): string[] {
  const out: string[] = [];
  for (const m of maskComments(text).matchAll(/\\label\s*\{([^{}]*)\}/g)) if (m[1].trim()) out.push(m[1].trim());
  return out;
}

/** `prefix+slug`, made unique against `taken` with -2, -3 …; an empty slug numbers from 1. */
export function uniqueName(prefix: string, slug: string, taken: ReadonlySet<string>): string {
  if (!slug) {
    for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
  }
  const base = `${prefix}${slug}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

interface OpenEnv { name: string; from: number; headEnd: number; bodyFrom: number }

/** The environments open at `pos` (outermost first), from the masked text. */
function envStack(masked: string, pos: number): OpenEnv[] {
  const stack: OpenEnv[] = [];
  const re = /\\(begin|end)\s*\{([^{}]+)\}/g;
  for (let m = re.exec(masked); m && m.index < pos; m = re.exec(masked)) {
    const name = m[2].trim();
    if (m[1] === 'begin') {
      const headEnd = m.index + m[0].length;
      let bodyFrom = headEnd;
      // \begin{figure}[htbp] and \begin{hypothesis}[note]: the body starts after the option on the same line.
      const opt = /^[ \t]*\[/.exec(masked.slice(headEnd, headEnd + 200));
      if (opt) {
        const end = groupEnd(masked, headEnd + opt[0].length - 1);
        if (end > 0) bodyFrom = end;
      }
      stack.push({ name, from: m.index, headEnd, bodyFrom });
    } else {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) { stack.length = i; break; }
      }
    }
  }
  return stack;
}

/** The offset of the `\end{name}` closing the environment whose body starts at `from`, or the text's end. */
function envEnd(masked: string, name: string, from: number): number {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\\\(begin|end)\\s*\\{${esc}\\}`, 'g');
  re.lastIndex = from;
  let depth = 0;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    if (m[1] === 'begin') depth++;
    else if (depth-- === 0) return m.index;
  }
  return masked.length;
}

/** Spans of nested environments (of any of `names`) inside [from, to), so a float's own caption is told from a subfigure's. */
function nestedSpans(masked: string, from: number, to: number, names: (n: string) => boolean): [number, number][] {
  const spans: [number, number][] = [];
  const re = /\\begin\s*\{([^{}]+)\}/g;
  re.lastIndex = from;
  for (let m = re.exec(masked); m && m.index < to; m = re.exec(masked)) {
    const name = m[1].trim();
    if (!names(name)) continue;
    const end = envEnd(masked, name, m.index + m[0].length);
    spans.push([m.index, end]);
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  return spans;
}

const inSpans = (spans: readonly [number, number][], p: number) => spans.some(([a, b]) => p >= a && p < b);

/** The first `\label{…}` in [from, to) outside `spans`: the range of its name. */
function labelIn(masked: string, from: number, to: number, spans: readonly [number, number][] = []): { from: number; to: number } | null {
  const re = /\\label\s*\{([^{}]*)\}/g;
  re.lastIndex = from;
  for (let m = re.exec(masked); m && m.index < to; m = re.exec(masked)) {
    if (inSpans(spans, m.index)) continue;
    const nameFrom = m.index + m[0].indexOf('{') + 1;
    return { from: nameFrom, to: nameFrom + m[1].length };
  }
  return null;
}

const hasText = (s: string) => /\S/.test(s);
const padBefore = (text: string, at: number) => (at > 0 && /[^\s{]/.test(text[at - 1]) && text[at - 1] !== '}' ? ' ' : '');

function theoremPrefix(name: string, printed: string | undefined): string {
  const base = name.replace(/\*$/, '');
  return THEOREM_PREFIX[base.toLowerCase()] ?? (printed ? THEOREM_PREFIX[printed.toLowerCase()] : undefined) ?? `${base.toLowerCase().replace(/[^a-z]/g, '').slice(0, 4) || 'thm'}:`;
}

/** Theorem-like environments: the common names plus `\newtheorem{name}{Printed}` in the text. */
function theoremsOf(masked: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const k of Object.keys(THEOREM_PREFIX)) out.set(k, k);
  for (const m of masked.matchAll(/\\newtheorem\*?\s*\{([^{}]+)\}\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g)) out.set(m[1].trim(), m[2].trim());
  return out;
}

/** The plan for a label at `pos` in `text`. */
export function labelPlan(text: string, pos: number): LabelPlan {
  const masked = maskComments(text);
  const stack = envStack(masked, pos);
  const theorems = theoremsOf(masked);

  for (let i = stack.length - 1; i >= 0; i--) {
    const env = stack[i];
    const end = envEnd(masked, env.name, env.bodyFrom);

    if (FLOATS[env.name]) {
      const prefix = FLOATS[env.name];
      const subs = nestedSpans(masked, env.bodyFrom, end, (n) => !!FLOATS[n]);
      const what = prefix === 'tab:' ? 'table' : prefix === 'fig:' ? 'figure' : prefix === 'lst:' ? 'listing' : 'algorithm';
      const existing = labelIn(masked, env.bodyFrom, end, subs);
      let caption: { from: number; end: number; arg: string } | null = null;
      const cre = /\\caption(?:of\s*\{[^{}]*\})?\*?\s*/g;
      cre.lastIndex = env.bodyFrom;
      for (let m = cre.exec(masked); m && m.index < end; m = cre.exec(masked)) {
        if (inSpans(subs, m.index)) continue;
        let p = m.index + m[0].length;
        let short: string | null = null;
        if (masked[p] === '[') {
          const e = groupEnd(masked, p);
          if (e < 0) break;
          short = text.slice(p + 1, e - 1);
          p = e;
          while (/\s/.test(masked[p] ?? '')) p++;
        }
        if (masked[p] !== '{') continue;
        const e = groupEnd(masked, p);
        if (e < 0) break;
        caption = { from: m.index, end: e, arg: short ?? text.slice(p + 1, e - 1) };
        break;
      }
      let slug = caption ? slugify(caption.arg) : '';
      if (!slug && prefix === 'fig:') {
        const g = /\\includegraphics\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/.exec(masked.slice(env.bodyFrom, end));
        if (g) slug = slugify(g[1].split('/').pop()!.replace(/\.[a-z0-9]+$/i, '').replace(/[_.]/g, ' '));
      }
      const at = caption ? caption.end : pos;
      return {
        place: 'float', prefix, slug, at, pad: '', existing,
        moved: !existing && !!caption && hasText(text.slice(Math.min(pos, at), Math.max(pos, at))), what,
      };
    }

    if (EQUATIONS.has(env.name.replace(/\*$/, ''))) {
      const before = masked.slice(env.bodyFrom, pos);
      const lastBreak = before.lastIndexOf('\\\\');
      const rowFrom = lastBreak >= 0 ? env.bodyFrom + lastBreak + 2 : env.bodyFrom;
      const nextBreak = masked.indexOf('\\\\', pos);
      const rowTo = nextBreak >= 0 && nextBreak < end ? nextBreak : end;
      const existing = labelIn(masked, rowFrom, rowTo);
      let at = rowTo;
      while (at > rowFrom && /\s/.test(masked[at - 1])) at--;
      return { place: 'equation', prefix: 'eq:', slug: '', at, pad: padBefore(masked, at), existing, moved: false, what: 'equation' };
    }

    const printed = theorems.get(env.name.replace(/\*$/, ''));
    if (printed !== undefined) {
      const note = /^[ \t]*\[([^\]]*)\]/.exec(text.slice(env.headEnd, env.bodyFrom));
      const subs = nestedSpans(masked, env.bodyFrom, end, () => true);
      return {
        place: 'theorem', prefix: theoremPrefix(env.name, printed), slug: note ? slugify(note[1]) : '', at: env.bodyFrom, pad: '',
        existing: labelIn(masked, env.bodyFrom, end, subs),
        moved: hasText(text.slice(env.bodyFrom, pos)), what: printed.toLowerCase() || env.name,
      };
    }

    if (env.name === 'enumerate') {
      const subs = nestedSpans(masked, env.bodyFrom, end, (n) => n === 'enumerate' || n === 'itemize' || n === 'description');
      const items = [...masked.slice(env.bodyFrom, end).matchAll(/\\item\b\s*(?:\[[^\]]*\])?/g)]
        .map((m) => ({ from: env.bodyFrom + m.index!, to: env.bodyFrom + m.index! + m[0].length }))
        .filter((m) => !inSpans(subs, m.from));
      const current = items.filter((m) => m.from <= pos).pop();
      if (!current) continue;
      const next = items.find((m) => m.from > current.from)?.from ?? end;
      let at = current.to;
      while (at > current.from && /\s/.test(masked[at - 1])) at--;
      const words = slugify(text.slice(current.to, Math.min(next, current.to + 200)).split('\n')[0]);
      return {
        place: 'item', prefix: 'item:', slug: words, at, pad: ' ', existing: labelIn(masked, current.to, next, subs),
        moved: hasText(text.slice(current.to, pos)), what: 'item',
      };
    }
  }

  // Outside every labelled environment: the section the caret is in.
  let heading: { cmd: string; from: number; open: number; end: number } | null = null;
  HEADING_RE.lastIndex = 0;
  for (let m = HEADING_RE.exec(masked); m && m.index < pos; m = HEADING_RE.exec(masked)) {
    const open = m.index + m[0].length - 1;
    const e = groupEnd(masked, open);
    if (e > 0) heading = { cmd: m[1], from: m.index, open, end: e };
  }
  if (!heading) {
    return { place: 'text', prefix: 'sec:', slug: '', at: pos, pad: padBefore(text, pos), existing: null, moved: false, what: 'section' };
  }
  const appendix = /\\appendix\b/.test(masked.slice(0, heading.from));
  const prefix = appendix ? 'app:' : heading.cmd === 'chapter' ? 'ch:' : heading.cmd === 'part' ? 'part:' : 'sec:';
  const after = /^\s*\\label\s*\{([^{}]*)\}/.exec(masked.slice(heading.end));
  const existing = after ? (() => { const f = heading!.end + after[0].indexOf('{') + 1; return { from: f, to: f + after[1].length }; })() : null;
  const what = appendix ? 'appendix' : heading.cmd === 'chapter' ? 'chapter' : heading.cmd === 'part' ? 'part' : 'section';
  return {
    place: 'heading', prefix, slug: slugify(text.slice(heading.open + 1, heading.end - 1)), at: heading.end, pad: '', existing,
    moved: !existing && hasText(text.slice(Math.min(pos, heading.end), Math.max(pos, heading.end))), what,
  };
}

/** The `\label{` completion's suggestion for the caret: `prefix+slug`, unique against `taken`. */
export function suggestedName(text: string, pos: number, taken: ReadonlySet<string>): string {
  const plan = labelPlan(text, pos);
  return uniqueName(plan.prefix, plan.slug, taken);
}
