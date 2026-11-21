/**
 * Laytekz V2 (WP15): the \label targets of a .tex file and what each one
 * names, for the cross-reference picker (F17) and go to definition (F18).
 * Pure: no store, no collab, no config, so the REST route, the MCP tool and
 * the tests share one implementation.
 *
 * Comments, \verb and verbatim-like environments (verbatim, Verbatim,
 * lstlisting, minted, comment) are blanked before scanning, so a commented-out
 * label is not a label. Offsets are into the file's text with CRLF and CR
 * turned into LF: the text CodeMirror holds.
 */
import { texText } from './bib.js';

export interface LabelEntry { label: string; file: string }

export type LabelKind =
  | 'figure' | 'subfigure' | 'table' | 'subtable' | 'equation' | 'item' | 'theorem'
  | 'listing' | 'algorithm' | 'footnote'
  | 'part' | 'chapter' | 'section' | 'subsection' | 'subsubsection' | 'paragraph' | 'subparagraph'
  | 'appendix' | 'other';

export interface LabelDetail extends LabelEntry {
  /** 1-based line of the \label. */
  line: number;
  /** Offset of the \label's backslash in the file's LF text. */
  from: number;
  kind: LabelKind;
  /** The environment (figure*, align, hypothesis …) or sectioning command
   *  (section, chapter …) that gives the kind; null for a label before any. */
  env: string | null;
  /** Caption (short form first), heading, theorem note, or the source line
   *  of an equation; plain text except for equations, which keep their TeX. */
  title?: string;
  /** Printed name of a theorem-like environment: "Hypothesis" for
   *  \newtheorem{hyp}{Hypothesis}. */
  envTitle?: string;
  /** The project defines this label more than once. */
  duplicate?: true;
}

const FLOAT_KINDS: Record<string, LabelKind> = {
  figure: 'figure', 'figure*': 'figure', wrapfigure: 'figure', sidewaysfigure: 'figure', SCfigure: 'figure',
  subfigure: 'subfigure',
  table: 'table', 'table*': 'table', wraptable: 'table', sidewaystable: 'table', longtable: 'table', 'longtable*': 'table',
  xltabular: 'table', supertabular: 'table', SCtable: 'table',
  subtable: 'subtable',
  listing: 'listing', algorithm: 'algorithm', 'algorithm*': 'algorithm',
};
const EQUATION_ENVS = new Set(['equation', 'align', 'alignat', 'gather', 'multline', 'flalign', 'eqnarray', 'subequations', 'dmath', 'dgroup', 'xalignat', 'xxalignat']);
const CAPTIONED = new Set<LabelKind>(['figure', 'subfigure', 'table', 'subtable', 'listing', 'algorithm']);
const HEADINGS = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph']);

/** Theorem-like environments a document often uses without a \newtheorem
 *  in the scanned files (a class or a package defines them). */
const COMMON_THEOREMS = ['theorem', 'lemma', 'corollary', 'proposition', 'definition', 'remark', 'example',
  'conjecture', 'hypothesis', 'claim', 'assumption', 'axiom', 'exercise', 'problem', 'observation', 'fact',
  'notation', 'question', 'property', 'criterion', 'condition'];

/** `text` with comments, \verb arguments and verbatim-like environment bodies
 *  blanked to spaces (newlines kept), so offsets into it are offsets into
 *  `text`. A % after an odd run of backslashes is a literal (the same rule as
 *  bibload.maskComments). */
export function maskTex(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return text
    .replace(/\\verb\*?([^a-zA-Z\s*])[^\n]*?\1/g, blank)
    .replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, (m: string, pre: string, bs: string) => pre + bs + ' '.repeat(m.length - pre.length - bs.length))
    .replace(/(\\begin\s*\{(verbatim\*?|Verbatim\*?|lstlisting|minted|comment)\})([\s\S]*?)(\\end\s*\{\2\})/g,
      (_m: string, open: string, _env: string, body: string, close: string) => open + blank(body) + close);
}

/** Theorem-like environments \newtheorem defines in `text`: name → printed name. */
export function theoremsIn(text: string, into = new Map<string, string>()): Map<string, string> {
  const re = /\\newtheorem\*?\s*\{([^{}]+)\}\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g;
  for (const m of maskTex(text).matchAll(re)) into.set(m[1].trim(), texText(m[2]) || m[1].trim());
  return into;
}

/** The balanced group at `p` (after blanks): `{…}` or `[…]` (braces inside a
 *  bracket group are skipped whole). Null when there is none or it does not
 *  close within a bounded distance. */
