import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';
import type { AnySettingDef, SettingsEnv, SettingsPageProps } from '../../../settings/types';
import { DEFAULT_CAPABILITIES } from '../../../settings/capabilities';

/** The store (WP02) and the auth context, as plain values the tests set. */
const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  location: { pathname: '/', search: '', hash: '' },
  sync: 'local' as string,
  auth: { authEnabled: false, user: null as null | Record<string, unknown>, providers: [] as unknown[], mcpEnabled: false, publicUrl: 'https://laytekz.example' as string | null, setUser() {}, refresh: async () => {} },
}));

vi.mock('../../../settings/store', () => ({
  getSetting: (id: string) => state.values.get(id),
  setSetting: (id: string, v: unknown) => { state.values.set(id, v); },
  resetSetting: (id: string) => { state.values.delete(id); },
  subscribeSetting: () => () => {},
  useSetting: (id: string) => [state.values.get(id), (v: unknown) => { state.values.set(id, v); }],
  useProjectSetting: (id: string) => [state.values.get(id), async (v: unknown) => { state.values.set(id, v); }, { canEdit: true }],
  // WP23: reset, the sync status and the conflict toast
  defaultOf: (def: { default: unknown }) => def.default,
  useSyncStatus: () => state.sync,
  getSyncStatus: () => state.sync,
  syncSettingsNow: async () => {},
  onSettingsConflict: () => () => {},
}));

vi.mock('../../Auth', () => ({ useAuth: () => state.auth }));

// useShortcutLabel subscribes without a server snapshot, which server rendering refuses.
vi.mock('../../../util/shortcuts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../util/shortcuts')>();
  return { ...actual, useShortcutLabel: (id: Parameters<typeof actual.chordFor>[0]) => actual.formatChord(actual.chordFor(id)) };
});

// The router as the page uses it. In Node, react-router loads its own copy of
// React from the workspace root, so the real one cannot render here.
vi.mock('react-router-dom', async () => {
  const { createElement } = await import('react');
  return {
    useLocation: () => state.location,
    Link: ({ to, replace: _replace, ...rest }: { to: string | { pathname?: string; search?: string }; replace?: boolean; [k: string]: unknown }) =>
      createElement('a', { ...rest, href: typeof to === 'string' ? to : `${to.pathname ?? ''}${to.search ?? ''}` }),
  };
});

