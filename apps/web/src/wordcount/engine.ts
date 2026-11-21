/**
 * Laytekz word-count engine (V2 WP24, feature 13).
 *
 * Every word of a LaTeX document gets a part (title page, abstract, main
 * text, statements, appendix, supplementary material, references, excluded)
 * and a kind (text, headings, citations, footnotes, captions, tables). A rule
 * picks the cells of that matrix that count. The scanner is one pass over
 * the characters, with the document state (preamble or body, the part in
 * force, the environment stack, ignore blocks, macros) carried across
 * \input and \include in document order, so a table file pulled in inside a
 * table environment counts as table text.
 *
 * This file is pure: no imports, no Node or browser APIs. Its twin,
 * apps/web/src/wordcount/engine.ts, must stay byte-identical (a web unit
 * test compares the two files). Edit this copy and copy it across.
 */

export type Part = 'front' | 'abstract' | 'main' | 'statements' | 'appendix' | 'supplementary' | 'references' | 'excluded';
export type Kind = 'text' | 'headings' | 'citations' | 'footnotes' | 'captions' | 'tables';

export const PARTS: readonly Part[] = ['front', 'abstract', 'main', 'statements', 'appendix', 'supplementary', 'references', 'excluded'];
export const KINDS: readonly Kind[] = ['text', 'headings', 'citations', 'footnotes', 'captions', 'tables'];

export const PART_LABELS: Record<Part, string> = {
  front: 'Title page', abstract: 'Abstract', main: 'Main text', statements: 'Acknowledgments and statements',
  appendix: 'Appendices', supplementary: 'Supplementary material', references: 'References', excluded: 'Not counted',
};
export const KIND_LABELS: Record<Kind, string> = {
  text: 'Text', headings: 'Headings', citations: 'In-text citations (estimated)', footnotes: 'Footnotes',
  captions: 'Captions and figure notes', tables: 'Tables',
};

export interface RulePatterns {
  supplementaryHeadings: string[];
  supplementaryEnvironments: string[];
  supplementaryCommands: string[];
  supplementaryFiles: string[];
  statementHeadings: string[];
  appendixHeadings: string[];
  referenceHeadings: string[];
  ignoredEnvironments: string[];
}
export type PatternList = keyof RulePatterns;
export const PATTERN_LISTS: readonly PatternList[] = [
  'supplementaryHeadings', 'supplementaryEnvironments', 'supplementaryCommands', 'supplementaryFiles',
  'statementHeadings', 'appendixHeadings', 'referenceHeadings', 'ignoredEnvironments',
];

export type PresetId = 'main' | 'main-captions' | 'main-abstract' | 'main-statements-appendix' | 'everything' | 'custom';
export const PRESET_IDS: readonly PresetId[] = ['main', 'main-captions', 'main-abstract', 'main-statements-appendix', 'everything', 'custom'];

export interface WordCountRule {
  v: 1;
  preset: PresetId;
  parts: Part[];
  kinds: Kind[];
  formulas: 'none' | 'one-word';
  target: number | null;
  abstractLimit: number | null;
  /** Find supplementary material, statements, appendices and references from headings, environments and file names. */
  detect: boolean;
  patterns: RulePatterns;
  /** sectionKey(heading title) -> the part that section counts as. */
  sections: Record<string, Part>;
}

/** Patterns are globs: `*` any run, `?` one character, everything else literal; case-insensitive, whole title or path. */
export const DEFAULT_PATTERNS: RulePatterns = {
  supplementaryHeadings: ['Supplement*', 'Supplemental*', 'Supporting information', 'Online supplement*', 'Electronic supplementary material'],
  supplementaryEnvironments: ['supplement', 'supplementary', 'supplementarymaterial'],
  supplementaryCommands: ['beginsupplement', 'supplementarymaterial'],
  supplementaryFiles: ['supplement*', 'supp_*', 'supp-*', '*_supp.tex', '*-supp.tex', 'si/*', '*_si.tex', '*-si.tex'],
  statementHeadings: ['Acknowledg*', 'Declaration*', 'Funding', 'Author contributions', 'Conflict* of interest', 'Competing interests',
    'Data availability*', 'Availability of data*', 'Code availability*', 'Open practices*', 'Ethics*'],
  appendixHeadings: ['Appendix*', 'Appendices'],
  referenceHeadings: ['References', 'Bibliography', 'Works cited'],
  ignoredEnvironments: ['verbatim', 'verbatim*', 'lstlisting', 'minted', 'comment', 'filecontents', 'filecontents*', 'tikzpicture', 'picture', 'algorithmic'],
};

const BASE_KINDS: Kind[] = ['text', 'headings', 'citations', 'footnotes'];

export const PRESETS: Record<Exclude<PresetId, 'custom'>, { label: string; parts: Part[]; kinds: Kind[] }> = {
  main: { label: 'Main text', parts: ['main'], kinds: BASE_KINDS },
  'main-captions': { label: 'Main text and captions', parts: ['main'], kinds: [...BASE_KINDS, 'captions'] },
  'main-abstract': { label: 'Main text and abstract', parts: ['abstract', 'main'], kinds: BASE_KINDS },
  'main-statements-appendix': { label: 'Main text, acknowledgments and appendices', parts: ['main', 'statements', 'appendix'], kinds: BASE_KINDS },
  everything: { label: 'Everything in the document', parts: ['front', 'abstract', 'main', 'statements', 'appendix', 'supplementary'], kinds: [...KINDS] },
};

export const DEFAULT_RULE: WordCountRule = {
  v: 1, preset: 'main', parts: ['main'], kinds: [...BASE_KINDS], formulas: 'none', target: null, abstractLimit: null,
  detect: true, patterns: DEFAULT_PATTERNS, sections: {},
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1_000_000 ? v : null);

/**
 * The full rule a stored (sparse) rule stands for. Lenient: an unknown or
 * malformed field falls back to the default, so a rule written by a newer
 * client never breaks the count. A preset other than 'custom' decides the
 * parts and kinds; pattern lists that are absent keep their defaults.
 */
export function resolveRule(stored: unknown): WordCountRule {
  if (!isObj(stored)) return DEFAULT_RULE;
  const preset: PresetId = PRESET_IDS.includes(stored.preset as PresetId) ? (stored.preset as PresetId) : 'main';
  const listOf = <T extends string>(v: unknown, known: readonly T[]): T[] | null =>
    Array.isArray(v) ? known.filter((k) => v.includes(k)) : null;
  let parts: Part[];
  let kinds: Kind[];
  if (preset === 'custom') {
    parts = listOf(stored.parts, PARTS) ?? [...PRESETS.main.parts];
    kinds = listOf(stored.kinds, KINDS) ?? [...PRESETS.main.kinds];
  } else {
    parts = [...PRESETS[preset].parts];
    kinds = [...PRESETS[preset].kinds];
  }
  const patterns = { ...DEFAULT_PATTERNS };
  if (isObj(stored.patterns)) {
    for (const k of PATTERN_LISTS) {
      const v = stored.patterns[k];
      if (Array.isArray(v)) patterns[k] = v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
    }
  }
  const sections: Record<string, Part> = {};
  if (isObj(stored.sections)) {
    for (const [k, v] of Object.entries(stored.sections)) if (PARTS.includes(v as Part)) sections[sectionKey(k)] = v as Part;
  }
  return {
    v: 1, preset, parts, kinds,
    formulas: stored.formulas === 'one-word' ? 'one-word' : 'none',
    target: posInt(stored.target), abstractLimit: posInt(stored.abstractLimit),
    detect: stored.detect !== false, patterns, sections,
  };
}

