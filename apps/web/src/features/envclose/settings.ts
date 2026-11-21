import type { AnySettingDef } from '../../settings/types';

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** The ids, for the feature and its tests. */
export const ENVCLOSE_SETTINGS = {
  close: 'envclose.close',
  linked: 'envclose.linked',
  tabStops: 'envclose.tabStops',
} as const;

/**
 * The 'envclose.*' settings (WP31). Pure data: import types only, never the
 * store or UI code. Closing environments is not marked `automatic`: Version 1
 * always closed them, and the legacy specs (13 "closes it once") type
 * against that with the automatic changes off. Its switch still turns every
 * closing path off.
 */
export const settings: readonly AnySettingDef[] = [
  {
    id: ENVCLOSE_SETTINGS.close,
    section: 'typing',
    label: 'Add \\end{…} after \\begin{…}',
    hint: 'Typing the } of \\begin{itemize}, pressing Enter at the end of a \\begin line or choosing an environment from the list adds its \\end line, unless one is there already. Undo, or Backspace right after, takes it away.',
    keywords: 'auto close environment begin end itemize',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    order: 20,
    palette: true,
  },
  {
    id: ENVCLOSE_SETTINGS.linked,
    section: 'typing',
    label: 'Rename \\begin and \\end together',
    hint: 'Changing the name in \\begin{…} or \\end{…} changes its partner too, in the same undo step. The partner is outlined while the caret is in a name.',
    keywords: 'linked rename environment begin end mirror',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    order: 21,
    palette: true,
  },
  {
    id: ENVCLOSE_SETTINGS.tabStops,
    section: 'typing',
    label: 'Tab moves to the next argument',
    hint: 'After you choose \\frac, \\href or another command with several arguments from the list, Tab goes to its next pair of braces and then past the last one.',
    keywords: 'tab stops snippet fields arguments completion',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    order: 22,
  },
];
