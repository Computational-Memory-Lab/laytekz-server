import type { AnySettingDef } from '../../settings/types';

/**
 * The 'references.*' settings (WP22). Pure data: import types only, never the store or UI code.
 *
 * The four per-person switches steer the References panel and the "Search
 * online for …" item in \cite completion. The four project settings are read
 * by the server (WP16) from `ProjectMeta.ext`, so co-authors get the same keys
 * and field names.
 */
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const oneOf = <T extends string>(...values: T[]) => (v: unknown): v is T => typeof v === 'string' && (values as string[]).includes(v);
const KEYWORDS = 'references bibliography bibtex bib citation cite doi arxiv pubmed isbn scholar crossref openalex lookup';

export const REFERENCES_SETTING = {
  online: 'references.online',
  preview: 'references.preview',
  citeAtCursor: 'references.citeAtCursor',
  completionSearch: 'references.completionSearch',
  keyStyle: 'references.keyStyle',
  defaultBib: 'references.defaultBib',
  protectCaps: 'references.protectCaps',
  fieldStyle: 'references.fieldStyle',
} as const;

export const settings: readonly AnySettingDef[] = [
  {
    id: REFERENCES_SETTING.online,
    section: 'references',
    label: 'Look up references online',
    hint: 'The References panel searches Crossref, OpenAlex and other public catalogues for what you type. Off: you can still paste BibTeX to add it.',
    keywords: KEYWORDS,
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    order: 10,
    palette: true,
  },
  {
    id: REFERENCES_SETTING.preview,
    section: 'references',
    label: 'Preview before adding',
    hint: 'Shows the entry, its key and the .bib it goes to before anything is written. Off: choosing a paper adds it at once.',
    keywords: `${KEYWORDS} preview confirm`,
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    order: 11,
  },
  {
    id: REFERENCES_SETTING.citeAtCursor,
    section: 'references',
    label: 'Cite at the cursor after adding',
    hint: 'Adding a reference also puts \\cite{key} at the cursor of the open .tex file. One undo takes it back.',
    keywords: `${KEYWORDS} insert cursor`,
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    order: 12,
  },
  {
    id: REFERENCES_SETTING.completionSearch,
    section: 'references',
    label: 'Offer “Search online” in citation suggestions',
    hint: 'While you type a key inside \\cite{…}, the last suggestion opens the References panel with what you typed. Nothing is looked up until you choose it.',
    keywords: `${KEYWORDS} completion autocomplete suggestion`,
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    dependsOn: REFERENCES_SETTING.online,
    order: 13,
  },
  {
    id: REFERENCES_SETTING.keyStyle,
    section: 'references',
    label: 'Citation key style',
    hint: 'How the key of a newly added reference is made. A pasted entry keeps its own key.',
    keywords: `${KEYWORDS} key style`,
    scope: 'project',
    default: 'authoryear',
    validate: oneOf('authoryear', 'scholar', 'bbt'),
    control: {
      kind: 'select',
      options: [
        { value: 'authoryear', label: 'Author and year (vaswani2017)' },
        { value: 'scholar', label: 'Like Google Scholar (vaswani2017attention)' },
        { value: 'bbt', label: 'Like Better BibTeX (vaswaniAttentionAllYou2017)' },
      ],
    },
    order: 20,
  },
  {
    id: REFERENCES_SETTING.defaultBib,
    section: 'references',
    label: 'New references go to',
    hint: 'A .bib path such as refs/extra.bib. Empty: the first .bib the paper loads, otherwise references.bib beside the main file.',
    keywords: `${KEYWORDS} default file target`,
    scope: 'project',
    default: '',
    validate: (v: unknown): v is string => typeof v === 'string' && v.length <= 300 && (v === '' || /\.bib$/i.test(v.trim())),
    control: { kind: 'text' },
    order: 21,
  },
  {
    id: REFERENCES_SETTING.protectCaps,
    section: 'references',
    label: 'Protect capitals in titles',
    hint: 'Puts braces around words such as {BERT} and {ImageNet}, so bibliography styles do not lowercase them.',
    keywords: `${KEYWORDS} capitals case braces title`,
    scope: 'project',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    order: 22,
  },
  {
    id: REFERENCES_SETTING.fieldStyle,
    section: 'references',
    label: 'Field names',
    hint: 'biblatex papers read journaltitle and date; BibTeX papers read journal and year.',
    keywords: `${KEYWORDS} biblatex fields journal journaltitle`,
    scope: 'project',
    default: 'auto',
    validate: oneOf('auto', 'biblatex', 'bibtex'),
    control: {
      kind: 'select',
      options: [
        { value: 'auto', label: 'Follow the paper' },
        { value: 'biblatex', label: 'biblatex (journaltitle, date)' },
        { value: 'bibtex', label: 'BibTeX (journal, year)' },
      ],
    },
    order: 23,
  },
];