/** The real sections; a fixed set of definitions covering every control kind and rule. */
vi.mock('../../../settings/registry', async () => {
  const actual = await vi.importActual<typeof import('../../../settings/registry')>('../../../settings/registry');
  const bool = (v: unknown): v is boolean => typeof v === 'boolean';
  const any = (v: unknown): v is unknown => v !== Symbol.for('never');
  const defs: AnySettingDef[] = [
    { id: 'appearance.theme', section: 'appearance', label: 'Theme', scope: 'account', default: 'system', validate: any, key: 'aldine.theme',
      control: { kind: 'segmented', options: [{ value: 'system', label: 'Match system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] } },
    { id: 'pdf.dark', section: 'pdf', label: 'PDF in the dark theme', scope: 'account', default: 'paper', validate: any,
      control: { kind: 'segmented', options: [{ value: 'paper', label: 'Paper' }, { value: 'dim', label: 'Dimmed' }] } },
    { id: 'editor.fontSize', section: 'editor-text', label: 'Font size', scope: 'account', default: 13.5, validate: any, control: { kind: 'slider', min: 10, max: 24, step: 0.5, unit: 'px' } },
    { id: 'editor.spellcheck', section: 'editor-behaviour', label: 'Spellcheck', scope: 'account', default: true, validate: bool, control: { kind: 'switch' } },
    { id: 'editor.spellLang', section: 'editor-behaviour', label: 'Spellcheck language', scope: 'account', default: '', validate: any, dependsOn: 'editor.spellcheck',
      control: { kind: 'select', options: [{ value: '', label: 'Browser default' }, { value: 'de-DE', label: 'German' }] } },
    { id: 'editor.vim', section: 'editor-behaviour', label: 'Vim keybindings', scope: 'account', default: false, validate: bool, control: { kind: 'switch' },
      hint: (v: boolean) => (v ? 'Esc for normal mode, i to insert' : 'Standard editing keys') },
    { id: 'typesetting.auto', section: 'typesetting', label: 'Auto-typeset', scope: 'account', default: true, validate: bool, control: { kind: 'switch' } },
    { id: 'labs.agentPresence', section: 'labs', label: 'Agent edit highlights', scope: 'device', default: false, validate: bool, control: { kind: 'switch' }, applies: 'reopen' },
    { id: 'escape.on', section: 'typing', label: 'Escape & and %', scope: 'account', default: true, validate: bool, control: { kind: 'switch' }, automatic: true },
    { id: 'escape.chars', section: 'typing', label: 'For these characters', scope: 'account', default: ['&', '%'], validate: any,
      control: { kind: 'checklist', options: [{ value: '&', label: '&' }, { value: '%', label: '%' }] } },
    { id: 'stats.house', section: 'statistics', label: 'House style', scope: 'account', default: '', validate: any, control: { kind: 'text' } },
    { id: 'pet.size', section: 'pet', label: 'Pet size', scope: 'account', default: 1, validate: any, control: { kind: 'number', min: 1, max: 3 }, visible: () => false },
    { id: 'wordcount.rule', section: 'wordcount', label: 'Count', scope: 'project', default: 'main', validate: any,
      control: { kind: 'select', options: [{ value: 'main', label: 'Main text' }, { value: 'all', label: 'Everything' }] } },
    { id: 'highlighter.palette', section: 'highlighter', label: 'Colours', scope: 'account', default: null, validate: any,
      control: { kind: 'custom', load: () => new Promise(() => {}) } },
  ];
  return { ...actual, SETTINGS: new Map(defs.map((d) => [d.id, d])), settingDef: (id: string) => defs.find((d) => d.id === id), settingsIn: (s: string) => defs.filter((d) => d.section === s) };
});

import Settings from '../../../pages/Settings';
import { SettingRowView } from '../SettingRow';
import { settingDef } from '../../../settings/registry';

const project: NonNullable<SettingsPageProps['project']> = {
  project: { id: 'p1', name: 'Paper', rootFile: 'main.tex', engine: 'pdf', stopOnFirstError: false, manualCommits: false },
  files: [{ path: 'main.tex', type: 'file' } as never],
  autoTypeset: true, vim: true, spellcheck: false, spellLang: '',
  onToggleSpellcheck() {}, onSetSpellLang() {}, onRename: async () => {}, onSetRoot: async () => {}, onSetEngine: async () => {},
  onSetStopOnFirstError: async () => {}, onSetManualCommits: async () => {}, onToggleAutoTypeset() {}, onToggleVim() {},
  yourName: 'Ada', onSetYourName() {},
};

function render(props: Partial<ComponentProps<typeof Settings>> = {}, url = '/p/p1/settings/appearance?branch=draft'): string {
  const u = new URL(url, 'http://app.test');
  state.location = { pathname: u.pathname, search: u.search, hash: u.hash };
  return renderToStaticMarkup(<Settings onClose={() => {}} {...props} />);
}

/** The opening tag of the element with this test id. */
function tag(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  if (at < 0) return '';
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

beforeEach(() => {
  state.values = new Map<string, unknown>([
    ['appearance.theme', 'dark'], ['pdf.dark', 'paper'], ['editor.fontSize', 15], ['editor.spellcheck', false], ['editor.spellLang', ''],
    ['editor.vim', true], ['typesetting.auto', true], ['labs.agentPresence', false], ['escape.on', true], ['escape.chars', ['%']],
    ['stats.house', 'APA'], ['wordcount.rule', 'all'],
  ]);
  state.auth = { ...state.auth, authEnabled: false, user: null };
  state.sync = 'local';
});

describe('the settings page over a project', () => {
  it('is one dialog with the new ids, the V1 project-settings id around its column, and Close', () => {
    const html = render({ section: 'appearance', project });
    expect(tag(html, 'settings-page')).toContain('role="dialog"');
    expect(tag(html, 'settings-page')).toContain('aria-label="Settings"');
    expect(html).toContain('data-testid="project-settings"');
    expect(tag(html, 'settings-close')).toContain('<button');
    expect(html).toContain('data-testid="settings-nav"');
  });

  it('embeds the project\'s rows, the shortcut recorders and this browser\'s name', () => {
    const html = render({ project });
    for (const id of ['settings-this-project', 'settings-name', 'settings-root-file', 'settings-engine', 'settings-texlive', 'settings-stop-on-error', 'settings-commit-mode', 'settings-shortcuts', 'shortcut-typeset', 'shortcut-comment']) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    expect(tag(html, 'settings-your-name')).toContain('value="Ada"');
  });

  it('keeps the V1 ids on the moved preferences, with the controls the V1 specs drive', () => {
    const html = render({ project });
    const theme = tag(html, 'settings-theme');
    expect(theme).toMatch(/^<select/);
    expect(theme).toContain('id="settings-theme"');
    expect(html).toMatch(/<option value="dark" selected="">Dark<\/option>/);
    expect(tag(html, 'settings-vim')).toContain('type="checkbox"');
    expect(tag(html, 'settings-vim')).toContain('role="switch"');
    expect(tag(html, 'settings-vim')).toContain('checked=""');
    expect(tag(html, 'settings-auto-typeset')).toContain('checked=""');
    expect(tag(html, 'settings-spellcheck')).not.toContain('checked');
    // the hint follows the value, inside the project-settings column (spec 52)
    expect(html).toContain('Esc for normal mode, i to insert');
  });

  it('disables a row whose parent is off and says which one to turn on', () => {
    const html = render({ project });
    expect(tag(html, 'settings-spell-lang')).toContain('disabled=""');
    expect(html).toContain('Turn on “Spellcheck” first');
  });

  it('says once where settings are saved, and badges only the rows that differ', () => {
    const html = render({ project });
    expect(html).toContain('in this browser unless a setting is marked otherwise');
    expect(html).not.toContain('data-testid="setting-appearance.theme-scope"');
    expect(html).not.toContain('data-testid="setting-labs.agentPresence-scope"');
    expect(html).toMatch(/data-testid="setting-wordcount\.rule-scope">This project</);
    expect(html).toContain('Applies when you reopen the file');
  });

  it('lists automatic rows under "Automatic changes" and leaves out hidden rows and empty sections', () => {
    const html = render({ project });
    const typing = html.slice(html.indexOf('data-testid="settings-section-typing"'));
    expect(typing).toContain('Automatic changes');
    expect(html).toContain('data-testid="settings-section-typing-automatic"');
    expect(html).not.toContain('setting-pet.size');
    expect(html).not.toContain('settings-section-pet"');
    expect(html).not.toContain('settings-nav-pet"');
    expect(html).not.toContain('settings-section-desktop"');
  });

  it('links each section on the same project and branch, and marks the asked-for one', () => {
    const html = render({ section: 'typesetting', project });
    expect(tag(html, 'settings-nav-appearance')).toContain('href="/p/p1/settings/appearance?branch=draft"');
    expect(tag(html, 'settings-nav-typesetting')).toContain('aria-current="true"');
    expect(tag(html, 'settings-nav-appearance')).not.toContain('aria-current');
  });

  it('highlights the row a #<id> link names', () => {
    const html = render({ section: 'editor-behaviour', setting: 'editor.vim', project });
    expect(tag(html, 'setting-editor.vim')).toContain('data-target="true"');
    expect(tag(html, 'setting-editor.spellcheck')).not.toContain('data-target');
  });
});

describe('the settings page on its own', () => {
  it('has no project rows or project settings, and no V1 project id', () => {
    const html = render({ section: 'appearance' }, '/settings/appearance');
    expect(html).not.toContain('data-testid="project-settings"');
    expect(html).not.toContain('settings-this-project');
    expect(html).not.toContain('setting-wordcount.rule');
    expect(tag(html, 'settings-nav-appearance')).toContain('href="/settings/appearance"');
    // without accounts, this browser's name is in the Account section
    expect(html).toContain('data-testid="settings-your-name"');
  });

  it('embeds the account and its connections, signed in, inside the V1 account-settings id', () => {
    state.auth = { ...state.auth, authEnabled: true, user: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.org' } };
    const html = render({ section: 'account' }, '/settings/account');
    const account = html.slice(html.indexOf('data-testid="account-settings"'));
    for (const id of ['account-email', 'account-name-row', 'account-commit-email-row', 'change-password-form', 'save-password', 'agent-token-create']) {
      expect(account, id).toContain(`data-testid="${id}"`);
    }
    expect(html).not.toContain('data-testid="settings-your-name"');
    expect(html).toContain('to your account unless a setting is marked otherwise');
    expect(html).not.toContain('data-testid="setting-appearance.theme-scope"');
  });
});

describe('generic controls', () => {
  const env: SettingsEnv = { accounts: true, signedIn: true, desktop: false, phone: false, capabilities: DEFAULT_CAPABILITIES, project: null };
  const row = (id: string, value: unknown, disabled = false) => renderToStaticMarkup(
    <SettingRowView def={settingDef(id)!} env={env} value={value} onChange={() => true} disabled={disabled} parentOff={false} />,
  );

  it('draws a segmented choice as a radio group with one tab stop', () => {
    const html = row('pdf.dark', 'dim');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-labelledby="setting-label-pdf.dark"');
    expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*>Dimmed</);
    expect(html).toMatch(/aria-checked="false" tabindex="-1"[^>]*>Paper</);
  });

  it('draws a slider with a number field and its unit', () => {
    const html = row('editor.fontSize', 15);
    expect(tag(html, 'setting-editor.fontSize-control')).toContain('type="range"');
    expect(tag(html, 'setting-editor.fontSize-control')).toContain('value="15"');
    expect(tag(html, 'setting-editor.fontSize-control-number')).toContain('value="15"');
    expect(html).toContain('>px<');
  });

  it('draws a checklist, a text field and a lazily loaded custom control', () => {
    expect(tag(row('escape.chars', ['%']), 'setting-escape.chars-control-%')).toContain('checked=""');
    expect(tag(row('escape.chars', ['%']), 'setting-escape.chars-control-&')).not.toContain('checked');
    expect(tag(row('stats.house', 'APA'), 'setting-stats.house-control')).toContain('value="APA"');
    const custom = row('highlighter.palette', null);
    expect(tag(custom, 'setting-highlighter.palette-control')).toContain('role="group"');
    expect(custom).toContain('Loading…');
  });

  it('points the label at the control and the control at its hint', () => {
    const html = row('editor.vim', false);
    expect(html).toContain('for="settings-vim"');
    expect(tag(html, 'settings-vim')).toContain('aria-describedby="setting-hint-editor.vim"');
    expect(html).toContain('Standard editing keys');
  });

  it('disables a control while the row is', () => {
    expect(tag(row('editor.fontSize', 15, true), 'setting-editor.fontSize-control')).toContain('disabled=""');
  });
});

describe('the settings page, completed (WP23)', () => {
  it('has a search field, the sync status and the export, import and reset tools', () => {
    const html = render({ project });
    expect(tag(html, 'settings-search')).toContain('type="search"');
    expect(tag(html, 'settings-search')).toContain('aria-label="Search settings"');
    expect(html).toMatch(/data-testid="settings-sync-status" data-status="local">.*Settings stay on this browser/);
    for (const id of ['settings-export', 'settings-import', 'settings-import-file', 'settings-reset-all', 'settings-close']) expect(html, id).toContain(`data-testid="${id}"`);
  });

  it('says where changes go while signed in', () => {
    state.sync = 'saved';
    expect(render({ project })).toContain('Saved to your account');
    state.sync = 'offline';
    expect(render({ project })).toContain('You’re offline. Changes sync when you reconnect');
  });

  it('offers Reset on a row that differs from its default, and on its section', () => {
    const html = render({ project });
    // editor.fontSize is 15 (default 13.5); editor.spellcheck is off (default on) but its row is not disabled
    expect(html).toContain('data-testid="setting-editor.fontSize-reset"');
    expect(html).toContain('data-testid="setting-editor.spellcheck-reset"');
    expect(html).not.toContain('data-testid="setting-typesetting.auto-reset"');
    expect(html).toContain('data-testid="settings-section-editor-text-reset"');
    expect(html).not.toContain('data-testid="settings-section-typesetting-reset"');
  });

  it('lists every keybinding with record, None and the fixed keys', () => {
    const html = render({ project });
    for (const id of ['typeset', 'comment', 'jump', 'palette', 'search', 'settings', 'follow']) {
      expect(html, id).toContain(`data-testid="shortcut-${id}"`);
      expect(html, id).toContain(`data-testid="shortcut-none-${id}"`);
    }
    expect(html).not.toContain('data-testid="shortcut-reset-typeset"');
    expect(html).toContain('data-testid="settings-fixed-keys"');
  });

  it('shows the typography preview under Editor text and a note under Labs', () => {
    const html = render({ project });
    const text = html.slice(html.indexOf('data-testid="settings-section-editor-text"'), html.indexOf('data-testid="settings-section-editor-behaviour"'));
    expect(text).toContain('data-testid="settings-typography-preview"');
    expect(html).toContain('data-testid="settings-labs-note"');
  });

  it('shows the Desktop app section for /settings/desktop-app on the web, with where these settings live', () => {
    const html = render({ section: 'desktop' }, '/settings/desktop-app');
    expect(html).toContain('data-testid="settings-section-desktop"');
    expect(html).toContain('data-testid="settings-desktop-web"');
  });
});
