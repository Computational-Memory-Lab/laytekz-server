import type { AnySettingDef } from '../../settings/types';

/** The 'automath.*' settings (WP11). Pure data: import types only, never the store or UI code. */

export const AUTO_MATH_SETTING_IDS = {
  wrap: 'automath.wrap',
  identifiers: 'automath.identifiers',
  delimiter: 'automath.delimiter',
  tabOut: 'automath.tabOut',
} as const;

export type DelimiterChoice = 'auto' | 'dollar' | 'paren';
export const DELIMITER_CHOICES: readonly DelimiterChoice[] = ['auto', 'dollar', 'paren'];

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isDelimiter = (v: unknown): v is DelimiterChoice => (DELIMITER_CHOICES as readonly unknown[]).includes(v);

export const settings: readonly AnySettingDef[] = [
  {
    id: AUTO_MATH_SETTING_IDS.wrap,
    section: 'math',
    label: 'Put math in math mode as you type',
    hint: 'When you finish a word, x_i becomes $x_i$, x^10 becomes $x^{10}$ and p < .05 becomes $p < .05$. Backspace right after undoes it',
    keywords: 'automatic math mode dollar formula wrap detect inline',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    palette: true,
    order: 10,
  },
  {
    id: AUTO_MATH_SETTING_IDS.identifiers,
    section: 'math',
    label: 'Escape underscores in names',
    hint: 'When you finish a word, my_var becomes my\\_var. Backspace right after undoes it',
    keywords: 'underscore escape identifier variable file name',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    order: 20,
  },
  {
    id: AUTO_MATH_SETTING_IDS.delimiter,
    section: 'math',
    label: 'Inline math delimiters',
    hint: (v: DelimiterChoice) => (v === 'auto' ? 'Uses whichever of $…$ and \\(…\\) the file uses more' : v === 'paren' ? 'Automatic math uses \\(…\\)' : 'Automatic math uses $…$'),
    keywords: 'dollar parenthesis delimiter automatic math',
    scope: 'account',
    default: 'auto',
    validate: isDelimiter,
    control: { kind: 'select', options: [
      { value: 'auto', label: 'Match the file' },
      { value: 'dollar', label: '$…$' },
      { value: 'paren', label: '\\(…\\)' },
    ] },
    dependsOn: AUTO_MATH_SETTING_IDS.wrap,
    order: 30,
  },
  {
    id: AUTO_MATH_SETTING_IDS.tabOut,
    section: 'math',
    label: 'Tab leaves inline math',
    hint: 'With the caret right before a closing $ or \\), Tab moves past it',
    keywords: 'tab out exit leave math dollar',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    order: 40,
  },
];
