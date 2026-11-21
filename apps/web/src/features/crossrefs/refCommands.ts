/**
 * Cross-reference forms (WP26, feature 17): which command a picked label gets,
 * by the document's packages (WP15's GET …/cite-setup) and the person's
 * setting. Pure: no editor, no store, no network.
 *
 * - cleveref loaded: `\cref{a,b}`, `\Cref` at the start of a sentence, and
 *   `\Cref` everywhere under the apa7 class (APA capitalises "Figure 1"
 *   mid-sentence).
 * - Otherwise: `Figure~\ref{a}`, `Table~\ref{a}`, `Section~\ref{a}`,
 *   `Hypothesis~\ref{a}` (a theorem's printed name); equations `\eqref{a}`
 *   with amsmath, else `(\ref{a})`; items and the rest a bare `\ref{a}`.
 *   Several labels of one kind join APA-style: "Figures~\ref{a} and~\ref{b}",
 *   "Figures~\ref{a}, \ref{b}, and~\ref{c}".
 * - When the text before the caret already names the kind ("Figure ",
 *   "fig.", "Tables~"), only the references are written and the space before
 *   them becomes a tie.
 */

/** The server's label kinds (apps/server/src/labels.ts LabelKind). */
export type LabelKind =
  | 'figure' | 'subfigure' | 'table' | 'subtable' | 'equation' | 'item' | 'theorem'
  | 'listing' | 'algorithm' | 'footnote'
  | 'part' | 'chapter' | 'section' | 'subsection' | 'subsubsection' | 'paragraph' | 'subparagraph'
  | 'appendix' | 'other';

/** One entry of GET …/labels?detail=1 (apps/server/src/labels.ts LabelDetail). */
export interface LabelDetail {
  label: string;
  file: string;
  line?: number;
  from?: number;
  kind?: LabelKind | string;
  env?: string | null;
  title?: string;
  envTitle?: string;
  duplicate?: boolean;
}

/** What the reference forms depend on (a subset of WP15's CiteSetup). */
export interface RefSetup {
  documentClass: string | null;
  cleveref: boolean;
  cleverefCapitalise?: boolean;
  hyperref: boolean;
  amsmath: boolean;
  varioref: boolean;
  nameref: boolean;
}

export const NO_SETUP: RefSetup = { documentClass: null, cleveref: false, cleverefCapitalise: false, hyperref: false, amsmath: false, varioref: false, nameref: false };

export type RefGroup = 'figure' | 'table' | 'equation' | 'section' | 'appendix' | 'theorem' | 'item' | 'listing' | 'other';

/** The picker's groups, in the order they are listed. */
export const GROUPS: readonly { id: RefGroup; title: string }[] = [
  { id: 'figure', title: 'Figures' },
  { id: 'table', title: 'Tables' },
  { id: 'equation', title: 'Equations' },
  { id: 'section', title: 'Sections' },
  { id: 'appendix', title: 'Appendices' },
  { id: 'theorem', title: 'Hypotheses and theorems' },
  { id: 'item', title: 'Items' },
  { id: 'listing', title: 'Listings' },
  { id: 'other', title: 'Other' },
];

const HEADING_KINDS = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph']);

export function groupOf(l: Pick<LabelDetail, 'kind'>): RefGroup {
  switch (l.kind) {
    case 'figure': case 'subfigure': return 'figure';
    case 'table': case 'subtable': return 'table';
    case 'equation': return 'equation';
    case 'appendix': return 'appendix';
    case 'theorem': return 'theorem';
    case 'item': return 'item';
    case 'listing': case 'algorithm': return 'listing';
    default: return l.kind && HEADING_KINDS.has(l.kind) ? 'section' : 'other';
  }
}

export function groupIndex(g: RefGroup): number {
  return GROUPS.findIndex((x) => x.id === g);
}

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Hypothesis" → "Hypotheses", "Property" → "Properties", "Lemma" → "Lemmas". */
export function plural(word: string): string {
  if (/is$/i.test(word)) return word.replace(/is$/i, 'es');
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, 'ies');
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

/** The printed name of a label's kind ("Figure", "Section", a theorem's printed name), or null for kinds referenced bare (equations, items, footnotes, other). */
export function kindName(l: Pick<LabelDetail, 'kind' | 'env' | 'envTitle'>): { one: string; many: string } | null {
  const pair = (one: string, many?: string) => ({ one, many: many ?? plural(one) });
  switch (l.kind) {
    case 'figure': case 'subfigure': return pair('Figure');
    case 'table': case 'subtable': return pair('Table');
    case 'listing': return pair('Listing');
    case 'algorithm': return pair('Algorithm');
    case 'part': return pair('Part');
    case 'chapter': return pair('Chapter');
    case 'appendix': return pair('Appendix', 'Appendices');
    case 'theorem': {
      const name = (l.envTitle || (l.env ? capitalised(l.env.replace(/\*$/, '')) : '')).trim();
      return name ? pair(name) : null;
    }
    default: return l.kind && HEADING_KINDS.has(l.kind) ? pair('Section') : null;
  }
}

