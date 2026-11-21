import type { AnySettingDef, SettingDef } from '../../settings/types';

/** The 'mathPreview.*' settings (WP13; the PDF layer's switch is for WP21). Pure data: import types only, never the store or UI code. */

export type PreviewSizeChoice = 'small' | 'medium' | 'large';
export type PreviewBackground = 'paper' | 'theme';
export const PREVIEW_DELAYS = [150, 350, 700] as const;
export type PreviewDelay = (typeof PREVIEW_DELAYS)[number];

export const MATH_PREVIEW_SETTING_IDS = {
  hover: 'mathPreview.hover',
  caret: 'mathPreview.caret',
  delay: 'mathPreview.delay',
  size: 'mathPreview.size',
  background: 'mathPreview.background',
  pdf: 'mathPreview.pdf',
} as const;

const ids = MATH_PREVIEW_SETTING_IDS;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const oneOf = <T extends string | number>(values: readonly T[]) => (v: unknown): v is T => values.includes(v as T);

const hover: SettingDef<boolean> = {
  id: ids.hover, section: 'math', label: 'Preview formulas on hover',
  hint: 'Hold the pointer over math in the source to see it drawn. Nothing in the file changes.',
  keywords: 'math formula equation preview hover katex tooltip render',
  scope: 'account', default: true, validate: isBool, control: { kind: 'switch' }, palette: true, order: 200,
};

const caret: SettingDef<boolean> = {
  id: ids.caret, section: 'math', label: 'Also preview while the cursor is in a formula',
  hint: 'The preview follows your typing. Esc hides it until the cursor leaves the formula.',
  keywords: 'math formula live preview cursor caret keyboard',
  scope: 'account', default: false, validate: isBool, control: { kind: 'switch' }, dependsOn: ids.hover, order: 210,
};

const delay: SettingDef<PreviewDelay> = {
  id: ids.delay, section: 'math', label: 'Hover delay',
  keywords: 'math formula preview hover wait time',
  scope: 'account', default: 350, validate: oneOf(PREVIEW_DELAYS),
  control: { kind: 'segmented', options: [{ value: 150, label: 'Short' }, { value: 350, label: 'Normal' }, { value: 700, label: 'Long' }] },
  dependsOn: ids.hover, order: 220,
};

const size: SettingDef<PreviewSizeChoice> = {
  id: ids.size, section: 'math', label: 'Preview size',
  hint: 'Small is about the size the formula has on the page.',
  keywords: 'math formula preview zoom scale bigger smaller',
  scope: 'account', default: 'medium', validate: oneOf(['small', 'medium', 'large'] as const),
  control: { kind: 'segmented', options: [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }] },
  dependsOn: ids.hover, order: 230,
};

const background: SettingDef<PreviewBackground> = {
  id: ids.background, section: 'math', label: 'Preview background',
  hint: (v) => (v === 'paper' ? 'Black on white, like the typeset page.' : 'The colours of the current theme.'),
  keywords: 'math formula preview dark light colour color paper white',
  scope: 'account', default: 'paper', validate: oneOf(['paper', 'theme'] as const),
  control: { kind: 'segmented', options: [{ value: 'paper', label: 'As on paper' }, { value: 'theme', label: 'Match the theme' }] },
  dependsOn: ids.hover, order: 240,
};

/** The PDF layer (WP21). */
const pdf: SettingDef<boolean> = {
  id: ids.pdf, section: 'math', label: 'Show the typeset PDF when the formula has not changed',
  hint: 'Display formulas show the typeset page itself, cropped, until you edit them. Typeset again to update.',
  keywords: 'math formula preview pdf synctex exact typeset',
  scope: 'account', default: true, validate: isBool, control: { kind: 'switch' }, dependsOn: ids.hover, order: 250,
};

export const settings: readonly AnySettingDef[] = [hover, caret, delay, size, background, pdf];
