import type { AnySettingDef } from '../../settings/types';

/** The 'rename.*' settings (WP29). Pure data: import types only, never the store or UI code. */
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const KEYWORDS = 'rename move file folder references input include bibliography main document';

export type ReferencesMode = 'ask' | 'always' | 'never';
const MODES: readonly ReferencesMode[] = ['ask', 'always', 'never'];

export const settings: readonly AnySettingDef[] = [
  {
    id: 'rename.references',
    section: 'files',
    label: 'When I rename a file',
    hint: (v: ReferencesMode) => v === 'never'
      ? 'Only the file is renamed. When other files still use the old name, the notification offers to update them.'
      : v === 'always'
        ? 'Laytekz renames the file and updates \\input, \\includegraphics, \\bibliography and other references to it without asking. Undo in the notification puts everything back.'
        : 'When other files refer to it, Laytekz shows what would change and asks first. A rename nothing else refers to happens straight away.',
    keywords: KEYWORDS,
    scope: 'account',
    default: 'ask',
    validate: (v: unknown): v is ReferencesMode => typeof v === 'string' && (MODES as readonly string[]).includes(v),
    control: {
      kind: 'segmented',
      options: [
        { value: 'ask', label: 'Ask before updating references' },
        { value: 'always', label: 'Update references without asking' },
        { value: 'never', label: 'Never update references' },
      ],
    },
    order: 10,
  },
  {
    id: 'rename.siblings',
    section: 'files',
    label: 'Offer to rename files that share the main document\'s name',
    hint: 'Renaming paper.tex also offers paper.bib, paper.sty and the other files beside it with the same name.',
    keywords: `${KEYWORDS} sibling same name bib sty`,
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    order: 11,
  },
  {
    id: 'rename.title',
    section: 'files',
    label: 'Offer to update the document title when I rename a project',
    hint: 'When the main document\'s \\title is still the old project name, renaming the project asks whether to change the title too.',
    keywords: 'rename project title name pdftitle',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    // It interrupts a rename with a question, so it is listed with the other
    // automatic behaviours (and is off in the legacy specs' test defaults).
    automatic: true,
    order: 12,
    palette: true,
  },
];