/** The kind as a short word for the picker's rows ("Figure", "Equation", "Item"). */
export function kindLabel(l: Pick<LabelDetail, 'kind' | 'env' | 'envTitle'>): string {
  const n = kindName(l);
  if (n) return n.one;
  switch (l.kind) {
    case 'equation': return 'Equation';
    case 'item': return 'Item';
    case 'footnote': return 'Footnote';
    default: return 'Label';
  }
}

/** Words that already name a kind when they precede the caret (lower case, no final dot). */
const NAME_WORDS: Record<string, readonly string[]> = {
  Figure: ['figure', 'figures', 'fig', 'figs'],
  Table: ['table', 'tables', 'tab', 'tabs'],
  Section: ['section', 'sections', 'sec', 'secs', 'subsection', 'subsections'],
  Chapter: ['chapter', 'chapters', 'chap', 'ch'],
  Appendix: ['appendix', 'appendices', 'app'],
  Part: ['part', 'parts'],
  Listing: ['listing', 'listings', 'lst'],
  Algorithm: ['algorithm', 'algorithms', 'alg'],
  Equation: ['equation', 'equations', 'eq', 'eqs', 'eqn', 'eqns'],
};

function namesKind(word: string, l: Pick<LabelDetail, 'kind' | 'env' | 'envTitle'>): boolean {
  const w = word.toLowerCase().replace(/\.$/, '');
  const key = kindLabel(l);
  const words = NAME_WORDS[key] ?? [key.toLowerCase(), plural(key).toLowerCase()];
  return words.includes(w);
}

/**
 * The kind name the text before the caret ends with, for the first label:
 * `{ from, sep }` where `from` is the offset (in `before`) where the
 * separator starts and `sep` the separator itself ("", " ", "~"). Null when
 * the text does not name the label's kind.
 */
export function nameBefore(before: string, l: Pick<LabelDetail, 'kind' | 'env' | 'envTitle'>): { from: number; sep: string } | null {
  const m = /(?:^|[^\p{L}\\])(\p{L}+\.?)([ \t]|~)?$/u.exec(before);
  if (!m || !namesKind(m[1], l)) return null;
  const sep = m[2] ?? '';
  return { from: before.length - sep.length, sep };
}

export type RefStyle = 'auto' | 'cref' | 'Cref' | 'name' | 'ref' | 'autoref' | 'pageref' | 'nameref' | 'eqref' | 'vref';

export const STYLE_LABELS: Record<RefStyle, string> = {
  auto: 'Automatic',
  cref: '\\cref',
  Cref: '\\Cref',
  name: 'Figure~\\ref',
  ref: '\\ref',
  autoref: '\\autoref',
  pageref: 'page~\\pageref',
  nameref: '\\nameref',
  eqref: '\\eqref',
  vref: '\\vref',
};

/** Why a style is not offered for this document, or null when it is. */
export function styleProblem(style: RefStyle, setup: RefSetup): string | null {
  switch (style) {
    case 'cref': case 'Cref': return setup.cleveref ? null : 'Needs the cleveref package';
    case 'autoref': return setup.hyperref ? null : 'Needs the hyperref package';
    case 'nameref': return setup.nameref || setup.hyperref ? null : 'Needs the nameref or hyperref package';
    case 'eqref': return setup.amsmath ? null : 'Needs amsmath or mathtools';
    case 'vref': return setup.varioref ? null : 'Needs the varioref package';
    default: return null;
  }
}

/** The setup read from one file's preamble, for before the server answers. */
export function detectSetupIn(text: string): RefSetup {
  const preamble = text.split(/\\begin\s*\{document\}/)[0].replace(/(^|[^\\])%[^\n]*/g, '$1');
  const cls = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(preamble)?.[1].trim() ?? null;
  const pkgs = new Map<string, string>();
  for (const m of preamble.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g)) {
    for (const p of m[2].split(',')) pkgs.set(p.trim(), m[1] ?? '');
  }
  const has = (p: string) => pkgs.has(p);
  return {
    documentClass: cls,
    cleveref: has('cleveref'),
    cleverefCapitalise: /\bcapitali[sz]e\b/.test(pkgs.get('cleveref') ?? ''),
    hyperref: has('hyperref'),
    amsmath: has('amsmath') || has('mathtools') || has('empheq') || /^ams(art|book|proc)$/.test(cls ?? ''),
    varioref: has('varioref'),
    nameref: has('nameref') || has('hyperref'),
  };
}

/** The setup out of WP15's cite-setup answer (its wire fields; the citations client type names only some). */
export function refSetupOf(server: Record<string, unknown> | null | undefined): RefSetup | null {
  if (!server || typeof server !== 'object') return null;
  const b = (k: string) => server[k] === true;
  return {
    documentClass: typeof server.documentClass === 'string' ? server.documentClass : null,
    cleveref: b('cleveref'),
    cleverefCapitalise: b('cleverefCapitalise'),
    hyperref: b('hyperref'),
    amsmath: b('amsmath'),
    varioref: b('varioref'),
    nameref: b('nameref'),
  };
}