function group(t: string, p: number, open: '{' | '['): { text: string; start: number; end: number } | null {
  while (p < t.length && (t[p] === ' ' || t[p] === '\t' || t[p] === '\n')) p++;
  if (t[p] !== open) return null;
  let depth = 0;
  const limit = Math.min(t.length, p + 8000);
  for (let i = p; i < limit; i++) {
    const c = t[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (open === '[' ? c === ']' && depth === 0 : depth === 0) return { text: t.slice(p + 1, i), start: p, end: i + 1 };
    if (depth < 0) return null;
  }
  return null;
}

/** Display text for a caption or heading: references, citations, labels and
 *  footnotes dropped, the rest de-TeXed. */
function plain(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const v = texText(s.replace(/\\(?:label|index|footnote|protect|nocite|[a-zA-Z]*cite[a-zA-Z]*|[cCvV]?ref|eqref|autoref|pageref|nameref)\*?\s*(?:\[[^\]]*\]\s*){0,2}(?:\{[^{}]*\})?/g, ' '));
  if (!v) return undefined;
  return v.length > 200 ? `${v.slice(0, 199)}…` : v;
}

interface Frame { env: string; kind?: LabelKind; caption?: string; note?: string; envTitle?: string; labels: LabelDetail[] }

export interface LabelsInOptions {
  /** Theorem-like environments of the whole project (theoremsIn over every
   *  file); defaults to this file's own plus the common names. */
  theorems?: Map<string, string>;
  /** The file starts after \appendix (an \input that follows it). */
  appendix?: boolean;
}

/** Every \label in one file, in file order, with its kind and title. */
export function labelsIn(text: string, file: string, opts: LabelsInOptions = {}): LabelDetail[] {
  const src = text.replace(/\r\n?/g, '\n');
  const t = maskTex(src);
  const theorems = opts.theorems ?? theoremsIn(src);
  const theoremTitle = (env: string): string | undefined => {
    const name = env.replace(/\*$/, '');
    return theorems.get(name) ?? theorems.get(env)
      ?? (COMMON_THEOREMS.includes(name) ? name[0].toUpperCase() + name.slice(1) : undefined);
  };
  const out: LabelDetail[] = [];
  const frames: Frame[] = [];
  const footnotes: { start: number; end: number }[] = [];
  let heading: { kind: LabelKind; env: string; title?: string } | null = null;
  let appendix = !!opts.appendix;
  let line = 1, counted = 0;

  const TOKEN = /\\(begin|end)\s*\{([^{}]*)\}|\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|captionof|caption|subcaption|label|appendix|footnote)(?![a-zA-Z@])(\*?)/g;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(t))) {
    const at = m.index;
    const after = at + m[0].length;
    if (m[1] === 'begin') {
      const env = m[2].trim();
      const base = env.replace(/\*$/, '');
      const frame: Frame = { env, labels: [] };
      if (FLOAT_KINDS[env]) frame.kind = FLOAT_KINDS[env];
      else if (EQUATION_ENVS.has(base)) frame.kind = 'equation';
      else if (base === 'enumerate') frame.kind = 'item';
      else {
        const printed = theoremTitle(env);
        if (printed) {
          frame.kind = 'theorem';
          frame.envTitle = printed;
          frame.note = plain(group(t, after, '[')?.text);
        }
      }
      frames.push(frame);
      continue;
    }
    if (m[1] === 'end') {
      const env = m[2].trim();
      for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i].env === env) { frames.length = i; break; }
      }
      continue;
    }
    const cmd = m[3];
    if (HEADINGS.has(cmd)) {
      const short = group(t, after, '[');
      const long = group(t, short ? short.end : after, '{');
      heading = { kind: appendix && cmd !== 'part' ? 'appendix' : cmd as LabelKind, env: cmd, title: plain(short?.text ?? long?.text) };
      continue;
    }
    if (cmd === 'appendix') { appendix = true; continue; }
    if (cmd === 'footnote') {
      const opt = group(t, after, '[');
      const body = group(t, opt ? opt.end : after, '{');
      if (body) footnotes.push(body);
      continue;
    }
    if (cmd === 'caption' || cmd === 'captionof' || cmd === 'subcaption') {
      let p = after;
      let type: string | undefined;
      if (cmd === 'captionof') {
        const g = group(t, p, '{');
        if (!g) continue;
        type = g.text.trim();
        p = g.end;
      }
      const short = group(t, p, '[');
      const long = group(t, short ? short.end : p, '{');
      const title = plain(short?.text ?? long?.text);
      let target: Frame | undefined;
      if (cmd === 'caption') {
        for (let i = frames.length - 1; i >= 0 && !target; i--) if (frames[i].kind && CAPTIONED.has(frames[i].kind!)) target = frames[i];
      } else {
        target = frames[frames.length - 1];
        if (target) {
          const inTable = frames.some((f) => f.kind === 'table');
          target.kind = cmd === 'subcaption' ? (target.kind ?? (inTable ? 'subtable' : 'subfigure'))
            : (FLOAT_KINDS[type!] ?? (type === 'equation' ? 'equation' : 'other'));
        }
      }
      if (target && title) {
        target.caption = title;
        for (const l of target.labels) l.title ??= title;
      }
      continue;
    }
    // \label[type]{name} (cleveref's optional type is allowed)
    const opt = group(t, after, '[');
    const arg = group(t, opt ? opt.end : after, '{');
    if (!arg) continue;
    const name = arg.text.trim();
    if (!name || /[#\\{}]/.test(name)) continue; // a macro definition's \label{#1}, or junk
    for (; counted < at; counted++) if (src.charCodeAt(counted) === 10) line++;
    const entry: LabelDetail = { label: name, file, line, from: at, kind: 'other', env: null };
    const inFootnote = footnotes.some((f) => at > f.start && at < f.end);
    let frame: Frame | undefined;
    for (let i = frames.length - 1; i >= 0 && !frame; i--) if (frames[i].kind) frame = frames[i];
    if (inFootnote) {
      entry.kind = 'footnote';
    } else if (frame) {
      entry.kind = frame.kind!;
      entry.env = frame.env;
      if (frame.kind === 'theorem') {
        entry.envTitle = frame.envTitle;
        if (frame.note) entry.title = frame.note;
      } else if (frame.kind === 'equation') {
        entry.title = equationLine(src, t, at);
      } else if (frame.caption) {
        entry.title = frame.caption;
      }
      frame.labels.push(entry);
    } else if (heading) {
      entry.kind = heading.kind;
      entry.env = heading.env;
      if (heading.title) entry.title = heading.title;
    }
    if (entry.title === undefined) delete entry.title;
    if (entry.envTitle === undefined) delete entry.envTitle;
    out.push(entry);
  }
  return out;
}

