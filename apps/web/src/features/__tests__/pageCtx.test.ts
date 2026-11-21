import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateFeatures, bootFeatures, commandAllowed, createEditorPageCtx, editorSubpage, enabledModules, featureCommandDefs,
  interceptFileRename, interceptProjectRename, isSettingsPath, parseFilesMoved, pinnedPluginPanels, plainPaletteRows,
  projectPathOf, readOnlyReason, remapPath, settingFromHash, settingsHref, settingsSection, type PageCtxSource,
} from '../pageCtx';
import type { AppCtx, EditorPageCtx, FeatureModule } from '../types';
import type { CommandDef } from '../../commands/types';

afterEach(() => { vi.restoreAllMocks(); });

const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

/** A page context over a source whose members are spies; `over` replaces some. */
function fakePage(over: Partial<PageCtxSource> = {}): { page: EditorPageCtx; src: PageCtxSource } {
  const src = {
    project: vi.fn(() => null), user: vi.fn(() => null), canEdit: vi.fn(() => true), showcase: vi.fn(() => false),
    activeFile: vi.fn(() => 'main.tex'), view: vi.fn(() => null), files: vi.fn(() => []), openFile: vi.fn(), insertAtCursor: vi.fn(),
    editDocument: vi.fn(), compile: vi.fn(), lastCompile: vi.fn(() => null), pdf: vi.fn(() => null),
    ui: { layout: vi.fn(() => 'both' as const), sidebarHidden: vi.fn(() => false), phone: vi.fn(() => false), showPanel: vi.fn() },
    peers: vi.fn(() => []), comments: vi.fn(() => []), toast: vi.fn(), confirm: vi.fn(async () => true), prompt: vi.fn(async () => null),
    openSettings: vi.fn(), refreshFiles: vi.fn(async () => {}), refreshProject: vi.fn(async () => {}),
    ...over,
  } as PageCtxSource;
  return { page: createEditorPageCtx('p1', 'main', () => src), src };
}

const mod = (m: Partial<FeatureModule> & { id: FeatureModule['id'] }): FeatureModule => m;

describe('enabledModules', () => {
  const all = [mod({ id: 'escape' }), mod({ id: '_probe' }), mod({ id: 'wordcount' })];
  it('leaves the probe out unless asked for, and keeps manifest order', () => {
    expect(enabledModules(all, false).map((m) => m.id)).toEqual(['escape', 'wordcount']);
    expect(enabledModules(all, true).map((m) => m.id)).toEqual(['escape', '_probe', 'wordcount']);
  });
});

describe('createEditorPageCtx', () => {
  it('reads the page as it is when a member is called, not when the context was made', () => {
    let file: string | null = 'a.tex';
    const { page } = fakePage({ activeFile: () => file });
    expect(page.activeFile()).toBe('a.tex');
    file = 'b.tex';
    expect(page.activeFile()).toBe('b.tex');
    expect(page.projectId).toBe('p1');
    expect(page.branch).toBe('main');
  });

  it('passes every call through to the source, the ui members included', async () => {
    const { page, src } = fakePage();
    page.openFile('ch1.tex', { line: 3 });
    page.compile({ clean: true });
    page.ui.showPanel('search', 'foo');
    page.toast('Hi', 'ok');
    page.openSettings({ section: 'typing' });
    await page.refreshFiles();
    expect(src.openFile).toHaveBeenCalledWith('ch1.tex', { line: 3 });
    expect(src.compile).toHaveBeenCalledWith({ clean: true });
    expect(src.ui.showPanel).toHaveBeenCalledWith('search', 'foo');
    expect(src.toast).toHaveBeenCalledWith('Hi', 'ok', undefined);
    expect(src.openSettings).toHaveBeenCalledWith({ section: 'typing' });
    expect(src.refreshFiles).toHaveBeenCalled();
    expect(page.ui.layout()).toBe('both');
  });

  it('has its own event emitter, and cannot be changed by a feature', () => {
    const { page } = fakePage();
    const fn = vi.fn();
    page.events.on('projectChanged', fn);
    page.events.emit('projectChanged', {});
    expect(fn).toHaveBeenCalledOnce();
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.ui)).toBe(true);
  });
});

