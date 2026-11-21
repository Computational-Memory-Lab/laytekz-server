import type { AnySettingDef, SettingDef, SettingsEnv } from '../types';
import { CORE_SETTING_IDS } from '../types';
import {
  APPEARANCE_VALUES, appearanceCodec, editorModeCodec, isShortcutOverrides, layoutCodec, offUnless1, onUnless0,
  pdfZoomCodec, shortcutsCodec, spellLangCodec, type Appearance, type PaneLayout, type ShortcutOverrides,
} from '../codecs';

/**
 * The core settings (WP02 settings-core): the existing preferences on their
 * legacy keys and codecs, appearance, typography, `typing.explain` and
 * `editor.contextMenu`. Pure data. The editor's own rows (gutters, indent,
 * wrap, suggestions) are in editor/core/editorSettingDefs.ts (WP05).
 *
 * Every V1 key keeps its exact V1 reading (settings/codecs.ts) and is
 * written only when the person changes the value; nothing is migrated.
 * New settings use the default key `aldine.<id>` with JSON text.
 */

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const oneOf = <T extends string | number>(values: readonly T[]) => (v: unknown): v is T => (values as readonly unknown[]).includes(v);
const inRange = (min: number, max: number) => (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const switchControl = { kind: 'switch' } as const;
const signedInWithAccounts = (env: SettingsEnv) => env.accounts && env.signedIn;
const never = () => false;

/** editor/spellcheck.ts SPELL_LANGS, repeated so the registry loads no
 *  CodeMirror; settings/__tests__/registry.test.ts keeps the two equal. */
export const SPELL_LANG_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Browser default' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'de-DE', label: 'German' },
  { value: 'fr-FR', label: 'French' },
  { value: 'es-ES', label: 'Spanish' },
  { value: 'it-IT', label: 'Italian' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'pt-PT', label: 'Portuguese (Portugal)' },
  { value: 'nl-NL', label: 'Dutch' },
  { value: 'sv-SE', label: 'Swedish' },
  { value: 'da-DK', label: 'Danish' },
  { value: 'nb-NO', label: 'Norwegian' },
  { value: 'fi-FI', label: 'Finnish' },
  { value: 'pl-PL', label: 'Polish' },
  { value: 'cs-CZ', label: 'Czech' },
  { value: 'tr-TR', label: 'Turkish' },
  { value: 'ru-RU', label: 'Russian' },
];
const spellLangKnown = (tag: string) => tag !== '' && SPELL_LANG_OPTIONS.some((l) => l.value === tag);

/** Interface text sizes, in percent of the browser's own text size. index.html's pre-paint accepts exactly these. */
export const UI_SCALES = [90, 100, 110, 125] as const;
export type UiScale = typeof UI_SCALES[number];

/** Editor fonts offered by name; none is bundled, so one that is not installed falls back to the system monospace font. */
export const EDITOR_FONTS: readonly { value: string; label: string }[] = [
  { value: '', label: 'System monospace' },
  { value: 'Menlo', label: 'Menlo' },
  { value: 'SF Mono', label: 'SF Mono' },
  { value: 'Consolas', label: 'Consolas' },
  { value: 'Cascadia Code', label: 'Cascadia Code' },
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
  { value: 'Fira Code', label: 'Fira Code' },
  { value: 'Source Code Pro', label: 'Source Code Pro' },
  { value: 'Courier New', label: 'Courier New' },
];
/** A font family name safe to put in CSS unescaped: letters, digits, spaces, '-' and '_'; '' is the default. */
export const isFontName = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && /^[A-Za-z0-9 _-]*$/.test(v) && v.trim() === v;

export type ContrastChoice = 'system' | 'more';
export type MotionChoice = 'system' | 'reduce';
export type PdfDark = 'paper' | 'dim' | 'invert';
export type VisualWidth = 'readable' | 'full';

const ids = CORE_SETTING_IDS;

