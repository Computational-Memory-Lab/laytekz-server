import type { AnySettingDef, SettingDef } from '../../settings/types';

/**
 * The code editor's own settings (WP05 editor-host): gutters, active line,
 * whitespace, indent (Detect, 2, 4 or Tab), wrap, and the completion list (as
 * I type, on request, off), read by core/editorSettings.ts. Pure data,
 * separate from the extensions so the settings registry loads no CodeMirror.
 * Every default is the V1 editor exactly; a value only changes the editor
 * once someone picks another one.
 */

export const EDITOR_SETTING_IDS = {
  lineNumbers: 'editor.lineNumbers',
  foldGutter: 'editor.foldGutter',
  activeLine: 'editor.activeLine',
  whitespace: 'editor.whitespace',
  indent: 'editor.indent',
  wrap: 'editor.wrap',
  wrapIndent: 'editor.wrapIndent',
  completion: 'editor.completion',
} as const;

/** 'detect': from the open file's leading whitespace, two spaces when it has none to go by. */
export type IndentChoice = 'detect' | '2' | '4' | 'tab';
export const INDENT_CHOICES: readonly IndentChoice[] = ['detect', '2', '4', 'tab'];

/** When the completion list opens: 'typing' as you type, 'request' only with
 *  Ctrl+Space (Option+` on a Mac too), 'off' never. */
export type CompletionActivation = 'typing' | 'request' | 'off';
export const COMPLETION_ACTIVATIONS: readonly CompletionActivation[] = ['typing', 'request', 'off'];

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const oneOf = <T extends string>(list: readonly T[]) => (v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

const toggle = (id: string, label: string, def: boolean, order: number, extra: Partial<SettingDef<boolean>> = {}): SettingDef<boolean> => ({
  id, section: 'editor-behaviour', label, scope: 'account', default: def, validate: isBool, control: { kind: 'switch' }, order, ...extra,
});

export const EDITOR_SETTINGS: readonly AnySettingDef[] = [
  toggle(EDITOR_SETTING_IDS.lineNumbers, 'Line numbers', true, 10, { keywords: 'gutter' }),
  toggle(EDITOR_SETTING_IDS.activeLine, 'Highlight the current line', true, 20, { keywords: 'active line cursor' }),
  toggle(EDITOR_SETTING_IDS.foldGutter, 'Fold arrows in the gutter', true, 30, { keywords: 'collapse folding' }),
  toggle(EDITOR_SETTING_IDS.whitespace, 'Show spaces and tabs', false, 40, { keywords: 'whitespace invisible characters' }),
  toggle(EDITOR_SETTING_IDS.wrap, 'Wrap long lines', true, 50, {
    hint: 'In Source mode. Visual mode always wraps.', keywords: 'line wrapping soft wrap',
  }),
  toggle(EDITOR_SETTING_IDS.wrapIndent, 'Indent wrapped lines', true, 60, {
    hint: 'A wrapped line continues under the start of its text, in Source mode.', dependsOn: EDITOR_SETTING_IDS.wrap, keywords: 'hanging indent',
  }),
  {
    id: EDITOR_SETTING_IDS.indent,
    section: 'editor-behaviour',
    label: 'Indentation',
    hint: 'What Tab and Format document indent with.',
    keywords: 'tab spaces indent unit',
    scope: 'account',
    default: '2',
    validate: oneOf(INDENT_CHOICES),
    control: {
      kind: 'select',
      options: [
        { value: 'detect', label: 'Detect from the file' },
        { value: '2', label: '2 spaces' },
        { value: '4', label: '4 spaces' },
        { value: 'tab', label: 'Tab' },
      ],
    },
    order: 70,
  } satisfies SettingDef<IndentChoice>,
  {
    id: EDITOR_SETTING_IDS.completion,
    section: 'completion',
    label: 'Show completions',
    hint: 'Commands, environments, citation keys, labels and file names.',
    keywords: 'autocomplete suggestions popup ctrl space',
    scope: 'account',
    default: 'typing',
    validate: oneOf(COMPLETION_ACTIVATIONS),
    control: {
      kind: 'segmented',
      options: [
        { value: 'typing', label: 'As I type' },
        { value: 'request', label: 'When I press Ctrl+Space' },
        { value: 'off', label: 'Never' },
      ],
    },
    order: 10,
  } satisfies SettingDef<CompletionActivation>,
];
