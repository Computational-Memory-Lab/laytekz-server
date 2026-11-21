import { describe, expect, it } from 'vitest';
import type { AnySettingDef, SectionDef, SectionId, SettingsEnv } from '../../../settings/types';
import { CORE_SETTING_IDS } from '../../../settings/types';
import { DEFAULT_CAPABILITIES } from '../../../settings/capabilities';
import {
  accountRun, controlDomId, controlKind, controlTestId, embeddedSections, hintText, isRowVisible, LEGACY_TEST_IDS,
  optionFor, pageSections, parseNumber, resolveSection, rowTestId, scopeName, sectionInView, sectionPath, settingsEnv,
  snapToStep, toggleChecklist,
} from '../model';

const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const def = (o: Partial<AnySettingDef> & Pick<AnySettingDef, 'id' | 'section'>): AnySettingDef => ({
  label: o.id, scope: 'account', default: false, validate: bool, control: { kind: 'switch' }, ...o,
});

const env = (o: Partial<SettingsEnv> = {}): SettingsEnv => ({
  accounts: true, signedIn: true, desktop: false, phone: false, capabilities: DEFAULT_CAPABILITIES, project: null, ...o,
});

const SECTIONS: SectionDef[] = [
  { id: 'typing', title: 'Typing', order: 60 },
  { id: 'account', title: 'Account', order: 10 },
  { id: 'connections', title: 'Connections', order: 20 },
  { id: 'appearance', title: 'Appearance', order: 30 },
  { id: 'shortcuts', title: 'Keyboard shortcuts', order: 190 },
  { id: 'project', title: 'This project', order: 230 },
];

describe('which sections and rows the page shows', () => {
  const rows: Record<string, AnySettingDef[]> = {
    appearance: [def({ id: 'appearance.theme', section: 'appearance' })],
    typing: [
      def({ id: 'escape.on', section: 'typing', automatic: true }),
      def({ id: 'typing.explain', section: 'typing' }),
      def({ id: 'escape.hidden', section: 'typing', visible: () => false }),
    ],
    project: [def({ id: 'wordcount.rule', section: 'project', scope: 'project' })],
  };
  const rowsIn = (s: SectionId) => rows[s] ?? [];

  it('orders sections, keeps those with rows or embedded rows, and lists automatic rows apart', () => {
    const shown = pageSections(SECTIONS, rowsIn, env(), new Set<SectionId>(['shortcuts']));
    expect(shown.map((s) => s.def.id)).toEqual(['appearance', 'typing', 'shortcuts']);
    const typing = shown.find((s) => s.def.id === 'typing')!;
    expect(typing.rows.map((d) => d.id)).toEqual(['typing.explain']);
    expect(typing.automatic.map((d) => d.id)).toEqual(['escape.on']);
  });

  it('shows project settings only over a project', () => {
    expect(pageSections(SECTIONS, rowsIn, env(), new Set()).some((s) => s.def.id === 'project')).toBe(false);
    const over = pageSections(SECTIONS, rowsIn, env({ project: { id: 'p1', canEdit: true, showcase: false } }), new Set());
    expect(over.find((s) => s.def.id === 'project')?.rows.map((d) => d.id)).toEqual(['wordcount.rule']);
  });

  it('hides a row whose visible() throws instead of failing the page', () => {
    const broken = def({ id: 'pet.on', section: 'pet', visible: () => { throw new Error('boom'); } });
    expect(isRowVisible(broken, env())).toBe(false);
    expect(isRowVisible(def({ id: 'pet.size', section: 'pet', visible: (e) => e.signedIn }), env({ signedIn: false }))).toBe(false);
  });

  it('never draws the shortcut overrides as a generic row: the recorder rows are embedded', () => {
    expect(isRowVisible(def({ id: CORE_SETTING_IDS.shortcuts, section: 'shortcuts' }), env())).toBe(false);
  });

  it('embeds the account rows when signed in, and this browser\'s name without accounts', () => {
    expect([...embeddedSections({ accounts: true, signedIn: true, project: false })].sort()).toEqual(['account', 'connections', 'shortcuts']);
    expect([...embeddedSections({ accounts: false, signedIn: false, project: true })].sort()).toEqual(['account', 'project', 'shortcuts']);
    // a link visitor who is not signed in has no account rows
    expect([...embeddedSections({ accounts: true, signedIn: false, project: true })].sort()).toEqual(['project', 'shortcuts']);
  });

  it('wraps the Account and Connections run in the V1 account-settings test id only while signed in', () => {
    const shown = pageSections(SECTIONS, rowsIn, env(), embeddedSections({ accounts: true, signedIn: true, project: false }));
    expect(shown.map((s) => s.def.id)).toEqual(['account', 'connections', 'appearance', 'typing', 'shortcuts']);
    expect(accountRun(shown, true)).toEqual({ start: 0, end: 1 });
    expect(accountRun(shown, false)).toBeNull();
  });

  it('scrolls to the asked-for section only when it is shown', () => {
    const shown = pageSections(SECTIONS, rowsIn, env(), new Set<SectionId>(['shortcuts']));
    expect(resolveSection('typing', shown)).toBe('typing');
    expect(resolveSection('desktop', shown)).toBeNull();
    expect(resolveSection(undefined, shown)).toBeNull();
  });
});

