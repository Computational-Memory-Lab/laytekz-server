/**
 * Citation commands by package family (F17, WP19): which command each style
 * uses, how notes are written, the citation under the caret, and the
 * narrative/parenthetical toggle. Pure: no editor, no store.
 */

export type CiteFamily = 'biblatex' | 'natbib' | 'apacite' | 'bibtex';
export type CiteStyle = 'parenthetical' | 'narrative' | 'year' | 'author' | 'bare' | 'footnote' | 'full';
export type LocatorKind = 'page' | 'paragraph' | 'chapter' | 'section' | 'other';

export const STYLE_LABELS: Record<CiteStyle, string> = {
  parenthetical: 'Parenthetical',
  narrative: 'Narrative',
  year: 'Year only',
  author: 'Author only',
  bare: 'No parentheses',
  footnote: 'Footnote',
  full: 'Full author list',
};

export const LOCATOR_LABELS: Record<LocatorKind, string> = {
  page: 'Page',
  paragraph: 'Paragraph',
  chapter: 'Chapter',
  section: 'Section',
  other: 'Other',
};

export const FAMILY_LABELS: Record<CiteFamily, string> = { biblatex: 'biblatex', natbib: 'natbib', apacite: 'apacite', bibtex: 'BibTeX' };

/** Command names (no backslash) per family and style; a missing style does not exist there. */
const TABLE: Record<CiteFamily, Partial<Record<CiteStyle, string>>> = {
  biblatex: { parenthetical: 'parencite', narrative: 'textcite', year: 'parencite*', author: 'citeauthor', bare: 'cite', footnote: 'footcite' },
  natbib: { parenthetical: 'citep', narrative: 'citet', year: 'citeyearpar', author: 'citeauthor', bare: 'citealp', full: 'citet*' },
  apacite: { parenthetical: 'cite', narrative: 'citeA', year: 'citeyear', author: 'citeauthor', bare: 'citeNP' },
  bibtex: { parenthetical: 'cite' },
};

/** Capitalised forms for the first word of a sentence. */
const CAPITALS: Record<CiteFamily, Record<string, string>> = {
  biblatex: { textcite: 'Textcite', citeauthor: 'Citeauthor' },
  natbib: { citet: 'Citet', 'citet*': 'Citet*', citeauthor: 'Citeauthor' },
  apacite: {},
  bibtex: {},
};

export function stylesFor(family: CiteFamily): CiteStyle[] {
  return (Object.keys(STYLE_LABELS) as CiteStyle[]).filter((s) => TABLE[family][s]);
}

/** The command for a style, capitalised at a sentence start when asked; null when the family lacks the style. */
export function commandFor(family: CiteFamily, style: CiteStyle, o: { sentenceStart?: boolean; capitalise?: boolean } = {}): string | null {
  const name = TABLE[family][style];
  if (!name) return null;
  return (o.sentenceStart && o.capitalise !== false && CAPITALS[family][name]) || name;
}

/** The style a command writes in a family (capitalised forms included), or null. */
export function styleOf(command: string, family: CiteFamily): CiteStyle | null {
  const lower = command.replace(/^[A-Z]/, (c) => c.toLowerCase());
  for (const f of [family, ...(['biblatex', 'natbib', 'apacite', 'bibtex'] as const).filter((x) => x !== family)]) {
    for (const [style, name] of Object.entries(TABLE[f])) if (name === command || name === lower) return style as CiteStyle;
  }
  return null;
}

const ONLY_BIBLATEX = /^(?:[pP]arencites?\*?|[tT]extcites?|[aA]utocites?\*?|[fF]ootcites?|[sS]martcites?|[fF]ootcitetext|cites)$/;
const ONLY_NATBIB = /^(?:[cC]ite[pt]\*?|[cC]iteal[pt]\*?|citeyearpar|Citeauthor\*?)$/;
const ONLY_APACITE = /^(?:citeA|citeNP|citeANP|citeyearNP|fullciteA|fullciteNP|shortciteA|shortciteNP)$/;

