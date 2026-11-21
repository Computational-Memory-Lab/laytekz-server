import type { AnySettingDef } from '../../settings/types';

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const oneOf = <T extends string>(values: readonly T[]) => (v: unknown): v is T => typeof v === 'string' && (values as readonly string[]).includes(v);

/** The ids, for the feature and its tests. */
export const CITATION_SETTINGS = {
  family: 'citations.family',
  enter: 'citations.enter',
  capitalise: 'citations.capitalise',
  spacing: 'citations.spacing',
  panels: 'citations.panels',
} as const;

export const FAMILY_CHOICES = ['auto', 'biblatex', 'natbib', 'apacite', 'bibtex'] as const;
export type FamilyChoice = typeof FAMILY_CHOICES[number];
export const ENTER_CHOICES = ['parenthetical', 'narrative'] as const;
export type EnterChoice = typeof ENTER_CHOICES[number];

/**
 * The 'citations.*' settings (WP19). Pure data: import types only, never the
 * store or UI code. The picker only writes when the person presses Enter;
 * the one automatic change is which command the Cite and Zotero panels
 * insert, so it is a switch listed under "Automatic changes".
 */
export const settings: readonly AnySettingDef[] = [
  {
    id: CITATION_SETTINGS.family,
    section: 'citations',
    label: 'Citation commands',
    hint: 'Automatic reads the document: biblatex gives \\parencite and \\textcite, natbib gives \\citep and \\citet, apacite gives \\cite and \\citeA, plain BibTeX gives \\cite.',
    keywords: 'cite citation biblatex natbib apacite bibtex parencite textcite citep citet command package',
    scope: 'account',
    default: 'auto',
    validate: oneOf(FAMILY_CHOICES),
    control: {
      kind: 'select',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'biblatex', label: 'biblatex' },
        { value: 'natbib', label: 'natbib' },
        { value: 'apacite', label: 'apacite' },
        { value: 'bibtex', label: 'Plain \\cite' },
      ],
    },
    order: 10,
  },
  {
    id: CITATION_SETTINGS.enter,
    section: 'citations',
    label: 'Enter in the citation picker inserts',
    hint: 'Shift+Enter inserts the other kind.',
    keywords: 'cite citation picker enter parenthetical narrative in-text textcite parencite',
    scope: 'account',
    default: 'parenthetical',
    validate: oneOf(ENTER_CHOICES),
    control: { kind: 'segmented', options: [{ value: 'parenthetical', label: 'Parenthetical' }, { value: 'narrative', label: 'Narrative' }] },
    order: 20,
  },
  {
    id: CITATION_SETTINGS.capitalise,
    section: 'citations',
    label: 'Capitalise narrative citations that start a sentence',
    hint: 'Writes \\Textcite or \\Citet when the citation is the first word of a sentence.',
    keywords: 'cite citation capital Textcite Citet sentence start',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    order: 30,
  },
  {
    id: CITATION_SETTINGS.spacing,
    section: 'citations',
    label: 'Add a space before a citation that follows a word',
    hint: 'Applies to the citation picker only.',
    keywords: 'cite citation space spacing tidy',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    order: 40,
  },
  {
    id: CITATION_SETTINGS.panels,
    section: 'citations',
    label: 'Cite panels use the document’s citation command',
    hint: 'The Cite and Zotero panels insert \\parencite or \\citep when the document uses biblatex or natbib. Off: they insert \\cite, as before.',
    keywords: 'cite citation zotero references panel plugin insertCitation parencite',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    order: 50,
    palette: true,
  },
];