const theme: SettingDef<Appearance> = {
  id: ids.theme, section: 'appearance', label: 'Theme', keywords: 'appearance dark light mode colour color',
  scope: 'account', default: 'system', validate: oneOf(APPEARANCE_VALUES), key: 'aldine.theme', codec: appearanceCodec,
  control: { kind: 'segmented', options: [{ value: 'system', label: 'Match system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] },
  order: 10,
};

const scale: SettingDef<UiScale> = {
  id: 'appearance.scale', section: 'appearance', label: 'Interface text size', keywords: 'zoom font size bigger smaller scale',
  hint: 'Menus, panels and labels. The editor has its own font size',
  scope: 'account', default: 100, validate: oneOf(UI_SCALES),
  control: { kind: 'segmented', options: UI_SCALES.map((s) => ({ value: s, label: `${s}%` })) },
  order: 20,
};

const contrast: SettingDef<ContrastChoice> = {
  id: 'appearance.contrast', section: 'appearance', label: 'Increase contrast', keywords: 'accessibility borders legibility',
  hint: (v) => (v === 'more' ? 'Stronger lines and text, and no see-through menus' : 'Follows your system’s accessibility setting'),
  scope: 'account', default: 'system', validate: oneOf(['system', 'more'] as const),
  control: { kind: 'select', options: [{ value: 'system', label: 'Follow system' }, { value: 'more', label: 'On' }] },
  order: 30,
};

const motion: SettingDef<MotionChoice> = {
  id: 'appearance.motion', section: 'appearance', label: 'Reduce motion', keywords: 'animation accessibility',
  hint: (v) => (v === 'reduce' ? 'Panels and menus appear without moving' : 'Follows your system’s accessibility setting'),
  scope: 'account', default: 'system', validate: oneOf(['system', 'reduce'] as const),
  control: { kind: 'select', options: [{ value: 'system', label: 'Follow system' }, { value: 'reduce', label: 'On' }] },
  order: 40,
};

const editorFont: SettingDef<string> = {
  id: 'editor.font', section: 'editor-text', label: 'Font', keywords: 'typeface monospace family',
  hint: 'A font that isn’t installed on this computer shows as the system monospace font',
  scope: 'account', default: '', validate: isFontName,
  control: { kind: 'select', options: EDITOR_FONTS.map((f) => ({ ...f })) },
  order: 10,
};

const editorFontSize: SettingDef<number> = {
  id: 'editor.fontSize', section: 'editor-text', label: 'Font size', keywords: 'text size bigger smaller',
  scope: 'account', default: 13.5, validate: inRange(10, 24),
  control: { kind: 'slider', min: 10, max: 24, step: 0.5, unit: 'px' },
  order: 20,
};

const editorLineHeight: SettingDef<number> = {
  id: 'editor.lineHeight', section: 'editor-text', label: 'Line height', keywords: 'spacing leading',
  scope: 'account', default: 1.55, validate: inRange(1.2, 2),
  control: { kind: 'slider', min: 1.2, max: 2, step: 0.05 },
  order: 30,
};

const editorLigatures: SettingDef<boolean> = {
  id: 'editor.ligatures', section: 'editor-text', label: 'Font ligatures', keywords: 'font glyphs arrows',
  hint: 'Draws pairs such as != and -> as one symbol, in fonts that have them',
  scope: 'account', default: false, validate: isBool, control: switchControl,
  order: 40,
};

const visualFontSize: SettingDef<number> = {
  id: 'visual.fontSize', section: 'editor-text', label: 'Visual mode text size', keywords: 'font size prose',
  scope: 'account', default: 16, validate: inRange(13, 22),
  control: { kind: 'slider', min: 13, max: 22, step: 1, unit: 'px' },
  order: 50,
};

const visualWidth: SettingDef<VisualWidth> = {
  id: 'visual.width', section: 'editor-text', label: 'Visual mode line width', keywords: 'measure column',
  scope: 'account', default: 'readable', validate: oneOf(['readable', 'full'] as const),
  control: { kind: 'segmented', options: [{ value: 'readable', label: 'Readable' }, { value: 'full', label: 'Full width' }] },
  order: 60,
};

const spellcheck: SettingDef<boolean> = {
  id: ids.spellcheck, section: 'editor-behaviour', label: 'Spellcheck', keywords: 'spelling dictionary',
  // V1's hints, word for word, on the rows the V1 dialog had.
  hint: (v) => (v ? 'Underlines misspelled words in .tex and .md files, never in commands or math' : 'No underlines'),
  scope: 'account', default: true, validate: isBool, key: 'aldine.spellcheck', codec: onUnless0, control: switchControl,
  order: 100,
};

const spellLang: SettingDef<string> = {
  id: ids.spellLang, section: 'editor-behaviour', label: 'Spellcheck language', keywords: 'dictionary language',
  hint: 'Checked with the browser’s dictionary for it, where the browser has one',
  scope: 'account', default: '', validate: (v: unknown): v is string => v === '' || (typeof v === 'string' && spellLangKnown(v)),
  key: 'aldine.spellcheckLang', codec: spellLangCodec(spellLangKnown),
  control: { kind: 'select', options: SPELL_LANG_OPTIONS.map((l) => ({ ...l })) },
  dependsOn: ids.spellcheck, order: 110,
};

const vim: SettingDef<boolean> = {
  id: ids.vim, section: 'editor-behaviour', label: 'Vim keybindings', keywords: 'vi modal keys',
  hint: (v) => (v ? 'Esc for normal mode, i to insert' : 'Standard editing keys'),
  scope: 'account', default: false, validate: isBool, key: 'aldine.vim', codec: offUnless1, control: switchControl,
  order: 120,
};

const changeMarks: SettingDef<boolean> = {
  id: ids.changeMarks, section: 'editor-behaviour', label: 'Mark changed lines and files', keywords: 'gutter diff modified',
  hint: 'Lines and files changed since the last commit get a mark in the gutter and the file tree',
  scope: 'account', default: true, validate: isBool, key: 'aldine.changeMarks', codec: onUnless0, control: switchControl,
  order: 130,
};

const contextMenu: SettingDef<boolean> = {
  id: ids.contextMenu, section: 'editor-behaviour', label: 'Editor’s own right-click menu', keywords: 'context menu right click',
  hint: 'Shift+right-click always opens the browser’s menu, with spelling suggestions',
  scope: 'account', default: true, validate: isBool, control: switchControl,
  order: 140,
};

/** The editor's last mode on this device; the toolbar sets it, so no settings row shows it. */
const editorMode: SettingDef<'source' | 'visual'> = {
  id: ids.editorMode, section: 'editor-behaviour', label: 'Editor mode',
  scope: 'device', default: 'source', validate: oneOf(['source', 'visual'] as const), key: 'aldine.editorMode', codec: editorModeCodec,
  control: { kind: 'segmented', options: [{ value: 'source', label: 'Source' }, { value: 'visual', label: 'Visual' }] },
  visible: never, order: 900,
};

const explain: SettingDef<boolean> = {
  id: ids.explainAutomatic, section: 'typing', label: 'Explain automatic changes the first few times', keywords: 'notice tip hint',
  hint: 'A short note says what changed and how to put back what you typed',
  scope: 'account', default: true, validate: isBool, control: switchControl,
  order: 900,
};

const autoTypeset: SettingDef<boolean> = {
  id: ids.autoTypeset, section: 'typesetting', label: 'Auto-typeset', keywords: 'compile automatic preview',
  hint: (v) => (v ? 'Typesets shortly after you stop typing' : 'Typeset by hand only'),
  scope: 'account', default: true, validate: isBool, key: 'aldine.autoTypeset', codec: onUnless0, control: switchControl,
  order: 10,
};

const draftTypeset: SettingDef<boolean> = {
  id: ids.draftTypeset, section: 'typesetting', label: 'Quick draft while typing', keywords: 'compile fast single pass',
  hint: 'Auto-typeset runs one engine pass; Typeset runs the full cycle',
  scope: 'account', default: true, validate: isBool, key: 'aldine.draftTypeset', codec: onUnless0, control: switchControl,
  dependsOn: ids.autoTypeset, order: 20,
};

const pdfDark: SettingDef<PdfDark> = {
  id: 'pdf.dark', section: 'pdf', label: 'PDF in the dark theme', keywords: 'invert dim night paper',
  hint: (v) => (v === 'invert' ? 'Photos and figures invert too' : v === 'dim' ? 'White paper, a little darker' : 'White paper, as it prints'),
  scope: 'account', default: 'paper', validate: oneOf(['paper', 'dim', 'invert'] as const),
  control: { kind: 'segmented', options: [{ value: 'paper', label: 'Paper' }, { value: 'dim', label: 'Dimmed' }, { value: 'invert', label: 'Inverted' }] },
  order: 10,
};

/** '' lets the window's width decide (util/layout.ts shownLayout). */
const layout: SettingDef<PaneLayout> = {
  id: ids.layout, section: 'pdf', label: 'Layout', keywords: 'panes side by side split',
  scope: 'device', default: '', validate: oneOf(['', 'editor', 'both', 'pdf'] as const), key: 'aldine.layout', codec: layoutCodec,
  control: { kind: 'select', options: [
    { value: '', label: 'Decide by window width' }, { value: 'both', label: 'Editor and PDF' },
    { value: 'editor', label: 'Editor only' }, { value: 'pdf', label: 'PDF only' },
  ] },
  order: 30,
};

/** The PDF zoom on this device; the zoom controls set it, so no settings row shows it. */
const pdfZoom: SettingDef<number> = {
  id: ids.pdfZoom, section: 'pdf', label: 'PDF zoom',
  scope: 'device', default: 1, validate: inRange(0.5, 3), key: 'aldine.pdfZoom', codec: pdfZoomCodec,
  control: { kind: 'slider', min: 0.5, max: 3, step: 0.25 },
  visible: never, order: 900,
};

/** The keybinding registry (WP04) reads and writes these; the Shortcuts section
 *  shows them as its own rows, so no generic row does. */
const shortcuts: SettingDef<ShortcutOverrides> = {
  id: ids.shortcuts, section: 'shortcuts', label: 'Keyboard shortcuts', keywords: 'keys chords bindings',
  scope: 'account', default: {}, validate: isShortcutOverrides, key: 'aldine.shortcuts', codec: shortcutsCodec,
  control: { kind: 'custom', load: () => import('../controls/ShortcutOverrides') },
  visible: never, order: 10,
};

const agentPresence: SettingDef<boolean> = {
  id: ids.agentPresence, section: 'labs', label: 'Agent edit highlights (experimental)', keywords: 'claude codex agent fade',
  hint: 'Edits an agent makes fade in with a highlight',
  scope: 'device', default: false, validate: isBool, key: 'aldine.experimental.agentPresence', codec: offUnless1, control: switchControl,
  applies: 'reopen', order: 10,
};

/** Off: account-scope settings stay on this browser and the account is not asked. */
const accountSync: SettingDef<boolean> = {
  id: 'account.sync', section: 'account', label: 'Keep my settings in my account', keywords: 'sync devices browsers',
  hint: (v) => (v ? 'Your theme, editor and typing settings follow you to every browser you sign in on' : 'Settings stay on this browser'),
  scope: 'device', default: true, validate: isBool, control: switchControl,
  visible: signedInWithAccounts, order: 10,
};

export const CORE_SETTINGS: readonly AnySettingDef[] = [
  accountSync,
  theme, scale, contrast, motion,
  editorFont, editorFontSize, editorLineHeight, editorLigatures, visualFontSize, visualWidth,
  spellcheck, spellLang, vim, changeMarks, contextMenu, editorMode,
  explain,
  autoTypeset, draftTypeset,
  pdfDark, layout, pdfZoom,
  shortcuts,
  agentPresence,
];

/** Ids of the settings above that are not in CORE_SETTING_IDS, for readers outside this package. */
export const CORE_EXTRA_IDS = {
  sync: 'account.sync',
  uiScale: 'appearance.scale',
  contrast: 'appearance.contrast',
  motion: 'appearance.motion',
  editorFont: 'editor.font',
  editorFontSize: 'editor.fontSize',
  editorLineHeight: 'editor.lineHeight',
  editorLigatures: 'editor.ligatures',
  visualFontSize: 'visual.fontSize',
  visualWidth: 'visual.width',
  pdfDark: 'pdf.dark',
} as const;