/** The family a command can only belong to, or null for commands several share (\cite, \citeauthor). */
export function familyOfCommand(command: string): CiteFamily | null {
  if (ONLY_BIBLATEX.test(command)) return 'biblatex';
  if (ONLY_NATBIB.test(command)) return 'natbib';
  if (ONLY_APACITE.test(command)) return 'apacite';
  return null;
}

/** % # & _ $ escaped (unless they already are); a note is TeX text. */
export function escapeNote(s: string): string {
  return s.replace(/(^|[^\\])([%#&_$])/g, '$1\\$2').replace(/(^|[^\\])([%#&_$])/g, '$1\\$2');
}

/**
 * The postnote for a locator. biblatex adds "p." or "pp." to a bare page
 * number itself, so it gets `12` or `12--15`; natbib, apacite and BibTeX
 * print the note as written, so they get `p.~12` and `pp.~12--15`. Other
 * locators are written out in every family.
 */
export function formatLocator(family: CiteFamily, kind: LocatorKind, value: string): string {
  const v = value.trim();
  if (!v) return '';
  if (kind === 'other') return escapeNote(v);
  const ranged = escapeNote(v.replace(/\s*(?:--|[-–—])\s*/g, '--'));
  switch (kind) {
    case 'page':
      if (family === 'biblatex' || /^(?:p|pp)\.|^page/i.test(ranged)) return ranged;
      return `${/--|,|&/.test(ranged) ? 'pp.' : 'p.'}~${ranged}`;
    case 'paragraph': return `para.~${ranged}`;
    case 'chapter': return `Chapter~${ranged}`;
    case 'section': return `Section~${ranged}`;
  }
}

export interface CitationSpec {
  /** Without the backslash, a star included ('parencite*'). */
  command: string;
  keys: readonly string[];
  prenote?: string;
  postnote?: string;
  /** apacite's `\cite<prenote>[postnote]{…}` form. */
  angle?: boolean;
}

/** The citation's source text. A prenote alone keeps an empty postnote (`[see][]`), as biblatex and natbib require. */
export function buildCitation(spec: CitationSpec): string {
  const pre = spec.prenote?.trim() ?? '';
  const post = spec.postnote?.trim() ?? '';
  let notes = '';
  if (spec.angle) notes = `${pre ? `<${pre}>` : ''}${post ? `[${post}]` : ''}`;
  else if (pre) notes = `[${pre}][${post}]`;
  else if (post) notes = `[${post}]`;
  return `\\${spec.command}${notes}{${spec.keys.join(',')}}`;
}

/** What a family's citation looks like for a style and notes; null when the family lacks the style. */
export function citationFor(family: CiteFamily, style: CiteStyle, keys: readonly string[], notes: { prenote?: string; postnote?: string } = {}, o: { sentenceStart?: boolean; capitalise?: boolean } = {}): string | null {
  const command = commandFor(family, style, o);
  if (!command) return null;
  return buildCitation({ command, keys, prenote: family === 'bibtex' ? '' : escapeNote(notes.prenote ?? ''), postnote: notes.postnote, angle: family === 'apacite' });
}

export interface ParsedCitation {
  /** The backslash. */
  from: number;
  /** After the last closing brace. */
  to: number;
  /** The command name (without backslash, star included) spans nameFrom..nameTo. */
  nameFrom: number;
  nameTo: number;
  command: string;
  /** apacite's `<…>` note, or null. */
  angle: string | null;
  /** The `[…]` options before the first key group. */
  options: string[];
  keys: string[];
  /** Inside the first key group's braces. */
  keysFrom: number;
  keysTo: number;
}

const COMMAND = /\\([a-zA-Z]*[cC]ite[a-zA-Z]*\*?)/g;
const REACH = 2000;

/** Parses a citation whose backslash is at `at`; null when it is not one with closed braces. */
export function parseCitation(text: string, at: number): ParsedCitation | null {
  COMMAND.lastIndex = at;
  const m = COMMAND.exec(text);
  if (!m || m.index !== at) return null;
  const command = m[1];
  let i = at + m[0].length;
  const skip = () => { while (i < text.length && /[ \t]/.test(text[i])) i++; };
  const group = (open: string, close: string): string | null => {
    skip();
    if (text[i] !== open) return null;
    const end = text.indexOf(close, i + 1);
    if (end < 0 || text.slice(i + 1, end).includes('\n\n')) return null;
    const body = text.slice(i + 1, end);
    i = end + 1;
    return body;
  };
  const angle = group('<', '>');
  const options: string[] = [];
  for (let n = 0; n < 2; n++) {
    const save = i;
    const o = group('[', ']');
    if (o === null) { i = save; break; }
    options.push(o);
  }
  skip();
  if (text[i] !== '{') return null;
  const keysFrom = i + 1;
  const keysTo = text.indexOf('}', keysFrom);
  if (keysTo < 0 || /[{\n]/.test(text.slice(keysFrom, keysTo).replace(/\n(?!\s*\n)/g, ' '))) return null;
  i = keysTo + 1;
  // The further groups of a plural citation (\textcites{a}{b}, \parencites[12]{a}[3]{b}).
  if (/cites\*?$/.test(command)) {
    for (;;) {
      const save = i;
      let ok = true;
      for (let n = 0; n < 2; n++) { const s = i; if (group('[', ']') === null) { i = s; break; } }
      if (group('{', '}') === null) ok = false;
      if (!ok) { i = save; break; }
    }
  }
  const keys = text.slice(keysFrom, keysTo).split(',').map((k) => k.trim()).filter(Boolean);
  return { from: at, to: i, nameFrom: at + 1, nameTo: at + m[0].length, command, angle, options, keys, keysFrom, keysTo };
}

/** The citation the caret is in, on its command, or right after (a caret just after `}` counts as inside). */
export function parseCitationAt(text: string, pos: number): ParsedCitation | null {
  COMMAND.lastIndex = Math.max(0, pos - REACH);
  const starts: number[] = [];
  for (let m = COMMAND.exec(text); m && m.index <= pos; m = COMMAND.exec(text)) {
    // A doubled backslash is a line break, not a command.
    if (text[m.index - 1] === '\\') continue;
    starts.push(m.index);
  }
  for (let n = starts.length - 1; n >= 0; n--) {
    const c = parseCitation(text, starts[n]);
    if (c && pos > c.from && pos <= c.to) return c;
  }
  return null;
}

/** Prenote and postnote of a parsed citation. */
export function notesOf(c: ParsedCitation): { prenote: string; postnote: string } {
  if (c.angle !== null) return { prenote: c.angle, postnote: c.options[0] ?? '' };
  if (c.options.length >= 2) return { prenote: c.options[0], postnote: c.options[1] };
  return { prenote: '', postnote: c.options[0] ?? '' };
}

/** Reads a postnote back into a locator: `12`, `p.~12`, `pp.~3--4`, `para.~4`, `Chapter~3`, `Section~2.1`; anything else is 'other'. */
export function locatorOf(postnote: string): { kind: LocatorKind; value: string } {
  const p = postnote.trim();
  if (!p) return { kind: 'page', value: '' };
  let m = /^(?:pp?\.|pages?)\s*~?\s*(.+)$/i.exec(p);
  if (m) return { kind: 'page', value: m[1] };
  if (/^[0-9ivxlcdm]+(?:\s*(?:--|-)\s*[0-9ivxlcdm]+)?$/i.test(p)) return { kind: 'page', value: p };
  m = /^para(?:graph)?\.?\s*~?\s*(.+)$/i.exec(p);
  if (m) return { kind: 'paragraph', value: m[1] };
  m = /^(?:chap(?:ter)?\.?)\s*~?\s*(.+)$/i.exec(p);
  if (m) return { kind: 'chapter', value: m[1] };
  m = /^(?:sec(?:tion)?\.?|\\S)\s*~?\s*(.+)$/i.exec(p);
  if (m) return { kind: 'section', value: m[1] };
  return { kind: 'other', value: p.replace(/\\([%#&_$])/g, '$1') };
}

const TOGGLE: Record<string, string> = {
  parencite: 'textcite', autocite: 'textcite', footcite: 'textcite', smartcite: 'textcite',
  textcite: 'parencite', Textcite: 'parencite', Parencite: 'Textcite', Autocite: 'Textcite',
  parencites: 'textcites', autocites: 'textcites', textcites: 'parencites', Textcites: 'parencites', Parencites: 'Textcites',
  citep: 'citet', citet: 'citep', 'citep*': 'citet*', 'citet*': 'citep*', Citep: 'Citet', Citet: 'Citep', 'Citep*': 'Citet*', 'Citet*': 'Citep*',
  citealp: 'citealt', citealt: 'citealp',
  citeA: 'cite',
};

/**
 * The other main style's command name, or null when the command does not
 * switch. The command found in the text decides its family (\citep in a
 * biblatex document still becomes \citet); only \cite asks the document's.
 */
export function toggledCommand(command: string, family: CiteFamily): string | null {
  if (TOGGLE[command]) return TOGGLE[command];
  if (command === 'cite') return family === 'biblatex' ? 'textcite' : family === 'apacite' ? 'citeA' : family === 'natbib' ? 'citep' : null;
  return null;
}

/** The smallest change turning `before` into `after`, both starting at `offset`. */
export function minimalChange(before: string, after: string, offset = 0): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { from: offset + start, to: offset + before.length - end, insert: after.slice(start, after.length - end) };
}

/** The caret starts a sentence: start of the text, a blank line, or after . ! ? and a space. */
export function atSentenceStart(textBefore: string): boolean {
  const tail = textBefore.slice(-400);
  if (!tail.trim()) return true;
  if (/\n[ \t]*\n\s*$/.test(tail)) return true;
  return /[.!?]['"’”)\]}]*\s+$/.test(tail) || /\\(?:item|par)\s*(?:\[[^\]]*\])?\s*$/.test(tail);
}

/** A space goes before a citation the picker inserts right after a letter or digit. */
export function wantsSpaceBefore(textBefore: string): boolean {
  return /[\p{L}\p{N}]$/u.test(textBefore);
}

/** Masks comments line by line, keeping offsets (a `%` after a backslash is text). */
function maskComments(text: string): string {
  return text.replace(/(^|[^\\])(%.*)$/gm, (_m, a: string, c: string) => a + ' '.repeat(c.length));
}

/**
 * The family a document's own preamble asks for, read on the client when the
 * server's answer (GET …/cite-setup) is not there yet. Only the open file:
 * null when it has no \documentclass.
 */
export function detectFamilyIn(text: string): CiteFamily | null {
  const head = maskComments(text.split(/\\begin\s*\{document\}/)[0]);
  if (!/\\documentclass/.test(head)) return null;
  const cls = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{\s*apa7\s*\}/.exec(head);
  if (cls) {
    const opts = (cls[1] ?? '').split(',').map((s) => s.trim());
    if (opts.includes('biblatex')) return 'biblatex';
    if (opts.includes('natbib')) return 'natbib';
    if (opts.includes('apacite')) return 'apacite';
  }
  const pkg = (name: string) => new RegExp(`\\\\(?:usepackage|RequirePackage)\\s*(?:\\[([^\\]]*)\\])?\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).exec(head);
  if (pkg('biblatex')) return 'biblatex';
  if (pkg('natbib')) return 'natbib';
  const apa = pkg('apacite');
  if (apa) return /natbibapa/.test(apa[1] ?? '') ? 'natbib' : 'apacite';
  if (/\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*(?:elsarticle|aastex\w*|revtex4\w*)\s*\}/.test(head)) return 'natbib';
  return 'bibtex';
}