/** A short stable hash of a rule (cache keys). */
export function ruleHash(rule: WordCountRule): string {
  const s = stableJson(rule);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** Whole-string, case-insensitive glob match (`*`, `?`); linear backtracking, no regular expressions. */
export function globMatch(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  let pi = 0, ti = 0, star = -1, mark = 0;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === t[ti])) { pi++; ti++; }
    else if (pi < p.length && p[pi] === '*') { star = pi++; mark = ti; }
    else if (star >= 0) { pi = star + 1; ti = ++mark; }
    else return false;
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

const matchAny = (list: readonly string[], s: string): boolean => list.some((p) => globMatch(p, s));

/** The key a section override is stored under: the heading's plain title, lower case, single spaces. */
export function sectionKey(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.:]+$/, '').slice(0, 200);
}

/** APA author-date estimate for one cited work: "Smith, 2020" 2, "Smith & Jones, 2020" 4, "Smith et al., 2020" 4; unknown 2. */
export function citeEstimate(author: string | undefined | null): number {
  if (!author || !author.trim()) return 2;
  const n = author.split(/\s+and\s+/i).filter((s) => s.trim()).length;
  return n >= 2 ? 4 : 2;
}

// ---------------------------------------------------------------------------
// Tallies

/** Sparse counts: `words` and `chars` keyed "part:kind"; formulas per part as [inline, display]. */
export interface Tally {
  words: Record<string, number>;
  chars: Record<string, number>;
  formulas: Record<string, [number, number]>;
  /** Words in % comments. */
  comments: number;
  /** Words in %TC:ignore blocks, \iffalse blocks and never-counted environments (code, drawings). */
  ignored: number;
}

export const emptyTally = (): Tally => ({ words: {}, chars: {}, formulas: {}, comments: 0, ignored: 0 });

export function addTally(into: Tally, t: Tally): Tally {
  for (const k in t.words) into.words[k] = (into.words[k] ?? 0) + t.words[k];
  for (const k in t.chars) into.chars[k] = (into.chars[k] ?? 0) + t.chars[k];
  for (const k in t.formulas) {
    const f = into.formulas[k] ?? (into.formulas[k] = [0, 0]);
    f[0] += t.formulas[k][0];
    f[1] += t.formulas[k][1];
  }
  into.comments += t.comments;
  into.ignored += t.ignored;
  return into;
}

/** Words the rule counts in a tally. */
export function applyRule(t: Tally, rule: WordCountRule): number {
  let n = 0;
  for (const p of rule.parts) {
    for (const k of rule.kinds) n += t.words[`${p}:${k}`] ?? 0;
    if (rule.formulas === 'one-word') { const f = t.formulas[p]; if (f) n += f[0] + f[1]; }
  }
  return n;
}

/** Every word that would print, whatever the rule (the selection count): all parts but 'excluded', all kinds. */
export function printedWords(t: Tally): number {
  let n = 0;
  for (const k in t.words) if (!k.startsWith('excluded:')) n += t.words[k];
  return n;
}

export const cellWords = (t: Tally, part: Part, kind?: Kind): number => {
  if (kind) return t.words[`${part}:${kind}`] ?? 0;
  let n = 0;
  for (const k of KINDS) n += t.words[`${part}:${k}`] ?? 0;
  return n;
};

// ---------------------------------------------------------------------------
// Scanner state

export interface Scope { level: number; part: Part }

/** The state carried across files; serialisable (the client re-scans a file from the server's entry state). */
export interface ScanState {
  inDocument: boolean;
  /** \end{document} was reached: nothing after it counts. */
  ended: boolean;
  /** Inside %TC:ignore … %TC:endignore. */
  ignore: boolean;
  /** %WC:<part>: the strongest rule, until the next marker. */
  marker: Part | null;
  /** A section counted differently (rule.sections), until a heading of the same or a higher level. */
  override: Scope | null;
  /** Statements or references found from a heading, until a heading of the same or a higher level. */
  scoped: Scope | null;
  /** Appendix or supplementary material: lasts to the end of the document. */
  sticky: Part | null;
  envs: string[];
  /** Number of macro definitions in force (an index into DocumentCount.macros). */
  macros: number;
  numeric: boolean;
  includeOnly: string[] | null;
  /** The argument context an \input sat in (an \input inside \caption{…}). */
  kind: Kind | null;
  part: Part | null;
}

export const initialState = (inDocument: boolean): ScanState => ({
  inDocument, ended: false, ignore: false, marker: null, override: null, scoped: null, sticky: null,
  envs: [], macros: 0, numeric: false, includeOnly: null, kind: null, part: null,
});

const cloneState = (s: ScanState): ScanState => ({ ...s, envs: [...s.envs], includeOnly: s.includeOnly ? [...s.includeOnly] : null,
  override: s.override ? { ...s.override } : null, scoped: s.scoped ? { ...s.scoped } : null });

/** Whether two states would give a following file different parts (the client refetches when they differ). */
export function sameState(a: ScanState, b: ScanState): boolean {
  return a.inDocument === b.inDocument && a.ended === b.ended && a.ignore === b.ignore && a.marker === b.marker
    && a.sticky === b.sticky && a.macros === b.macros && a.numeric === b.numeric
    && JSON.stringify([a.override, a.scoped, a.envs, a.includeOnly]) === JSON.stringify([b.override, b.scoped, b.envs, b.includeOnly]);
}

export interface Segment {
  file: string;
  /** Which occurrence of the file (a file \input twice is counted twice, as TeX prints it). */
  occ: number;
  line: number;
  /** The heading that starts this segment, or the heading in force when it continues one (cont). */
  heading: string | null;
  level: number | null;
  cont: boolean;
  tally: Tally;
}

export interface Occurrence { file: string; occ: number; parent: string | null; line: number; entry: ScanState; exit: ScanState }
export interface Why { part: Part; reason: string; file: string; line: number }
export interface Unresolved { file: string; line: number; target: string; reason: 'macro' | 'missing' | 'cycle' | 'depth' | 'includeonly' }

export interface SectionCount { title: string | null; file: string; line: number; level: number | null; part: Part; counted: number; words: number; tally: Tally }

export interface DocumentCount {
  rootFile: string;
  /** Counted words under the rule. Always equals the sum of `files`. */
  total: number;
  /** Counted words per file, in document order (first occurrence), root first. */
  files: Record<string, number>;
  tally: Tally;
  /** Words per part, within the rule's kinds. */
  parts: Record<Part, number>;
  /** Words per kind, within the rule's parts. */
  kinds: Record<Kind, number>;
  formulas: { inline: number; display: number };
  segments: Segment[];
  occurrences: Occurrence[];
  sections: SectionCount[];
  why: Why[];
  unresolved: Unresolved[];
  citedKeys: string[];
  macros: [string, string][];
  numericCitations: boolean;
}

export interface CountOptions {
  /** Estimated words for one cited key (default 2). Numeric citation styles count 1 per command instead. */
  citeWords?: (key: string) => number;
}

// ---------------------------------------------------------------------------
// Vocabulary

const HEADINGS: Record<string, number> = { part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 };
const MATH_ENVS = new Set(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'flalign', 'flalign*',
  'eqnarray', 'eqnarray*', 'math', 'displaymath', 'alignat', 'alignat*', 'dmath', 'dmath*', 'subequations*']);
const TABLE_ENVS = new Set(['table', 'table*', 'tabular', 'tabular*', 'tabularx', 'tabulary', 'longtable', 'longtable*', 'xltabular', 'supertabular',
  'tblr', 'longtblr', 'talltblr', 'NiceTabular', 'NiceTabular*', 'threeparttable', 'threeparttablex', 'tablenotes', 'sidewaystable', 'wraptable']);
