import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnySettingDef } from '../../settings/types';
import type { EditorPageCtx } from '../../features/types';
import type { CommandDef } from '../types';

const values = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../settings/store', () => ({
  getSetting: (id: string) => {
    if (id === 'broken.setting') throw new Error('unreadable');
    return values.get(id);
  },
  setSetting: (id: string, v: unknown) => { values.set(id, v); },
  resetSetting: () => {},
  subscribeSetting: () => () => {},
}));
vi.mock('../../util/safeStorage', () => ({ safeStorage: { get: () => null, set: () => false, remove: () => {}, getJSON: <T,>(_k: string, f: T) => f, setJSON: () => false } }));

import { EXISTING_TOGGLE_COMMANDS, paletteCommands, settingToggleCommands } from '../index';
import { registerKeybindings, setChord } from '../../keys/registry';

beforeEach(() => values.clear());

const page = {} as EditorPageCtx;
const run = () => {};
const defs: CommandDef[] = [
  { id: 'everyone', title: 'Open the outline', group: 'View', run },
  { id: 'write', title: 'Insert a table', group: 'Insert', run, refusedFor: ['viewer', 'showcase'] },
  { id: 'edit-showcase', title: 'Rename the project', run, refusedFor: ['showcase'] },
  { id: 'later', title: 'Only with a page', run, when: (p) => p === page },
  { id: 'never', title: 'Not now', run, when: () => false },
  { id: 'cite', title: 'Insert citation…', run, keybinding: 'citations.insert', hint: 'stale' },
  { id: 'static', title: 'Find in this file…', run, hint: '⌘F', keywords: 'search' },
];
const listed = (o: { page: EditorPageCtx | null; showcase: boolean; viewer: boolean }) => paletteCommands(defs, o).map((c) => c.id);

describe('palette rows', () => {
  it('drops rows refused for the role and rows whose when() is false', () => {
    expect(listed({ page, showcase: false, viewer: false })).toEqual(['everyone', 'write', 'edit-showcase', 'later', 'cite', 'static']);
    expect(listed({ page, showcase: false, viewer: true })).toEqual(['everyone', 'edit-showcase', 'later', 'cite', 'static']);
    expect(listed({ page, showcase: true, viewer: true })).toEqual(['everyone', 'later', 'cite', 'static']);
    expect(listed({ page: null, showcase: false, viewer: false }), 'no page: rows that ask one are hidden').toEqual(['everyone', 'write', 'edit-showcase', 'cite', 'static']);
  });

  it('hides a row whose when() throws, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(paletteCommands([{ id: 'x', title: 'X', run, when: () => { throw new Error('no'); } }], { page, showcase: false, viewer: false })).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('fills the hint from the keybinding\'s current chord, nothing when it is cleared, and keeps a static hint', () => {
    const remove = registerKeybindings([{ id: 'citations.insert', label: 'Insert citation', group: 'Citations', default: { mod: true, shift: true, alt: false, key: 'e' }, changeable: true, scope: 'page', command: 'cite' }]);
    try {
      const rows = () => Object.fromEntries(paletteCommands(defs, { page, showcase: false, viewer: false }).map((c) => [c.id, c.hint]));
      expect(rows().cite).toMatch(/⇧⌘E|Ctrl\+Shift\+E/);
      expect(rows().static).toBe('⌘F');
      expect(rows().everyone).toBeUndefined();
      setChord('citations.insert', null);
      expect(rows().cite).toBeUndefined();
    } finally {
      setChord('citations.insert', { mod: true, shift: true, alt: false, key: 'e' });
      remove();
    }
  });

  it('gives plain palette rows: only the Command fields', () => {
    const [row] = paletteCommands([defs[1]], { page, showcase: false, viewer: false });
    expect(Object.keys(row).sort()).toEqual(['group', 'id', 'run', 'title']);
    const [kw] = paletteCommands([defs[6]], { page, showcase: false, viewer: false });
    expect(kw.keywords).toBe('search');
  });
});

const sw = (id: string, label: string, o: Partial<AnySettingDef> = {}): AnySettingDef => ({
  id, section: 'editor-behaviour', label, scope: 'account', default: false, validate: (v): v is boolean => typeof v === 'boolean', control: { kind: 'switch' }, palette: true, ...o,
});

describe('setting toggles', () => {
  it('turns every palette switch into "Turn … on/off" under setting.<id>, reading the value now', () => {
    values.set('editor.lineNumbers', true);
    const cmds = settingToggleCommands([sw('editor.lineNumbers', 'Line numbers'), sw('pdf.dark', 'PDF dark mode')]);
    expect(cmds.map((c) => [c.id, c.title, c.group])).toEqual([
      ['setting.editor.lineNumbers', 'Turn line numbers off', 'Settings'],
      ['setting.pdf.dark', 'Turn PDF dark mode on', 'Settings'],
    ]);
    cmds[1].run();
    expect(values.get('pdf.dark')).toBe(true);
    cmds[0].run();
    expect(values.get('editor.lineNumbers')).toBe(false);
  });

  it('skips settings that are not palette switches, project settings, and switches whose dependency is off', () => {
    values.set('highlighter.enabled', false);
    const cmds = settingToggleCommands([
      sw('a.notPalette', 'Not listed', { palette: false }),
      sw('a.slider', 'Strength', { control: { kind: 'slider', min: 0, max: 1, step: 0.1 } }),
      sw('a.project', 'Shared', { scope: 'project' }),
      sw('highlighter.paste', 'Pasted text keeps its highlights', { dependsOn: 'highlighter.enabled' }),
    ]);
    expect(cmds).toEqual([]);
  });

  it('never duplicates the toggles Editor.tsx already has (vim, spell, auto …)', () => {
    expect(EXISTING_TOGGLE_COMMANDS['editor.vim']).toBe('vim');
    expect(EXISTING_TOGGLE_COMMANDS['editor.spellcheck']).toBe('spell');
    const cmds = settingToggleCommands([sw('editor.vim', 'Vim keybindings'), sw('editor.spellcheck', 'Spellcheck'), sw('typesetting.auto', 'Typeset as I type')]);
    expect(cmds).toEqual([]);
  });

  it('keeps Vim and other proper nouns capitalised, and skips a setting it cannot read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cmds = settingToggleCommands([sw('labs.vimLike', 'Vim-style search'), sw('broken.setting', 'Broken'), sw('agents.claude', 'Claude edits marks')]);
    expect(cmds.map((c) => c.title)).toEqual(['Turn Vim-style search on', 'Turn Claude edits marks on']);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
