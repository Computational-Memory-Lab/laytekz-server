import type { AnySettingDef } from '../../settings/types';
import { BUILD_AUX_SETTING, LIST_SETTING } from './ids';

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** The 'outputs.*' settings (WP34). Pure data: import types only, never the store or UI code. */
export const settings: readonly AnySettingDef[] = [
  {
    id: LIST_SETTING,
    section: 'files',
    label: 'Show the files each typeset generates',
    hint: 'A list under the file tree of what the last typeset wrote (the .bbl, the log, the index), to view, download or add to the project.',
    keywords: 'generated files bbl log aux output arxiv extra files',
    scope: 'device',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    palette: true,
    order: 10,
  },
  {
    id: BUILD_AUX_SETTING,
    section: 'files',
    label: 'Build glossaries, acronyms and nomenclature when typesetting',
    hint: 'Runs makeindex for glossaries, acronyms and nomenclature in every full typeset, so their lists are never empty. Shared with everyone on the project.',
    keywords: 'glossary glossaries acronym nomenclature makeindex extra files gls acr nls',
    scope: 'project',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    order: 20,
  },
];