describe('the page environment', () => {
  const project = {
    project: { id: 'p1', name: 'Paper', rootFile: 'main.tex', engine: 'pdf', stopOnFirstError: false, manualCommits: false },
    files: [], autoTypeset: true, vim: false, spellcheck: true, spellLang: '',
    onToggleSpellcheck() {}, onSetSpellLang() {}, onRename: async () => {}, onSetRoot: async () => {}, onSetEngine: async () => {},
    onSetStopOnFirstError: async () => {}, onSetManualCommits: async () => {}, onToggleAutoTypeset() {}, onToggleVim() {},
  };
  const base = { accounts: true, signedIn: true, desktop: false, phone: false, capabilities: DEFAULT_CAPABILITIES };

  it('describes the project as the dialog did: collaborators edit, viewers and showcases do not', () => {
    expect(settingsEnv({ ...base, project }).project).toEqual({ id: 'p1', canEdit: true, showcase: false });
    expect(settingsEnv({ ...base, project: { ...project, canConfigure: false } }).project).toEqual({ id: 'p1', canEdit: false, showcase: false });
    expect(settingsEnv({ ...base, project: { ...project, readOnly: true } }).project).toEqual({ id: 'p1', canEdit: false, showcase: true });
    expect(settingsEnv({ ...base, project: null }).project).toBeNull();
  });
});