describe('lifecycles', () => {
  it('activates every module in manifest order and undoes them in reverse, once', () => {
    const order: string[] = [];
    const modules = [
      mod({ id: 'escape', activate: () => { order.push('on:escape'); return () => order.push('off:escape'); } }),
      mod({ id: 'pairs' }),
      mod({ id: 'tables', activate: () => { order.push('on:tables'); return () => order.push('off:tables'); } }),
    ];
    const { page } = fakePage();
    const undo = activateFeatures(modules, page);
    expect(order).toEqual(['on:escape', 'on:tables']);
    undo();
    undo();
    expect(order).toEqual(['on:escape', 'on:tables', 'off:tables', 'off:escape']);
  });

  it('skips a module that throws while activating, booting or cleaning up', () => {
    const warn = quiet();
    const ran: string[] = [];
    const modules = [
      mod({ id: 'escape', activate: () => { throw new Error('no'); }, boot: () => { throw new Error('no'); } }),
      mod({ id: 'pairs', activate: () => () => { throw new Error('no'); }, boot: () => { ran.push('boot:pairs'); } }),
      mod({ id: 'tables', activate: () => { ran.push('on:tables'); return () => ran.push('off:tables'); } }),
    ];
    const { page } = fakePage();
    activateFeatures(modules, page)();
    bootFeatures(modules, {} as AppCtx);
    expect(ran).toEqual(['on:tables', 'off:tables', 'boot:pairs']);
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe('commands', () => {
  const run = vi.fn();
  const defs: CommandDef[] = [
    { id: 'a', title: 'Anyone', run },
    { id: 'v', title: 'Not for viewers', refusedFor: ['viewer'], run },
    { id: 's', title: 'Not in showcases', refusedFor: ['showcase'], run },
    { id: 'w', title: 'Only with a file', when: (p) => p.activeFile() !== null, run },
  ];
  const nobody = { showcase: false, viewer: false };

  it('collects every module commands for the page, skipping a module that throws', () => {
    quiet();
    const modules = [
      mod({ id: 'escape', commands: () => [defs[0]] }),
      mod({ id: 'pairs', commands: () => { throw new Error('no'); } }),
      mod({ id: 'tables', commands: (p) => [{ ...defs[1], title: `${defs[1].title} in ${p.projectId}` }] }),
    ];
    const { page } = fakePage();
    expect(featureCommandDefs(modules, page).map((d) => [d.id, d.title])).toEqual([['a', 'Anyone'], ['v', 'Not for viewers in p1']]);
  });

  it('hides a command from the role it is refused for, and while its `when` is false', () => {
    const { page } = fakePage();
    expect(defs.map((d) => commandAllowed(d, nobody, page))).toEqual([true, true, true, true]);
    expect(defs.map((d) => commandAllowed(d, { showcase: false, viewer: true }, page))).toEqual([true, false, true, true]);
    expect(defs.map((d) => commandAllowed(d, { showcase: true, viewer: false }, page))).toEqual([true, true, false, true]);
    const noFile = fakePage({ activeFile: () => null }).page;
    expect(commandAllowed(defs[3], nobody, noFile)).toBe(false);
  });

  it('treats a `when` that throws as false', () => {
    quiet();
    const { page } = fakePage();
    expect(commandAllowed({ id: 'x', title: 'X', run, when: () => { throw new Error('no'); } }, nobody, page)).toBe(false);
  });

  it('lists plain palette rows for the allowed commands only', () => {
    const { page } = fakePage();
    const rows = plainPaletteRows(defs, { showcase: true, viewer: true }, page);
    expect(rows.map((r) => r.id)).toEqual(['a', 'w']);
    rows[0].run();
    expect(run).toHaveBeenCalled();
    expect(Object.keys(rows[0]).sort()).toEqual(['group', 'hint', 'id', 'keywords', 'run', 'title']);
  });
});

describe('readOnlyReason', () => {
  it('gives the first reason any rule has, in manifest order, and null without a file', () => {
    quiet();
    const modules = [
      mod({ id: 'escape', readOnlyRules: [{ id: 'boom', reason: () => { throw new Error('no'); } }, { id: 'none', reason: () => null }] }),
      mod({ id: 'libraries', readOnlyRules: [{ id: 'bib', reason: (path) => (path.endsWith('.bib') ? 'Linked to Zotero' : null) }] }),
      mod({ id: 'references', readOnlyRules: [{ id: 'all', reason: () => 'Second' }] }),
    ];
    const { page } = fakePage();
    expect(readOnlyReason(modules, 'refs.bib', page)).toBe('Linked to Zotero');
    expect(readOnlyReason(modules, 'main.tex', page)).toBe('Second');
    expect(readOnlyReason(modules, null, page)).toBeNull();
    expect(readOnlyReason([], 'main.tex', page)).toBeNull();
  });
});

describe('interceptors', () => {
  it('stops at the first module that handles a file rename, and passes what it got', async () => {
    const seen: string[] = [];
    const modules = [
      mod({ id: 'escape', interceptors: { fileRename: async (r) => { seen.push(`escape:${r.via}`); return 'default'; } } }),
      mod({ id: 'rename', interceptors: { fileRename: async (r, p) => { seen.push(`rename:${r.from}>${r.to}@${p.projectId}`); return 'handled'; } } }),
      mod({ id: 'tables', interceptors: { fileRename: async () => { seen.push('tables'); return 'handled'; } } }),
    ];
    const { page } = fakePage();
    expect(await interceptFileRename(modules, { from: 'a.tex', to: 'b.tex', via: 'tree' }, page)).toBe('handled');
    expect(seen).toEqual(['escape:tree', 'rename:a.tex>b.tex@p1']);
  });

  it('falls back to the page default when nobody handles it or a module throws', async () => {
    quiet();
    const modules = [
      mod({ id: 'escape', interceptors: { projectRename: async () => { throw new Error('no'); } } }),
      mod({ id: 'pairs', interceptors: { projectRename: async () => 'default' } }),
      mod({ id: 'tables' }),
    ];
    expect(await interceptProjectRename(modules, { from: 'Old', to: 'New' }, null)).toBe('default');
    expect(await interceptProjectRename([], { from: 'Old', to: 'New' }, null)).toBe('default');
  });
});

describe('pinnedPluginPanels', () => {
  const Icon = () => null;
  it('puts the features panels after the core ones by order, each id once', () => {
    const core = [{ id: 'plugin:references', title: 'References', icon: Icon, order: 100 }, { id: 'plugin:zotero', title: 'Zotero', icon: Icon, order: 200 }];
    const modules = [
      mod({ id: 'libraries', pinnedPanels: [{ id: 'plugin:mendeley', title: 'Mendeley', icon: Icon, order: 300 }, { id: 'plugin:zotero', title: 'Again', icon: Icon, order: 1 }] }),
      mod({ id: 'refManagers', pinnedPanels: [{ id: 'plugin:early', title: 'Early', icon: Icon, order: 150 }] }),
    ];
    expect(pinnedPluginPanels(core, modules).map((p) => p.id)).toEqual(['plugin:references', 'plugin:early', 'plugin:zotero', 'plugin:mendeley']);
    expect(pinnedPluginPanels(core, []).map((p) => p.title)).toEqual(['References', 'Zotero']);
  });
});

describe('the files-moved signal', () => {
  it('reads a well-formed value and refuses anything else', () => {
    expect(parseFilesMoved({ moves: [['a.tex', 'b.tex']], by: 'Ada', at: 5 })).toEqual({ moves: [['a.tex', 'b.tex']], by: 'Ada', at: 5 });
    expect(parseFilesMoved({ moves: [['ch', 'chapters']] })).toEqual({ moves: [['ch', 'chapters']], by: null, at: 0 });
    for (const bad of [null, 3, 'x', {}, { moves: 'a' }, { moves: [['a']] }, { moves: [['a', '']] }, { moves: [['a', 2]] }]) {
      expect(parseFilesMoved(bad)).toBeNull();
    }
  });

  it('follows a file, a folder and a chain of moves', () => {
    expect(remapPath('a.tex', [['a.tex', 'b.tex']])).toBe('b.tex');
    expect(remapPath('ch/one.tex', [['ch', 'chapters']])).toBe('chapters/one.tex');
    expect(remapPath('chapter.tex', [['ch', 'chapters']])).toBe('chapter.tex');
    expect(remapPath('a.tex', [['a.tex', 'b.tex'], ['b.tex', 'c/b.tex']])).toBe('c/b.tex');
    expect(remapPath('main.tex', [])).toBe('main.tex');
  });
});

describe('the settings page addresses', () => {
  it('opens over the editor, keeping the branch, or at /settings', () => {
    expect(settingsHref({ section: 'project' }, '/p/abc', '?branch=draft')).toBe('/p/abc/settings/project?branch=draft');
    expect(settingsHref({ section: 'typing', setting: 'escape.auto' }, null)).toBe('/settings/typing#escape.auto');
    expect(settingsHref(undefined, null)).toBe('/settings');
    expect(settingsHref(null, '/p/abc')).toBe('/p/abc/settings');
  });

  it('reads the section from the path: desktop-app is the desktop section, unknown ones the first', () => {
    expect(settingsSection('editor-text')).toBe('editor-text');
    expect(settingsSection('desktop-app')).toBe('desktop');
    expect(settingsSection('nonsense')).toBeUndefined();
    expect(settingsSection(undefined)).toBeUndefined();
  });

  it('tells the editor from its settings page and from a subpath that does not exist', () => {
    expect(editorSubpage(undefined)).toEqual({ kind: 'editor' });
    expect(editorSubpage('')).toEqual({ kind: 'editor' });
    expect(editorSubpage('settings')).toEqual({ kind: 'settings', section: undefined });
    expect(editorSubpage('settings/')).toEqual({ kind: 'settings', section: undefined });
    expect(editorSubpage('settings/shortcuts')).toEqual({ kind: 'settings', section: 'shortcuts' });
    expect(editorSubpage('settings/shortcuts/more')).toEqual({ kind: 'unknown' });
    expect(editorSubpage('files')).toEqual({ kind: 'unknown' });
  });

  it('finds the project and the settings page in a router path, and the setting in a hash', () => {
    expect(projectPathOf('/p/abc')).toBe('/p/abc');
    expect(projectPathOf('/p/abc/settings/typing')).toBe('/p/abc');
    expect(projectPathOf('/settings')).toBeNull();
    expect(isSettingsPath('/settings')).toBe(true);
    expect(isSettingsPath('/settings/account')).toBe(true);
    expect(isSettingsPath('/p/abc/settings/typing')).toBe(true);
    expect(isSettingsPath('/p/abc')).toBe(false);
    expect(isSettingsPath('/settingsx')).toBe(false);
    expect(settingFromHash('#editor.fontSize')).toBe('editor.fontSize');
    expect(settingFromHash('#a%2Fb')).toBe('a/b');
    expect(settingFromHash('')).toBeUndefined();
  });
});