const FIGURE_ENVS = new Set(['figure', 'figure*', 'wrapfigure', 'subfigure', 'sidewaysfigure']);
const PART_ENVS: Record<string, Part> = {
  abstract: 'abstract', titlepage: 'front', acknowledgments: 'statements', acknowledgements: 'statements', acks: 'statements',
  thebibliography: 'references', appendices: 'appendix', subappendices: 'appendix',
};
/** Mandatory arguments after \begin{env} that are not text (column specs, widths). */
const ENV_ARGS: Record<string, number> = {
  tabular: 1, 'tabular*': 2, tabularx: 2, tabulary: 2, longtable: 1, xltabular: 2, supertabular: 1, NiceTabular: 1, tblr: 1, longtblr: 1,
  talltblr: 1, array: 1, minipage: 1, multicols: 1, 'multicols*': 1, wrapfigure: 2, wraptable: 2, subfigure: 1, alignat: 1, 'alignat*': 1,
  thebibliography: 1, list: 2, adjustbox: 1, tcolorbox: 0,
};
const FRONT_COMMANDS = new Set(['title', 'shorttitle', 'subtitle', 'author', 'authorsnames', 'affiliation', 'authorsaffiliations', 'authornote',
  'note', 'date', 'thanks', 'keywords']);
const CAPTION_COMMANDS: Record<string, Kind> = { caption: 'captions', subcaption: 'captions', figurenote: 'captions', captionof: 'captions', tablenote: 'tables' };
const FOOTNOTE_COMMANDS = new Set(['footnote', 'footnotetext', 'endnote', 'marginpar']);
/** est: the author-date estimate per key; year: 1 per key; author: the estimate less the year; none: nothing printed. */
const CITE_COMMANDS: Record<string, 'est' | 'year' | 'author' | 'none'> = {
  cite: 'est', citep: 'est', citet: 'est', citealp: 'est', citealt: 'est', Citep: 'est', Citet: 'est', Citealp: 'est', Citealt: 'est',
  parencite: 'est', Parencite: 'est', textcite: 'est', Textcite: 'est', autocite: 'est', Autocite: 'est', smartcite: 'est', Smartcite: 'est',
  footcite: 'est', footcitetext: 'est', supercite: 'est', fullcite: 'est', citenum: 'year', citeyear: 'year', citeyearpar: 'year',
  citeauthor: 'author', Citeauthor: 'author', citetitle: 'est', nocite: 'none',
};
/** Words a cross-reference prints ("Figure 3" is 2; a bare number is 1). */
const REF_COMMANDS: Record<string, [number, number]> = {
  ref: [1, 1], eqref: [1, 1], pageref: [1, 1], autoref: [2, 1], cref: [2, 1], Cref: [2, 1], cpageref: [2, 1], Cpageref: [2, 1],
  nameref: [2, 1], vref: [2, 1], crefrange: [2, 2], Crefrange: [2, 2], labelcref: [1, 1],
};
/** Commands whose first N mandatory arguments are not text; any later argument is read as text. */
const LITERAL_ARGS: Record<string, number> = {
  label: 1, includegraphics: 1, url: 1, nolinkurl: 1, href: 1, hyperlink: 1, hypertarget: 1, usepackage: 1, RequirePackage: 1,
  documentclass: 1, bibliography: 1, bibliographystyle: 1, addbibresource: 1, setlength: 2, addtolength: 2, setcounter: 2,
  addtocounter: 2, stepcounter: 1, refstepcounter: 1, vspace: 1, hspace: 1, pagestyle: 1, thispagestyle: 1, pagenumbering: 1,
  color: 1, textcolor: 1, colorbox: 1, fcolorbox: 2, definecolor: 3, hypersetup: 1, graphicspath: 1, geometry: 1, captionsetup: 1,
  setcitestyle: 1, linespread: 1, fontsize: 2, newtheorem: 2, theoremstyle: 1, newlength: 1, newcounter: 1, DeclareMathOperator: 2,
  newenvironment: 3, renewenvironment: 3, NewDocumentCommand: 3, RenewDocumentCommand: 3, NewDocumentEnvironment: 4,
  includepdf: 1, setmainfont: 1, setsansfont: 1, setmonofont: 1, newfontfamily: 2, rule: 2, raisebox: 1, resizebox: 2, scalebox: 1,
  parbox: 1, multicolumn: 2, multirow: 2, cline: 1, cmidrule: 1, specialrule: 3, arrayrulecolor: 1, rowcolor: 1, cellcolor: 1,
  columncolor: 1, newcolumntype: 2, crefname: 3, Crefname: 3, crefformat: 2, Crefformat: 2, labelformat: 2, index: 1, glossary: 1,
  path: 1, si: 1, bibitem: 1, addcontentsline: 2, setstretch: 1, enlargethispage: 1, settowidth: 2, AtBeginDocument: 1,
  addlinespace: 0, newpage: 0, includestandalone: 1, lstinputlisting: 1, inputminted: 2, ExecuteBibliographyOptions: 1, DeclareLanguageMapping: 2,
  urlstyle: 1, sisetup: 1, tikz: 1, pgfplotsset: 1, usetikzlibrary: 1, usepgfplotslibrary: 1, newacronym: 2,
  mintinline: 1, citestyle: 1, floatname: 2, floatstyle: 1, restylefloat: 1, newfloat: 3,
};
/** Formatting commands that print their argument as part of the surrounding word. */
const TRANSPARENT = new Set(['textbf', 'textit', 'emph', 'texttt', 'textsc', 'textsf', 'textrm', 'textup', 'textmd', 'textsl', 'textnormal',
  'underline', 'uline', 'mbox', 'hbox', 'text', 'fbox', 'enquote', 'MakeUppercase', 'MakeLowercase', 'textsuperscript', 'textsubscript',
  'uppercase', 'lowercase', 'ul', 'st', 'hl', 'foreignlanguage', 'mathrm', 'textls', 'makebox', 'framebox', 'num', 'qty', 'SI']);
const LETTER_COMMANDS = new Set(['ss', 'o', 'O', 'ae', 'AE', 'oe', 'OE', 'aa', 'AA', 'l', 'L', 'i', 'j', 'dh', 'DH', 'th', 'TH', 'ng', 'NG']);
const ACCENT_LETTER_COMMANDS = new Set(['u', 'v', 'H', 'c', 'k', 'r', 'd', 'b', 't']);
const WORD_COMMANDS = new Set(['LaTeX', 'TeX', 'LaTeXe', 'BibTeX', 'XeLaTeX', 'LuaLaTeX', 'pdfLaTeX', 'textendash', 'P', 'S', 'textsection']);
const INCLUDE_COMMANDS = new Set(['input', 'include', 'import', 'subimport', 'inputfrom', 'subinputfrom', 'includefrom', 'subincludefrom', 'subfile', 'includeonly']);
const DEFINE_COMMANDS = new Set(['newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand', 'def', 'gdef', 'edef', 'xdef', 'let']);
const NUMERIC_BST = /^(plain|unsrt|abbrv|ieeetr|IEEEtran\w*|acm|siam|vancouver|unsrtnat|nature|naturemag|phaip|apsrev\w*|elsarticle-num\w*|splncs\w*)$/;

const MAX_DEPTH = 20;
const MACRO_DEPTH = 3;

const isLetterCode = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigitCode = (c: number) => c >= 48 && c <= 57;
const WORDCHAR_RE = /[\p{L}\p{N}\p{M}]/u;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function charClass(c: number, ch: string): 0 | 1 | 2 {
  // 0: separator, 1: word character, 2: a word on its own (Han, kana)
  if (c < 128) return isLetterCode(c) || isDigitCode(c) ? 1 : 0;
  if (CJK_RE.test(ch)) return 2;
  return WORDCHAR_RE.test(ch) ? 1 : 0;
}

