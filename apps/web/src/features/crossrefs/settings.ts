import type { AnySettingDef } from '../../settings/types';

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const oneOf = <T extends string>(values: readonly T[]) => (v: unknown): v is T => typeof v === 'string' && (values as readonly string[]).includes(v);

/** The ids, for the feature and its tests. */
export const CROSSREF_SETTINGS = {
  command: 'crossrefs.command',
  capitalise: 'crossrefs.capitalise',
  spacing: 'crossrefs.spacing',
  suggest: 'crossrefs.suggestLabel',
} as const;

export const COMMAND_CHOICES = ['auto', 'cref', 'Cref', 'autoref', 'name', 'ref'] as const;
export type CommandChoice = typeof COMMAND_CHOICES[number];

/**
 * The 'crossrefs.*' settings (WP26). Pure data: import types only, never the
 * store or UI code. The picker and "Insert label here" only write when the
 * person asks; the one automatic behaviour is the suggested name offered when
 * `\label{` is typed, so it is a switch listed under "Automatic changes".
 */
export const settings: readonly AnySettingDef[] = [
  {
    id: CROSSREF_SETTINGS.command,
    section: 'citations',
    label: 'Cross-reference command',
    hint: 'Automatic writes \\cref when the document loads cleveref (\\Cref under the apa7 class), else Figure~\\ref, Table~\\ref and so on.',
    keywords: 'cross-reference ref cref Cref autoref figure table label picker command',
    scope: 'account',
    default: 'auto',
    validate: oneOf(COMMAND_CHOICES),
    control: {
      kind: 'select',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'cref', label: '\\cref' },
        { value: 'Cref', label: '\\Cref' },
        { value: 'autoref', label: '\\autoref' },
        { value: 'name', label: 'Figure~\\ref' },
        { value: 'ref', label: 'Bare \\ref' },
      ],
    },
    order: 110,
  },
  {
    id: CROSSREF_SETTINGS.capitalise,
    section: 'citations',
    label: 'Capitalise cross-references that start a sentence',
    hint: 'Writes \\Cref when the reference is the first word of a sentence.',
    keywords: 'cross-reference Cref capital sentence start',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    order: 120,
  },
  {
    id: CROSSREF_SETTINGS.spacing,
    section: 'citations',
    label: 'Tidy spacing around inserted cross-references',
    hint: 'Adds a space after a word, and turns the space in “Figure \\ref” into a tie: Figure~\\ref.',
    keywords: 'cross-reference space spacing tie tilde figure',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    order: 130,
  },
  {
    id: CROSSREF_SETTINGS.suggest,
    section: 'citations',
    label: 'Suggest a label name when you type \\label{',
    hint: 'Offers a name from the caption or heading, such as fig:mean-reaction-times. Nothing is written until you accept it.',
    keywords: 'label suggest name completion fig tab sec caption',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    order: 140,
    palette: true,
  },
];