/** The header note: what the document loads that matters here. */
export function setupNote(setup: RefSetup | null): string {
  if (!setup) return '';
  const parts: string[] = [];
  if (setup.cleveref) parts.push('cleveref');
  if (setup.hyperref) parts.push('hyperref');
  if (setup.varioref) parts.push('varioref');
  if (setup.amsmath) parts.push('amsmath');
  if (setup.documentClass === 'apa7') parts.push('APA');
  return parts.length ? parts.join(' · ') : 'plain \\ref';
}

/** APA joining: "a", "a and~b", "a, b, and~c". */
export function joinRefs(refs: readonly string[]): string {
  if (refs.length <= 1) return refs[0] ?? '';
  if (refs.length === 2) return `${refs[0]} and~${refs[1]}`;
  return `${refs.slice(0, -1).join(', ')}, and~${refs[refs.length - 1]}`;
}

/** Joins whole phrases ("Figure~\ref{a}", "Table~\ref{b}") with plain spaces. */
function joinPhrases(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

export interface BuildOptions {
  style: RefStyle;
  setup: RefSetup;
  /** The caret starts a sentence: `\Cref`, "Page". */
  sentenceStart?: boolean;
  /** The "capitalise at the start of a sentence" setting. */
  capitalise?: boolean;
  /** The text before the caret already names the first label's kind: leave the name out. */
  named?: boolean;
}

/** The phrase for one or more labels in the "Figure~\ref" form. */
function namedForm(labels: readonly LabelDetail[], setup: RefSetup, named: boolean): string {
  const runs: { key: string; labels: LabelDetail[] }[] = [];
  for (const l of labels) {
    const key = l.kind === 'equation' ? '=eq' : kindName(l)?.one ?? '=bare';
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.labels.push(l);
    else runs.push({ key, labels: [l] });
  }
  const phrases = runs.map((run, i) => {
    if (run.key === '=eq') return joinRefs(run.labels.map((l) => (setup.amsmath ? `\\eqref{${l.label}}` : `(\\ref{${l.label}})`)));
    const refs = joinRefs(run.labels.map((l) => `\\ref{${l.label}}`));
    if (run.key === '=bare' || (i === 0 && named)) return refs;
    const n = kindName(run.labels[0])!;
    return `${run.labels.length > 1 ? n.many : n.one}~${refs}`;
  });
  return joinPhrases(phrases);
}

/** The reference text for `labels` in `style`. */
export function buildReference(labels: readonly LabelDetail[], o: BuildOptions): string {
  if (!labels.length) return '';
  const keys = labels.map((l) => l.label);
  const each = (cmd: string) => joinRefs(keys.map((k) => `\\${cmd}{${k}}`));
  switch (o.style) {
    case 'cref': return `\\cref{${keys.join(',')}}`;
    case 'Cref': return `\\Cref{${keys.join(',')}}`;
    case 'ref': return each('ref');
    case 'autoref': return each('autoref');
    case 'nameref': return each('nameref');
    case 'eqref': return each('eqref');
    case 'vref': return each('vref');
    case 'pageref': {
      const word = keys.length > 1 ? 'pages' : 'page';
      return `${o.sentenceStart ? capitalised(word) : word}~${each('pageref')}`;
    }
    case 'name': return namedForm(labels, o.setup, !!o.named);
    case 'auto':
    default: {
      if (o.setup.cleveref && !o.named) {
        const big = o.setup.documentClass === 'apa7' || (o.capitalise !== false && !!o.sentenceStart);
        return `\\${big ? 'Cref' : 'cref'}{${keys.join(',')}}`;
      }
      return namedForm(labels, o.setup, !!o.named);
    }
  }
}

/** The styles the picker shows for this document: every style it can use, plus the one chosen in settings. */
export function stylesFor(setup: RefSetup, chosen: RefStyle = 'auto'): RefStyle[] {
  const all: RefStyle[] = ['auto', 'cref', 'Cref', 'name', 'ref', 'autoref', 'pageref', 'nameref', 'eqref', 'vref'];
  return all.filter((s) => s === chosen || !styleProblem(s, setup));
}

/** Folds case and accents, for searching. */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * The labels matching `query` (every word must match the label, its title,
 * its file or its kind), best first; with no query, in group order and then
 * file order. `group` keeps one group only.
 */
export function rankLabels(labels: readonly LabelDetail[], query: string, group: RefGroup | null = null): LabelDetail[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const scored: { l: LabelDetail; score: number; g: number; i: number }[] = [];
  labels.forEach((l, i) => {
    const g = groupOf(l);
    if (group && g !== group) return;
    let score = 0;
    if (words.length) {
      const key = fold(l.label);
      const title = fold(l.title ?? '');
      const hay = `${key} ${title} ${fold(l.file)} ${fold(kindLabel(l))}`;
      for (const w of words) {
        if (!hay.includes(w)) return;
        if (key.startsWith(w) || key.includes(`:${w}`)) score += 3;
        else if (new RegExp(`(?:^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(title)) score += 2;
        else score += 1;
      }
    }
    scored.push({ l, score, g: groupIndex(g), i });
  });
  scored.sort((a, b) => b.score - a.score || a.g - b.g || a.i - b.i);
  return scored.map((s) => s.l);
}