/** Words in plain text (comments, ignored blocks): the same word characters, no LaTeX. */
function plainWords(s: string): number {
  const m = s.match(/[\p{L}\p{N}][\p{L}\p{N}'’.,-]*/gu);
  return m ? m.length : 0;
}

/** Whether the root file picks a numeric citation style (cites before \bibliographystyle then count 1 per command too). */
export function detectNumeric(text: string): boolean {
  const t = text.replace(/(^|[^\\])%.*$/gm, '$1');
  const bst = /\\bibliographystyle\s*\{([^}]*)\}/.exec(t);
  if (bst && NUMERIC_BST.test(bst[1].trim())) return true;
  for (const m of t.matchAll(/\\usepackage\s*\[([^\]]*)\]\s*\{([^}]*)\}/g)) {
    const pkgs = m[2].split(',').map((s) => s.trim());
    if (pkgs.includes('natbib') && /\bnumbers\b/.test(m[1])) return true;
    if (pkgs.includes('biblatex') && /\b(?:style|citestyle)\s*=\s*(?:numeric|ieee|nature|vancouver|chem|phys|science|trad)/.test(m[1])) return true;
  }
  return /\\usepackage\s*\{[^}]*\bcite\b[^}]*\}/.test(t);
}

/** A heading's plain title: commands and braces dropped, spaces collapsed. */
export function plainTitle(src: string): string {
  return src.replace(/%[^\n]*/g, ' ').replace(/\\(?:label|index|footnote|thanks)\s*\{[^{}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ').replace(/\\./g, ' ').replace(/[{}~]/g, ' ').replace(/\s+/g, ' ').trim();
}

function joinPath(dir: string, p: string): string {
  const out: string[] = [];
  for (const seg of (dir ? `${dir}/${p}` : p).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** "part:kind" keys, built once (a word's cell is looked up, not concatenated, on the hot path). */
const CELL = {} as Record<Part, Record<Kind, string>>;
for (const p of PARTS) { CELL[p] = {} as Record<Kind, string>; for (const k of KINDS) CELL[p][k] = `${p}:${k}`; }

interface Ctx { kind: Kind | null; part: Part | null }
const NO_CTX: Ctx = { kind: null, part: null };

// ---------------------------------------------------------------------------
// The scanner

class Scanner {
  st: ScanState;
  readonly segments: Segment[] = [];
  readonly occurrences: Occurrence[] = [];
  readonly why: Why[] = [];
  readonly unresolved: Unresolved[] = [];
  readonly cited = new Set<string>();
  readonly defs: [string, string][];
  private macroIndex = new Map<string, number>();
  private seg!: Segment;
  private file = '';
  private fileSrc = '';
  private occ = 0;
  private lineCache = { src: '', pos: 0, line: 1 };
  private wordOpen = false;
  private wordKey: string | null = null;
  private wordLen = 0;
  private envCache: { part: Part | null; kind: Kind | null } | null = null;
  private stack: string[] = [];
  private seen = new Map<string, number>();
  private macroDepth = 0;
  private supEnvCache = new Map<string, boolean>();
  private supCmdCache = new Map<string, boolean>();

  constructor(readonly rule: WordCountRule, readonly opts: CountOptions, readonly read: ((p: string) => string | null) | null,
    readonly rootDir: string, entry: ScanState, defs: [string, string][]) {
    this.st = cloneState(entry);
    this.defs = defs.slice(0, entry.macros);
    this.defs.forEach(([n], i) => this.macroIndex.set(n, i));
  }

  // ---- segments, lines, tallies

  startSegment(file: string, occ: number, line: number, heading: string | null, level: number | null, cont: boolean): void {
    this.closeWord();
    this.seg = { file, occ, line, heading, level, cont, tally: emptyTally() };
    this.segments.push(this.seg);
  }

  lineAt(src: string, pos: number): number {
    if (src !== this.fileSrc) return this.seg?.line ?? 1;
    const c = this.lineCache;
    if (c.src !== src || pos < c.pos) { c.src = src; c.pos = 0; c.line = 1; }
    for (let i = c.pos; i < pos; i++) if (src.charCodeAt(i) === 10) c.line++;
    c.pos = pos;
    return c.line;
  }

  private envDerived(): { part: Part | null; kind: Kind | null } {
    if (this.envCache) return this.envCache;
    let part: Part | null = null;
    let kind: Kind | null = null;
    for (let i = this.st.envs.length - 1; i >= 0 && (!part || !kind); i--) {
      const e = this.st.envs[i];
      if (!part) part = PART_ENVS[e] ?? (this.isSupplementaryEnv(e) ? 'supplementary' : null);
      if (!kind) kind = TABLE_ENVS.has(e) ? 'tables' : FIGURE_ENVS.has(e) ? 'captions' : null;
    }
    return (this.envCache = { part, kind });
  }

  private isSupplementaryCommand(name: string): boolean {
    let v = this.supCmdCache.get(name);
    if (v === undefined) { v = matchAny(this.rule.patterns.supplementaryCommands, name); this.supCmdCache.set(name, v); }
    return v;
  }

  private isSupplementaryEnv(e: string): boolean {
    let v = this.supEnvCache.get(e);
    if (v === undefined) { v = this.rule.detect && matchAny(this.rule.patterns.supplementaryEnvironments, e); this.supEnvCache.set(e, v); }
    return v;
  }

  partNow(ctx: Ctx): Part | null {
    const s = this.st;
    if (s.ended) return null;
    if (s.ignore) return 'excluded';
    if (!s.inDocument) return ctx.part;
    if (s.marker) return s.marker;
    if (s.override) return s.override.part;
    if (ctx.part) return ctx.part;
    const ep = this.envDerived().part;
    if (ep) return ep;
    if (s.scoped) return s.scoped.part;
    if (s.sticky) return s.sticky;
    return 'main';
  }

  cellNow(ctx: Ctx): string | null {
    const p = this.partNow(ctx);
    if (!p) return null;
    return CELL[p][ctx.kind ?? this.envDerived().kind ?? 'text'];
  }

  closeWord(): void {
    if (this.wordKey && this.wordLen) { const c = this.seg.tally.chars; c[this.wordKey] = (c[this.wordKey] ?? 0) + this.wordLen; }
    this.wordOpen = false;
    this.wordKey = null;
    this.wordLen = 0;
  }

  /** `n` word characters: opens a word (attributed to the cell in force) or extends the open one. */
  wordChar(ctx: Ctx, n = 1): void {
    if (!this.wordOpen) {
      this.wordOpen = true;
      this.wordKey = this.cellNow(ctx);
      if (this.wordKey) { const w = this.seg.tally.words; w[this.wordKey] = (w[this.wordKey] ?? 0) + 1; }
    }
    this.wordLen += n;
  }

  /** Whole words that do not come from characters (a citation estimate, "Figure 3"). */
  addWords(ctx: Ctx, n: number, kind?: Kind): void {
    this.closeWord();
    if (n <= 0) return;
    const p = this.partNow(ctx);
    if (!p) return;
    const key = `${p}:${kind ?? ctx.kind ?? this.envDerived().kind ?? 'text'}`;
    this.seg.tally.words[key] = (this.seg.tally.words[key] ?? 0) + n;
  }

  formula(ctx: Ctx, display: boolean): void {
    this.closeWord();
    const p = this.partNow(ctx);
    if (!p) return;
    const f = this.seg.tally.formulas[p] ?? (this.seg.tally.formulas[p] = [0, 0]);
    f[display ? 1 : 0]++;
  }

  noteWhy(part: Part, reason: string, src: string, pos: number): void {
    if (this.why.length < 100) this.why.push({ part, reason, file: this.file, line: this.lineAt(src, pos) });
  }

  // ---- low-level reading

  /** Index of the `}` closing the group opened at `open`, or where an unclosed group gives up: a blank line (parStop), the \end of an environment opened before it, or `end`. */
  matchBrace(src: string, open: number, end: number, parStop: boolean): number {
    let depth = 0, envDepth = 0;
    for (let i = open; i < end; i++) {
      const c = src.charCodeAt(i);
      if (c === 92) {
        if (src.startsWith('begin{', i + 1)) envDepth++;
        else if (src.startsWith('end{', i + 1) && --envDepth < 0) return i;
        i++;
      } else if (c === 37) {
        const nl = src.indexOf('\n', i);
        i = nl < 0 || nl >= end ? end : nl;
        if (i < end) i--;
      } else if (c === 123) depth++;
      else if (c === 125) { if (--depth === 0) return i; }
      else if (c === 10 && parStop && /^\n[ \t]*\n/.test(src.slice(i, i + 40))) return i;
    }
    return end;
  }

  skipSpaces(src: string, i: number, end: number): number {
    let nl = 0;
    while (i < end) {
      const c = src.charCodeAt(i);
      if (c === 10) { if (++nl > 1) break; } else if (c !== 32 && c !== 9 && c !== 13) break;
      i++;
    }
    return i;
  }

  /** An optional argument `[…]` at i (after spaces): its inside and the index after it. */
  readOpt(src: string, i: number, end: number): { from: number; to: number; next: number } | null {
    const k = this.skipSpaces(src, i, end);
    if (src.charCodeAt(k) !== 91) return null;
    let depth = 0;
    for (let j = k + 1; j < end; j++) {
      const c = src.charCodeAt(j);
      if (c === 92) j++;
      else if (c === 123) depth++;
      else if (c === 125) depth--;
      else if (c === 93 && depth <= 0) return { from: k + 1, to: j, next: j + 1 };
      else if (c === 10 && /^\n[ \t]*\n/.test(src.slice(j, j + 40))) return null;
    }
    return null;
  }

  skipOpts(src: string, i: number, end: number): number {
    for (let o = this.readOpt(src, i, end); o; o = this.readOpt(src, i, end)) i = o.next;
    return i;
  }

  /** A mandatory argument at i: a brace group, a control sequence, or one character. */
  readArg(src: string, i: number, end: number, parStop: boolean): { from: number; to: number; next: number } | null {
    const k = this.skipSpaces(src, i, end);
    if (k >= end) return null;
    const c = src.charCodeAt(k);
    if (c === 123) {
      const close = this.matchBrace(src, k, end, parStop);
      return { from: k + 1, to: close, next: close < end && src.charCodeAt(close) === 125 ? close + 1 : close };
    }
    if (c === 92) {
      let j = k + 1;
      if (j < end && isLetterCode(src.charCodeAt(j))) while (j < end && (isLetterCode(src.charCodeAt(j)) || src.charCodeAt(j) === 64)) j++;
      else j++;
      return { from: k, to: j, next: j };
    }
    if (c === 10 || c === 125 || c === 37) return null;
    return { from: k, to: k + 1, next: k + 1 };
  }

  /** Skips `n` mandatory arguments, with any optional ones around them. */
  skipArgs(src: string, i: number, end: number, n: number): number {
    i = this.skipOpts(src, i, end);
    for (let a = 0; a < n; a++) {
      const arg = this.readArg(src, i, end, false);
      if (!arg) return i;
      i = this.skipOpts(src, arg.next, end);
    }
    return i;
  }

  // ---- the main loop

  scan(src: string, i: number, end: number, ctx: Ctx): void {
    while (i < end) {
      if (this.st.ended) return;
      if (this.st.ignore) { i = this.skipIgnored(src, i, end); continue; }
      const c = src.charCodeAt(i);
      if (c === 37) i = this.comment(src, i, end);
      else if (c === 92) i = this.command(src, i, end, ctx);
      else if (c === 123) {
        const close = this.matchBrace(src, i, end, false);
        this.scan(src, i + 1, close, ctx);
        i = close < end && src.charCodeAt(close) === 125 ? close + 1 : close;
      } else if (c === 36) i = this.dollar(src, i, end, ctx);
      else if (c < 128 && (isLetterCode(c) || isDigitCode(c))) {
        // a run of ASCII letters and digits at once
        let j = i + 1;
        while (j < end) { const d = src.charCodeAt(j); if (isLetterCode(d) || isDigitCode(d)) j++; else break; }
        this.wordChar(ctx, j - i);
        i = j;
      }
      else if (c === 45 || c === 39 || c === 0x2019) {
        // - ' ’ inside a word join it (well-known, don't); -- and ~ separate
        if (this.wordOpen && i + 1 < end && this.joinsNext(src, i + 1)) { this.wordChar(ctx); i++; }
        else { this.closeWord(); i++; }
      } else if (c === 46 || c === 44) {
        // 12.3, 1,000, e.g.: a point or comma between word characters (a comma only between digits)
        const prev = src.charCodeAt(i - 1), next = src.charCodeAt(i + 1);
        const join = this.wordOpen && i + 1 < end && (c === 46 ? (isLetterCode(prev) || isDigitCode(prev)) && (isLetterCode(next) || isDigitCode(next)) : isDigitCode(prev) && isDigitCode(next));
        if (join) this.wordChar(ctx); else this.closeWord();
        i++;
      } else if (c < 128) { this.closeWord(); i++; }
      else {
        const cp = src.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        const cls = charClass(cp, ch);
        if (cls === 1) this.wordChar(ctx, 1);
        else if (cls === 2) { this.closeWord(); this.wordChar(ctx, 1); this.closeWord(); }
        else this.closeWord();
        i += ch.length;
      }
    }
  }

  private joinsNext(src: string, j: number): boolean {
    const c = src.charCodeAt(j);
    if (c < 128) return isLetterCode(c) || isDigitCode(c);
    return charClass(c, src[j]) === 1;
  }

  private comment(src: string, i: number, end: number): number {
    this.closeWord();
    let nl = src.indexOf('\n', i);
    if (nl < 0 || nl > end) nl = end;
    const text = src.slice(i + 1, nl);
    const d = /^\s*(TC|WC)\s*:\s*([A-Za-z]+)/.exec(text);
    if (d) {
      const what = d[2].toLowerCase();
      if (d[1] === 'TC') {
        if (what === 'ignore') this.st.ignore = true;
      } else if (what === 'main' || what === 'auto') {
        this.st.marker = null; this.st.sticky = null; this.st.scoped = null;
      } else {
        const part = (PARTS as readonly string[]).find((p) => p === what) as Part | undefined
          ?? (what === 'supp' || what === 'supplement' ? 'supplementary' : what === 'ignore' || what === 'none' ? 'excluded' : undefined);
        if (part) { this.st.marker = part; this.noteWhy(part, `marker %WC:${d[2]}`, src, i); }
      }
    } else this.seg.tally.comments += plainWords(text);
    return nl;
  }

  /** Inside %TC:ignore: skip to %TC:endignore (words tallied as ignored). */
  private skipIgnored(src: string, i: number, end: number): number {
    const re = /%\s*TC\s*:\s*endignore/g;
    re.lastIndex = i;
    const m = re.exec(src);
    const stop = m && m.index < end ? m.index : end;
    this.seg.tally.ignored += plainWords(src.slice(i, stop));
    if (stop < end) {
      this.st.ignore = false;
      const nl = src.indexOf('\n', stop);
      return nl < 0 || nl > end ? end : nl;
    }
    return end;
  }

  private dollar(src: string, i: number, end: number, ctx: Ctx): number {
    const display = src.charCodeAt(i + 1) === 36;
    const start = i + (display ? 2 : 1);
    for (let j = start; j < end; j++) {
      const c = src.charCodeAt(j);
      if (c === 92) { j++; continue; }
      if (c === 36) {
        if (display && src.charCodeAt(j + 1) !== 36) continue;
        this.formula(ctx, display);
        return j + (display ? 2 : 1);
      }
      if (c === 10 && !display && /^\n[ \t]*\n/.test(src.slice(j, j + 40))) break;
    }
    // unclosed: the rest of the paragraph is the formula
    this.formula(ctx, display);
    const par = src.slice(start, end).search(/\n[ \t]*\n/);
    return par < 0 ? end : start + par;
  }

  private skipTo(src: string, from: number, end: number, needle: string): number {
    const k = src.indexOf(needle, from);
    return k < 0 || k + needle.length > end ? end : k + needle.length;
  }

  private command(src: string, i: number, end: number, ctx: Ctx): number {
    let j = i + 1;
    if (j >= end) return end;
    const c = src.charCodeAt(j);
    if (!isLetterCode(c) && c !== 64) {
      const ch = src[j];
      switch (ch) {
        case '\'': case '"': case '`': case '^': case '~': case '=': case '.': {
          // accents stay inside the word: caf\'e
          let k = j + 1;
          if (src.charCodeAt(k) === 123) { const close = this.matchBrace(src, k, end, true); k = close < end ? close + 1 : close; }
          else if (k < end && src.charCodeAt(k) !== 92) k++;
          this.wordChar(ctx);
          return k;
        }
        case '&': this.addWords(ctx, 1); return j + 1;
        case '\\': this.closeWord(); return this.skipOpts(src, src[j + 1] === '*' ? j + 2 : j + 1, end);
        case '(': this.formula(ctx, false); return this.skipTo(src, j + 1, end, '\\)');
        case '[': this.formula(ctx, true); return this.skipTo(src, j + 1, end, '\\]');
        case '-': case '/': case '@': return j + 1;
        case ',':
          if (this.wordOpen && isDigitCode(src.charCodeAt(i - 1)) && isDigitCode(src.charCodeAt(j + 1))) { this.wordChar(ctx); return j + 1; }
          this.closeWord(); return j + 1;
        default: this.closeWord(); return j + 1;
      }
    }
    while (j < end && (isLetterCode(src.charCodeAt(j)) || src.charCodeAt(j) === 64)) j++;
    const name = src.slice(i + 1, j);
    let k = j;
    const star = src.charCodeAt(k) === 42;
    if (star) k++;

    if (name === 'begin') return this.begin(src, k, end, ctx);
    if (name === 'end') return this.end(src, k, end);
    const level = HEADINGS[name];
    if (level !== undefined) return this.heading(src, i, k, end, level, ctx);
    if (INCLUDE_COMMANDS.has(name)) return this.include(src, i, k, end, name, ctx);
    if (DEFINE_COMMANDS.has(name)) return this.define(src, k, end, name);
    if (name === 'appendix') {
      this.closeWord();
      if (this.st.inDocument) { this.st.sticky = 'appendix'; this.st.scoped = null; this.noteWhy('appendix', '\\appendix', src, i); }
      return k;
    }
    if (this.rule.detect && this.st.inDocument && this.isSupplementaryCommand(name)) {
      this.closeWord();
      this.st.sticky = 'supplementary';
      this.st.scoped = null;
      this.noteWhy('supplementary', `\\${name}`, src, i);
      return k;
    }
    if (FRONT_COMMANDS.has(name) || name === 'abstract') {
      const part: Part = name === 'abstract' ? 'abstract' : 'front';
      return this.argument(src, this.skipOpts(src, k, end), end, { kind: ctx.kind, part: this.st.inDocument ? ctx.part ?? part : part }, name !== 'abstract');
    }
    const capKind = CAPTION_COMMANDS[name];
    if (capKind) {
      let p = this.skipOpts(src, k, end);
      if (name === 'captionof') p = this.skipArgs(src, p, end, 1);
      return this.argument(src, p, end, { kind: capKind, part: ctx.part }, true);
    }
    if (FOOTNOTE_COMMANDS.has(name)) return this.argument(src, this.skipOpts(src, k, end), end, { kind: 'footnotes', part: ctx.part }, false);
    const cite = CITE_COMMANDS[name];
    if (cite) return this.cite(src, k, end, cite, ctx);
    const ref = REF_COMMANDS[name];
    if (ref) { this.addWords(ctx, ref[0]); return this.skipArgs(src, k, end, ref[1]); }
    if (name === 'usepackage' || name === 'RequirePackage') return this.usepackage(src, k, end);
    if (name === 'bibliographystyle') {
      const arg = this.readArg(src, k, end, true);
      if (arg && NUMERIC_BST.test(src.slice(arg.from, arg.to).trim())) this.st.numeric = true;
      this.closeWord();
      return arg ? arg.next : k;
    }
    const lit = LITERAL_ARGS[name];
    if (lit !== undefined) { this.closeWord(); return this.skipArgs(src, k, end, lit); }
    if (TRANSPARENT.has(name)) return this.skipOpts(src, k, end);
    if (LETTER_COMMANDS.has(name) && !isLetterCode(src.charCodeAt(j))) { this.wordChar(ctx); return k; }
    if (ACCENT_LETTER_COMMANDS.has(name)) {
      const arg = this.readArg(src, k, end, true);
      this.wordChar(ctx);
      return arg ? arg.next : k;
    }
    if (WORD_COMMANDS.has(name)) { this.addWords(ctx, 1); return k; }
    if (name === 'item') {
      this.closeWord();
      const o = this.readOpt(src, k, end);
      if (o) { this.scan(src, o.from, o.to, ctx); this.closeWord(); return o.next; }
      return k;
    }
    if (name === 'verb' || name === 'lstinline') {
      this.closeWord();
      let p = name === 'lstinline' ? this.skipOpts(src, k, end) : k;
      const delim = src[p];
      if (!delim) return end;
      if (delim === '{') { const close = this.matchBrace(src, p, end, true); return close < end ? close + 1 : close; }
      const close = src.indexOf(delim, p + 1);
      return close < 0 || close >= end ? end : close + 1;
    }
    if (name === 'iffalse') return this.iffalse(src, k, end);
    const mi = this.macroIndex.get(name);
    if (mi !== undefined && this.macroDepth < MACRO_DEPTH) {
      const body = this.defs[mi][1];
      this.macroDepth++;
      this.scan(body, 0, body.length, ctx);
      this.macroDepth--;
      // a control word eats the spaces after it, but the word it printed ends there
      return src.charCodeAt(j) === 32 ? (this.closeWord(), k) : k;
    }
    this.closeWord();
    return this.skipOpts(src, k, end);
  }

  /** A text argument read in its own context (front matter, captions, footnotes). */
  private argument(src: string, i: number, end: number, ctx: Ctx, parStop: boolean): number {
    this.closeWord();
    const arg = this.readArg(src, i, end, parStop);
    if (!arg) return i;
    this.scan(src, arg.from, arg.to, ctx);
    this.closeWord();
    return arg.next;
  }

  private begin(src: string, k: number, end: number, ctx: Ctx): number {
    this.closeWord();
    const arg = this.readArg(src, k, end, true);
    if (!arg) return k;
    const env = src.slice(arg.from, arg.to).trim();
    let p = arg.next;
    if (env === 'document') { this.st.inDocument = true; return p; }
    if (env === 'comment' || matchAny(this.rule.patterns.ignoredEnvironments, env)) {
      const stop = this.skipTo(src, p, end, `\\end{${env}}`);
      this.seg.tally.ignored += plainWords(src.slice(p, stop));
      return stop;
    }
    if (MATH_ENVS.has(env)) {
      this.formula(ctx, env !== 'math');
      return this.skipTo(src, p, end, `\\end{${env}}`);
    }
    p = this.skipArgs(src, p, end, ENV_ARGS[env] ?? 0);
    this.st.envs.push(env);
    this.envCache = null;
    if (this.st.inDocument && this.isSupplementaryEnv(env)) this.noteWhy('supplementary', `environment ${env}`, src, k);
    return p;
  }

  private end(src: string, k: number, end: number): number {
    this.closeWord();
    const arg = this.readArg(src, k, end, true);
    if (!arg) return k;
    const env = src.slice(arg.from, arg.to).trim();
    if (env === 'document') { this.st.ended = true; return end; }
    const at = this.st.envs.lastIndexOf(env);
    if (at >= 0) { this.st.envs.length = at; this.envCache = null; }
    return arg.next;
  }

  private heading(src: string, at: number, k: number, end: number, level: number, ctx: Ctx): number {
    this.closeWord();
    const p = this.skipOpts(src, k, end);
    const arg = this.readArg(src, p, end, true);
    if (!arg) return p;
    if (this.st.inDocument && !this.st.ended && !this.st.ignore) {
      const title = plainTitle(src.slice(arg.from, arg.to));
      const s = this.st;
      if (s.scoped && level <= s.scoped.level) s.scoped = null;
      if (s.override && level <= s.override.level) s.override = null;
      const over = this.rule.sections[sectionKey(title)];
      if (over && !s.override) s.override = { level, part: over };
      if (this.rule.detect) {
        const pt = this.rule.patterns;
        const reason = `heading "${title}"`;
        if (level <= 1 && matchAny(pt.supplementaryHeadings, title)) { s.sticky = 'supplementary'; s.scoped = null; this.noteWhy('supplementary', reason, src, at); }
        else if (level <= 1 && matchAny(pt.appendixHeadings, title)) { s.sticky = 'appendix'; s.scoped = null; this.noteWhy('appendix', reason, src, at); }
        else if (!s.scoped && level <= 1 && matchAny(pt.referenceHeadings, title)) { s.scoped = { level, part: 'references' }; this.noteWhy('references', reason, src, at); }
        else if (!s.scoped && level <= 2 && matchAny(pt.statementHeadings, title)) { s.scoped = { level, part: 'statements' }; this.noteWhy('statements', reason, src, at); }
      }
      if (src === this.fileSrc) this.startSegment(this.file, this.occ, this.lineAt(src, at), title, level, false);
    }
    this.scan(src, arg.from, arg.to, { kind: 'headings', part: ctx.part });
    this.closeWord();
    return arg.next;
  }

  private cite(src: string, k: number, end: number, mode: 'est' | 'year' | 'author' | 'none', ctx: Ctx): number {
    this.closeWord();
    let p = k;
    // pre- and postnotes print: "see", "p. 12"
    for (let o = this.readOpt(src, p, end); o; o = this.readOpt(src, p, end)) {
      this.scan(src, o.from, o.to, { kind: 'citations', part: ctx.part });
      this.closeWord();
      p = o.next;
    }
    const arg = this.readArg(src, p, end, true);
    if (!arg) return p;
    const keys = src.slice(arg.from, arg.to).split(',').map((s) => s.trim()).filter(Boolean);
    for (const key of keys) this.cited.add(key);
    if (mode !== 'none' && keys.length) {
      let n: number;
      if (this.st.numeric) n = 1;
      else {
        n = 0;
        for (const key of keys) {
          const est = this.opts.citeWords ? this.opts.citeWords(key) : 2;
          n += mode === 'year' ? 1 : mode === 'author' ? Math.max(1, est - 1) : est;
        }
      }
      this.addWords(ctx, n, 'citations');
    }
    return arg.next;
  }

  private usepackage(src: string, k: number, end: number): number {
    this.closeWord();
    const o = this.readOpt(src, k, end);
    const p = o ? o.next : k;
    const arg = this.readArg(src, p, end, true);
    if (!arg) return p;
    const pkgs = src.slice(arg.from, arg.to).split(',').map((s) => s.trim());
    const opts = o ? src.slice(o.from, o.to) : '';
    if (pkgs.includes('natbib') && /\bnumbers\b/.test(opts)) this.st.numeric = true;
    if (pkgs.includes('biblatex') && /\b(?:style|citestyle)\s*=\s*(?:numeric|ieee|nature|vancouver|chem|phys|science|trad)/.test(opts)) this.st.numeric = true;
    if (pkgs.includes('cite') || pkgs.includes('citesort')) this.st.numeric = true;
    return this.skipOpts(src, arg.next, end);
  }

  private define(src: string, k: number, end: number, name: string): number {
    this.closeWord();
    if (name === 'let') {
      const a = this.readArg(src, k, end, true);
      if (!a) return k;
      let p = this.skipSpaces(src, a.next, end);
      if (src[p] === '=') p++;
      const b = this.readArg(src, p, end, true);
      return b ? b.next : p;
    }
    const nameArg = this.readArg(src, k, end, true);
    if (!nameArg) return k;
    let p = nameArg.next;
    let macro = src.slice(nameArg.from, nameArg.to).trim();
    if (macro.startsWith('\\')) macro = macro.slice(1);
    let params = false;
    if (name === 'def' || name === 'gdef' || name === 'edef' || name === 'xdef') {
      const brace = src.indexOf('{', p);
      if (brace < 0 || brace >= end) return end;
      params = /#/.test(src.slice(p, brace));
      p = brace;
    } else {
      const n = this.readOpt(src, p, end);
      if (n) { params = src.slice(n.from, n.to).trim() !== '0'; p = n.next; }
      const dflt = n && this.readOpt(src, p, end);
      if (dflt) p = dflt.next;
    }
    const body = this.readArg(src, p, end, false);
    if (!body) return p;
    const text = src.slice(body.from, body.to);
    if (!params && /^[a-zA-Z@]+$/.test(macro) && !text.includes('#') && text.length <= 2000) {
      this.macroIndex.set(macro, this.defs.length);
      this.defs.push([macro, text]);
      this.st.macros = this.defs.length;
    }
    return body.next;
  }

  private iffalse(src: string, k: number, end: number): number {
    this.closeWord();
    const re = /\\(if[a-zA-Z]*|fi)(?![a-zA-Z])/g;
    re.lastIndex = k;
    let depth = 1;
    for (let m = re.exec(src); m && m.index < end; m = re.exec(src)) {
      if (m[1] === 'fi') { if (--depth === 0) { this.seg.tally.ignored += plainWords(src.slice(k, m.index)); return m.index + 3; } }
      else depth++;
    }
    this.seg.tally.ignored += plainWords(src.slice(k, end));
    return end;
  }

  // ---- includes

  private include(src: string, at: number, k: number, end: number, name: string, ctx: Ctx): number {
    this.closeWord();
    const line = this.lineAt(src, at);
    if (name === 'includeonly') {
      const arg = this.readArg(src, k, end, true);
      if (!arg) return k;
      this.st.includeOnly = src.slice(arg.from, arg.to).split(',').map((s) => s.trim().replace(/\.tex$/, '')).filter(Boolean);
      return arg.next;
    }
    let target: string;
    let base: string;
    let next: number;
    if (name === 'input' && src.charCodeAt(this.skipSpaces(src, k, end)) !== 123) {
      // bare \input file
      const s = this.skipSpaces(src, k, end);
      const m = /^[^\s{}%\\]+/.exec(src.slice(s, Math.min(end, s + 300)));
      if (!m) return k;
      target = m[0];
      base = this.rootDir;
      next = s + m[0].length;
    } else if (name === 'import' || name === 'subimport' || name.endsWith('from')) {
      const a = this.readArg(src, k, end, true);
      const b = a && this.readArg(src, a.next, end, true);
      if (!a || !b) return a ? a.next : k;
      const dir = src.slice(a.from, a.to).trim();
      target = (dir && !dir.endsWith('/') ? `${dir}/` : dir) + src.slice(b.from, b.to).trim();
      base = name.startsWith('sub') ? dirOf(this.file) : this.rootDir;
      next = b.next;
    } else {
      const a = this.readArg(src, k, end, true);
      if (!a) return k;
      target = src.slice(a.from, a.to).trim();
      base = this.rootDir;
      next = a.next;
    }
    if (!target) return next;
    if (target.includes('\\') || target.includes('#')) { this.unresolved.push({ file: this.file, line, target, reason: 'macro' }); return next; }
    if (name === 'include' && this.st.includeOnly && !this.st.includeOnly.includes(target.replace(/\.tex$/, ''))) {
      this.unresolved.push({ file: this.file, line, target, reason: 'includeonly' });
      return next;
    }
    if (!this.read) return next;
    const path = joinPath(base, /\.[a-z0-9]+$/i.test(baseOf(target)) ? target : `${target}.tex`);
    if (this.stack.includes(path)) { this.unresolved.push({ file: this.file, line, target, reason: 'cycle' }); return next; }
    if (this.stack.length >= MAX_DEPTH) { this.unresolved.push({ file: this.file, line, target, reason: 'depth' }); return next; }
    let text = this.read(path);
    if (text == null && !/\.tex$/i.test(path)) text = this.read(`${path}.tex`);
    if (text == null) { this.unresolved.push({ file: this.file, line, target, reason: 'missing' }); return next; }
    if (name === 'subfile') {
      const b = text.indexOf('\\begin{document}');
      if (b >= 0) { const e = text.indexOf('\\end{document}', b); text = text.slice(b + 16, e < 0 ? undefined : e); }
    }
    this.enterFile(path, text, line, ctx);
    // the parent continues in a new segment, under the heading in force
    const h = this.lastHeading();
    this.startSegment(this.file, this.occ, line, h.heading, null, true);
    return next;
  }

  private lastHeading(): { heading: string | null } {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const s = this.segments[i];
      if (s.file === this.file && s.occ === this.occ) { if (s.heading != null || !s.cont) return { heading: s.heading }; }
    }
    return { heading: null };
  }

  enterFile(path: string, text: string, line: number, ctx: Ctx): void {
    const parent = { file: this.file, src: this.fileSrc, occ: this.occ, cache: { ...this.lineCache }, kind: this.st.kind, part: this.st.part };
    if (this.rule.detect && this.st.inDocument && parent.file && (matchAny(this.rule.patterns.supplementaryFiles, path) || matchAny(this.rule.patterns.supplementaryFiles, baseOf(path)))) {
      this.st.sticky = 'supplementary';
      this.st.scoped = null;
      if (this.why.length < 100) this.why.push({ part: 'supplementary', reason: `file ${path}`, file: parent.file, line });
    }
    const occ = this.seen.get(path) ?? 0;
    this.seen.set(path, occ + 1);
    this.file = path;
    this.fileSrc = text;
    this.occ = occ;
    this.lineCache = { src: '', pos: 0, line: 1 };
    this.st.kind = ctx.kind;
    this.st.part = ctx.part;
    const entry = cloneState(this.st);
    const record: Occurrence = { file: path, occ, parent: parent.file || null, line, entry, exit: entry };
    this.occurrences.push(record);
    this.envCache = null;
    this.startSegment(path, occ, 1, null, null, !!parent.file);
    this.stack.push(path);
    this.scan(text, 0, text.length, ctx);
    this.closeWord();
    this.stack.pop();
    record.exit = cloneState(this.st);
    this.st.kind = parent.kind;
    this.st.part = parent.part;
    this.file = parent.file;
    this.fileSrc = parent.src;
    this.occ = parent.occ;
    this.lineCache = parent.cache;
    this.envCache = null;
  }
}

// ---------------------------------------------------------------------------
// Entry points

function summarise(rootFile: string, sc: Scanner, rule: WordCountRule): DocumentCount {
  const tally = emptyTally();
  const files: Record<string, number> = {};
  let total = 0;
  for (const s of sc.segments) {
    addTally(tally, s.tally);
    const n = applyRule(s.tally, rule);
    files[s.file] = (files[s.file] ?? 0) + n;
    total += n;
  }
  const parts = {} as Record<Part, number>;
  for (const p of PARTS) { let n = 0; for (const k of rule.kinds) n += tally.words[`${p}:${k}`] ?? 0; parts[p] = n; }
  const kinds = {} as Record<Kind, number>;
  for (const k of KINDS) { let n = 0; for (const p of rule.parts) n += tally.words[`${p}:${k}`] ?? 0; kinds[k] = n; }
  let inline = 0, display = 0;
  for (const p in tally.formulas) { inline += tally.formulas[p][0]; display += tally.formulas[p][1]; }
  return {
    rootFile, total, files, tally, parts, kinds, formulas: { inline, display },
    segments: sc.segments, occurrences: sc.occurrences, sections: sectionsOf(sc.segments, rule), why: sc.why,
    unresolved: sc.unresolved, citedKeys: [...sc.cited], macros: sc.defs, numericCitations: sc.st.numeric,
  };
}

/**
 * Counts a whole document: the root file and everything it pulls in
 * (\input, \include, \import, \subimport, \subfile, bare \input), depth
 * first, with the state carried across files. Targets resolve against the
 * root file's folder (the compile directory). `read` returns null for a
 * missing file.
 */
export function countDocument(rootFile: string, read: (path: string) => string | null, rule: WordCountRule = DEFAULT_RULE, opts: CountOptions = {}): DocumentCount {
  const text = read(rootFile);
  const entry = initialState(text == null || !/\\documentclass/.test(text));
  entry.numeric = text != null && detectNumeric(text);
  const sc = new Scanner(rule, opts, read, dirOf(rootFile), entry, []);
  if (text != null) sc.enterFile(rootFile, text, 1, NO_CTX);
  return summarise(rootFile, sc, rule);
}

/**
 * Counts one text on its own (the open file while typing, a selection),
 * from an entry state (default: inside the document, main text) without
 * following includes. `macros` are the definitions the entry state's
 * `macros` count refers to (DocumentCount.macros).
 */
export function countText(text: string, rule: WordCountRule = DEFAULT_RULE, o: CountOptions & { file?: string; entry?: ScanState; macros?: [string, string][] } = {}): DocumentCount {
  const file = o.file ?? '';
  const entry = o.entry ?? initialState(!/\\documentclass/.test(text));
  const sc = new Scanner(rule, o, null, dirOf(file), entry, o.macros ?? []);
  sc.enterFile(file, text, 1, { kind: entry.kind, part: entry.part });
  return summarise(file, sc, rule);
}

/**
 * The document by top-level section: a group starts at each heading of the
 * highest level used, and runs over the following segments (across files).
 * Words before the first heading form a group with a null title.
 */
export function sectionsOf(segments: readonly Segment[], rule: WordCountRule): SectionCount[] {
  let top = Infinity;
  for (const s of segments) if (s.level != null && !s.cont && s.level < top) top = s.level;
  const out: SectionCount[] = [];
  let cur: SectionCount | null = null;
  for (const s of segments) {
    if (s.level != null && !s.cont && s.level === top) {
      cur = { title: s.heading, file: s.file, line: s.line, level: s.level, part: 'main', counted: 0, words: 0, tally: emptyTally() };
      out.push(cur);
    } else if (!cur) {
      cur = { title: null, file: s.file, line: s.line, level: null, part: 'main', counted: 0, words: 0, tally: emptyTally() };
      out.push(cur);
    }
    addTally(cur.tally, s.tally);
  }
  for (const g of out) {
    g.counted = applyRule(g.tally, rule);
    g.words = printedWords(g.tally);
    // the part most of the section's words fall in
    let best = -1;
    for (const p of PARTS) { const n = cellWords(g.tally, p); if (n > best) { best = n; g.part = p; } }
  }
  return out.filter((g) => g.title != null || g.words > 0 || g.tally.comments > 0);
}