/** The source of the equation row holding a label (the label and the row's
 *  \\ dropped), or the line above when the label stands alone. */
function equationLine(src: string, masked: string, at: number): string | undefined {
  const lineAt = (pos: number) => {
    const s = masked.lastIndexOf('\n', pos - 1) + 1;
    const e = masked.indexOf('\n', pos);
    return { s, e: e === -1 ? masked.length : e };
  };
  const tidy = (s: string) => s.replace(/\\label\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}/g, '').replace(/\\\\\s*(?:\[[^\]]*\])?\s*$/, '')
    .replace(/\\(?:begin|end)\s*\{[^{}]*\}/g, '').replace(/\\(?:nonumber|notag)\b/g, '').replace(/\s+/g, ' ').trim();
  let { s, e } = lineAt(at);
  let v = tidy(src.slice(s, e));
  if (!v && s > 0) {
    ({ s, e } = lineAt(s - 1));
    v = tidy(src.slice(s, e));
  }
  if (!v) return undefined;
  return v.length > 120 ? `${v.slice(0, 119)}…` : v;
}

/** Flags every label defined more than once across `entries` (in place). */
export function markDuplicates<T extends LabelDetail>(entries: T[]): T[] {
  const seen = new Map<string, number>();
  for (const e of entries) seen.set(e.label, (seen.get(e.label) ?? 0) + 1);
  for (const e of entries) if (seen.get(e.label)! > 1) e.duplicate = true;
  return entries;
}

/**
 * Files that start after an \appendix: those \input or \include'd after the
 * \appendix of a file in the root's graph, and everything they include.
 * Names resolve from the root file's directory, `.tex` added when the name has
 * no extension (as wordcount.documentFiles does).
 */
export function appendixFiles(rootFile: string, read: (path: string) => string | null): Set<string> {
  const rootDir = rootFile.includes('/') ? rootFile.slice(0, rootFile.lastIndexOf('/') + 1) : '';
  const resolve = (raw: string) => {
    const name = raw.trim();
    if (!name || name.includes('\\')) return null;
    return (rootDir + (/\.[a-z0-9]+$/i.test(name) ? name : `${name}.tex`)).replace(/^\.\//, '');
  };
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (file: string, inAppendix: boolean) => {
    const key = `${file}\u0000${inAppendix}`;
    if (seen.has(key) || seen.size > 2000) return;
    seen.add(key);
    if (inAppendix) out.add(file);
    const text = read(file);
    if (text == null) return;
    const t = maskTex(text);
    let appendix = inAppendix;
    const re = /\\appendix(?![a-zA-Z@])|\\(?:input|include|subfile)\s*\{([^{}]*)\}/g;
    for (const m of t.matchAll(re)) {
      if (m[1] === undefined) { appendix = true; continue; }
      const child = resolve(m[1]);
      if (child) walk(child, appendix);
    }
  };
  walk(rootFile, false);
  return out;
}
