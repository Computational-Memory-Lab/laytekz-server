import type { AnySettingDef } from '../../settings/types';

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** The ids, for the feature and its tests. */
export const PAIRS_SETTINGS = {
  brackets: 'pairs.brackets',
  math: 'pairs.math',
  quotes: 'pairs.quotes',
  tabOut: 'pairs.tabOut',
  currency: 'pairs.currency',
} as const;

/**
 * The 'pairs.*' settings (WP12). Pure data: import types only, never the
 * store or UI code. Every switch is an automatic change (on by default, off
 * under the legacy specs' 'automatic-off'); turned off, typing is exactly
 * what it was before Laytekz 2.
 */
export const settings: readonly AnySettingDef[] = [
  {
    id: PAIRS_SETTINGS.brackets,
    section: 'typing',
    label: 'Close brackets in more places',
    hint: 'Closes ( [ { before punctuation, $ and \\ too, and steps over a brace a completion added, so \\textbf{old} never gets a second }.',
    keywords: 'auto close brackets braces parentheses pair overtype',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    order: 10,
    palette: true,
  },
  {
    id: PAIRS_SETTINGS.math,
    section: 'typing',
    label: 'Close math as you type',
    hint: 'Typing $ gives $…$ and a second $ gives $$…$$. \\( and \\[ get \\) and \\]. In math, \\{ gets \\} and \\left( gets \\right).',
    keywords: 'auto close dollar math delimiters left right pair',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    order: 11,
    palette: true,
  },
  {
    id: PAIRS_SETTINGS.quotes,
    section: 'typing',
    label: 'Close quotes as you type',
    hint: "Typing ` gives `…' and typing `` gives ``…''. Straight quotes are left alone.",
    keywords: 'auto close quotes backtick apostrophe pair',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    order: 12,
  },
  {
    id: PAIRS_SETTINGS.tabOut,
    section: 'typing',
    label: 'Tab steps past a closing bracket',
    hint: 'When the caret is just before a closer the editor added, Tab moves past it instead of indenting.',
    keywords: 'tab out step over closer bracket brace',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    order: 13,
  },
  {
    id: PAIRS_SETTINGS.currency,
    section: 'typing',
    label: 'Write dollar amounts as \\$',
    hint: 'Typing $5 and a space gives \\$5, so a price never starts a formula. Backspace right after undoes it.',
    keywords: 'currency dollar price escape money',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    order: 14,
  },
];