describe('rows', () => {
  it('keeps the V1 test ids (and DOM ids) on the preferences the Project settings dialog showed', () => {
    expect(controlTestId(CORE_SETTING_IDS.theme)).toBe('settings-theme');
    expect(controlTestId(CORE_SETTING_IDS.autoTypeset)).toBe('settings-auto-typeset');
    expect(controlTestId(CORE_SETTING_IDS.vim)).toBe('settings-vim');
    expect(controlTestId(CORE_SETTING_IDS.spellcheck)).toBe('settings-spellcheck');
    expect(controlTestId(CORE_SETTING_IDS.spellLang)).toBe('settings-spell-lang');
    expect(controlDomId(CORE_SETTING_IDS.vim)).toBe('settings-vim');
    expect(controlTestId('editor.fontSize')).toBe('setting-editor.fontSize-control');
    expect(rowTestId('editor.fontSize')).toBe('setting-editor.fontSize');
  });

  it('draws a legacy segmented control as the select the V1 specs drive', () => {
    const options = [{ value: 'system', label: 'Match system' }, { value: 'dark', label: 'Dark' }];
    expect(controlKind({ id: CORE_SETTING_IDS.theme, control: { kind: 'segmented', options } })).toBe('select');
    expect(controlKind({ id: 'pdf.dark', control: { kind: 'segmented', options } })).toBe('segmented');
    expect(Object.keys(LEGACY_TEST_IDS)).toHaveLength(5);
  });

  it('names the scope in words: an account setting stays on this browser without an account', () => {
    expect(scopeName({ scope: 'account' }, { accounts: true, signedIn: true })).toBe('Your account');
    expect(scopeName({ scope: 'account' }, { accounts: false, signedIn: false })).toBe('This browser');
    expect(scopeName({ scope: 'account' }, { accounts: true, signedIn: false })).toBe('This browser');
    expect(scopeName({ scope: 'device' }, { accounts: true, signedIn: true })).toBe('This browser');
    expect(scopeName({ scope: 'project' }, { accounts: false, signedIn: false })).toBe('This project');
  });

  it('explains a row: the hint for its value, a reopen note, or the parent to turn on first', () => {
    const vim = def({ id: 'editor.vim', section: 'editor-behaviour', hint: (v: boolean) => (v ? 'Esc for normal mode, i to insert' : 'Standard editing keys') });
    expect(hintText(vim, true)).toBe('Esc for normal mode, i to insert');
    expect(hintText(vim, false)).toBe('Standard editing keys');
    expect(hintText(def({ id: 'labs.x', section: 'labs', hint: 'Fades in', applies: 'reopen' }), true)).toBe('Fades in · Applies when you reopen the file');
    expect(hintText(def({ id: 'labs.y', section: 'labs' }), true)).toBeNull();
    expect(hintText(vim, true, { parentOff: true, parentLabel: 'Spellcheck' })).toBe('Turn on “Spellcheck” first');
    expect(hintText(def({ id: 'x.y', section: 'labs', hint: () => { throw new Error('no'); } }), true)).toBeNull();
  });
});

describe('control values', () => {
  it('maps a select\'s text back to the typed option value', () => {
    const options = [{ value: 90, label: '90%' }, { value: 100, label: '100%' }];
    expect(optionFor(options, '100')).toBe(100);
    expect(optionFor(options, '101')).toBeUndefined();
    expect(optionFor([{ value: '', label: 'Browser default' }, { value: 'de-DE', label: 'German' }], '')).toBe('');
  });

  it('snaps a typed number to the slider\'s range and step, without float noise', () => {
    const size = { min: 10, max: 24, step: 0.5 };
    expect(snapToStep(13.7, size)).toBe(13.5);
    expect(snapToStep(99, size)).toBe(24);
    expect(snapToStep(2, size)).toBe(10);
    expect(snapToStep(1.37, { min: 1.2, max: 2, step: 0.05 })).toBe(1.35);
    expect(snapToStep(1.551, { min: 1.2, max: 2, step: 0.05 })).toBe(1.55);
  });

  it('reads a number field, keeping the old value for blank or junk text', () => {
    expect(parseNumber(' 14 ')).toBe(14);
    expect(parseNumber('13,5')).toBe(13.5);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('big')).toBeNull();
  });

  it('keeps a checklist in the options\' order', () => {
    const options = [{ value: '&' }, { value: '%' }, { value: '#' }];
    expect(toggleChecklist(options, ['#'], '&', true)).toEqual(['&', '#']);
    expect(toggleChecklist(options, ['&', '%'], '&', false)).toEqual(['%']);
  });
});

describe('addresses and the nav', () => {
  it('builds the section address over a project and on its own', () => {
    expect(sectionPath('editor-text', 'abc')).toBe('/p/abc/settings/editor-text');
    expect(sectionPath('appearance')).toBe('/settings/appearance');
    expect(sectionPath('appearance', null)).toBe('/settings/appearance');
  });

  it('marks the section under the reading line, and the last one at the end of the column', () => {
    const tops = [{ id: 'account' as const, top: 0 }, { id: 'appearance' as const, top: 400 }, { id: 'labs' as const, top: 900 }];
    expect(sectionInView(tops, 0, false)).toBe('account');
    expect(sectionInView(tops, 390, false)).toBe('appearance');
    expect(sectionInView(tops, 700, true)).toBe('labs');
    expect(sectionInView([], 0, false)).toBeNull();
  });
});
