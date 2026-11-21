import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { fakeAccount, fakeWindow, memoryStorage, storageEvent } from './fakes';
import { CORE_SETTING_IDS, OPEN_SETTINGS_EVENT, TEST_DEFAULTS_KEY, type AnySettingDef } from '../types';

const { autoDef, projectDef } = vi.hoisted(() => {
  const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
  const autoDef: AnySettingDef = { id: 'escape.amp', section: 'typing', label: 'Escape &', scope: 'account', default: true, validate: isBool, control: { kind: 'switch' }, automatic: true };
  const projectDef: AnySettingDef = { id: 'outputs.keepBbl', section: 'files', label: 'Keep the .bbl', scope: 'project', default: false, validate: isBool, control: { kind: 'switch' } };
  return { autoDef, projectDef };
});

// Two definitions no core list has yet: an automatic switch and a project setting.
vi.mock('../registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../registry')>();
  const all = new Map(real.SETTINGS);
  for (const d of [autoDef, projectDef]) all.set(d.id, d);
  return { ...real, SETTINGS: all, settingDef: (id: string) => all.get(id) };
});

const ids = CORE_SETTING_IDS;
let storage: ReturnType<typeof memoryStorage>;

async function load(win = fakeWindow(storage)) {
  vi.stubGlobal('window', win);
  vi.resetModules();
  const store = await import('../store');
  return { store, win };
}

beforeEach(() => {
  storage = memoryStorage();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('device values', () => {
  it('reads each V1 key as V1 did, and never rewrites what it read', async () => {
    const stored: Record<string, string> = {
      'aldine.vim': 'junk', 'aldine.autoTypeset': 'junk', 'aldine.theme': 'sepia', 'aldine.pdfZoom': '9',
      'aldine.shortcuts': '{bad', 'aldine.layout': 'sideways', 'aldine.spellcheckLang': 'xx-XX', 'aldine.editorMode': 'VISUAL',
      'aldine.experimental.agentPresence': 'true', 'aldine.changeMarks': '0',
    };
    for (const [k, v] of Object.entries(stored)) storage.map.set(k, v);
    const setItem = vi.spyOn(storage, 'setItem');
    const removeItem = vi.spyOn(storage, 'removeItem');
    const { store } = await load();
    expect(store.getSetting(ids.vim)).toBe(false);
    expect(store.getSetting(ids.autoTypeset)).toBe(true);
    expect(store.getSetting(ids.theme)).toBe('system');
    expect(store.getSetting(ids.pdfZoom)).toBe(1);
    expect(store.getSetting(ids.shortcuts)).toEqual({});
    expect(store.getSetting(ids.layout)).toBe('');
    expect(store.getSetting(ids.spellLang)).toBe('');
    expect(store.getSetting(ids.editorMode)).toBe('source');
    expect(store.getSetting(ids.agentPresence)).toBe(false);
    expect(store.getSetting(ids.changeMarks)).toBe(false);
    expect(store.getSetting(ids.draftTypeset)).toBe(true);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(Object.fromEntries(storage.map)).toEqual(stored);
  });

  it('hands out the same value object until the stored text changes', async () => {
    storage.map.set('aldine.shortcuts', JSON.stringify({ typeset: { mod: true, shift: true, alt: false, key: 'y' } }));
    const { store } = await load();
    const a = store.getSetting(ids.shortcuts);
    expect(store.getSetting(ids.shortcuts)).toBe(a);
    storage.map.set('aldine.shortcuts', '{}');
    expect(store.getSetting(ids.shortcuts)).not.toBe(a);
  });

  it('writes a change to a V1 key in the text V1 wrote, defaults included', async () => {
    const { store } = await load();
    store.setSetting(ids.vim, true);
    expect(storage.map.get('aldine.vim')).toBe('1');
    store.setSetting(ids.vim, false);
    expect(storage.map.get('aldine.vim')).toBe('0');
    store.setSetting(ids.autoTypeset, false);
    expect(storage.map.get('aldine.autoTypeset')).toBe('0');
    store.setSetting(ids.autoTypeset, true);
    expect(storage.map.get('aldine.autoTypeset')).toBe('1');
    store.setSetting(ids.theme, 'dark');
    expect(storage.map.get('aldine.theme')).toBe('dark');
    store.setSetting(ids.theme, 'system');
    expect(storage.map.get('aldine.theme')).toBe('system');
    store.setSetting(ids.spellLang, 'de-DE');
    expect(storage.map.get('aldine.spellcheckLang')).toBe('de-DE');
    store.setSetting(ids.spellLang, '');
    expect(storage.map.has('aldine.spellcheckLang')).toBe(false);
    store.resetSetting(ids.vim);
    expect(storage.map.has('aldine.vim')).toBe(false);
    store.setSetting(ids.layout, 'pdf');
    expect(storage.map.get('aldine.layout')).toBe('pdf');
    store.setSetting(ids.pdfZoom, 1.5);
    expect(storage.map.get('aldine.pdfZoom')).toBe('1.5');
  });

  it('removes a JSON setting’s key when it goes back to the default', async () => {
    const { store } = await load();
    store.setSetting('appearance.scale', 110);
    expect(storage.map.get('aldine.appearance.scale')).toBe('110');
    expect(store.getSetting('appearance.scale')).toBe(110);
    store.setSetting('appearance.scale', 100);
    expect(storage.map.has('aldine.appearance.scale')).toBe(false);
    store.setSetting('pdf.dark', 'dim');
    expect(storage.map.get('aldine.pdf.dark')).toBe('"dim"');
    store.resetSetting('pdf.dark');
    expect(storage.map.has('aldine.pdf.dark')).toBe(false);
  });

  it('writes nothing when the value does not change, or when the validator refuses it', async () => {
    storage.map.set('aldine.vim', 'junk');
    const setItem = vi.spyOn(storage, 'setItem');
    const removeItem = vi.spyOn(storage, 'removeItem');
    const { store } = await load();
    store.setSetting(ids.vim, false);
    store.setSetting(ids.theme, 'sepia');
    store.setSetting('appearance.scale', 105);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(storage.map.get('aldine.vim')).toBe('junk');
  });

  it('keeps a value the browser refuses to store, for this page', async () => {
    storage.fail.set = true;
    const { store } = await load();
    store.setSetting(ids.theme, 'dark');
    expect(store.getSetting(ids.theme)).toBe('dark');
    expect(storage.map.has('aldine.theme')).toBe(false);
  });

  it('works on memory alone when site data is blocked', async () => {
    const { store } = await load(fakeWindow(storage, { blocked: true }));
    expect(store.getSetting(ids.autoTypeset)).toBe(true);
    store.setSetting(ids.autoTypeset, false);
    expect(store.getSetting(ids.autoTypeset)).toBe(false);
  });

  it('turns every automatic setting off while the legacy test flag is set', async () => {
    const { store } = await load();
    expect(store.getSetting(autoDef.id)).toBe(true);
    storage.map.set(TEST_DEFAULTS_KEY, 'automatic-off');
    expect(store.getSetting(autoDef.id)).toBe(false);
    store.setSetting(autoDef.id, true);
    expect(storage.map.get('aldine.escape.amp')).toBe('true');
    expect(store.getSetting(autoDef.id)).toBe(true);
    expect(store.getSetting(ids.autoTypeset)).toBe(true);
  });

  it('answers undefined for an id nobody registered, and writes nothing for it', async () => {
    const { store } = await load();
    expect(store.getSetting('nobody.here')).toBeUndefined();
    store.setSetting('nobody.here', 1);
    expect(storage.map.size).toBe(0);
  });
});

describe('subscribers and other tabs', () => {
  it('tells subscribers about this tab’s changes', async () => {
    const { store } = await load();
    const fn = vi.fn();
    const off = store.subscribeSetting([ids.vim, ids.theme], fn);
    store.setSetting(ids.vim, true);
    store.setSetting(ids.theme, 'light');
    store.setSetting(ids.autoTypeset, false);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    store.setSetting(ids.vim, false);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('follows another tab’s change live, and never sends it to the account', async () => {
    vi.useFakeTimers();
    const { store, win } = await load();
    const account = fakeAccount();
    const sync = store.__settingsTestHooks().startSync(account.transport);
    sync.setUser('u1');
    sync.setAvailable(true);
    await vi.advanceTimersByTimeAsync(1000);
    account.state.calls.length = 0;
    store.startLocalSettings();
    const fn = vi.fn();
    store.subscribeSetting(ids.theme, fn);
    storage.map.set('aldine.theme', 'light');
    win.dispatchEvent(storageEvent(storage, 'aldine.theme', 'light'));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.getSetting(ids.theme)).toBe('light');
    await vi.advanceTimersByTimeAsync(1000);
    expect(account.state.calls).toEqual([]);
    store.__settingsTestHooks().stop();
  });

  it('notifies every automatic setting when the test flag changes in another tab', async () => {
    const { store, win } = await load();
    store.startLocalSettings();
    const fn = vi.fn();
    store.subscribeSetting(autoDef.id, fn);
    storage.map.set(TEST_DEFAULTS_KEY, 'automatic-off');
    win.dispatchEvent(storageEvent(storage, TEST_DEFAULTS_KEY, 'automatic-off'));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.getSetting(autoDef.id)).toBe(false);
  });

  it('serves React through useSetting', async () => {
    storage.map.set('aldine.theme', 'dark');
    const { store } = await load();
    function Probe() { const [theme] = store.useSetting<string>(ids.theme); return createElement('span', null, theme); }
    expect(renderToString(createElement(Probe))).toContain('dark');
  });
});

describe('project settings', () => {
  function stubFetch(answers: Record<string, unknown>) {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url}`;
      const body = answers[key];
      if (body === undefined) return new Response(JSON.stringify({ error: 'no' }), { status: 404, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(typeof body === 'function' ? (body as (i?: RequestInit) => unknown)(init) : body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it('reads the open project’s values, its defaults until they arrive', async () => {
    const fetch = stubFetch({ 'GET /api/projects/p1/settings': { values: { [projectDef.id]: true, 'other.key': 1 }, rev: 3 } });
    const { store } = await load();
    const fn = vi.fn();
    store.subscribeSetting(projectDef.id, fn);
    expect(store.getSetting(projectDef.id)).toBe(false);
    store.setSettingsProject({ projectId: 'p1', canEdit: true });
    await vi.waitFor(() => expect(store.getSetting(projectDef.id)).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalled();
    expect(await store.refreshProjectSettings()).toEqual([]);
    store.setSettingsProject(null);
    expect(store.getSetting(projectDef.id)).toBe(false);
    expect(await store.refreshProjectSettings()).toEqual([]);
  });

  it('patches a change, and puts the old value back when the server refuses', async () => {
    let refuse = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method) return new Response(JSON.stringify({ values: {}, rev: 1 }), { status: 200 });
      if (refuse) return new Response(JSON.stringify({ error: 'Only members can change this' }), { status: 403 });
      const patch = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ values: patch.set ?? {}, rev: 2 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const { store } = await load();
    store.setSettingsProject({ projectId: 'p1', canEdit: true });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    store.setSetting(projectDef.id, true);
    expect(store.getSetting(projectDef.id)).toBe(true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1][0]).toBe('/api/projects/p1/settings');
    expect(JSON.parse(String(fetch.mock.calls[1][1]!.body))).toEqual({ set: { [projectDef.id]: true } });
    refuse = true;
    store.setSetting(projectDef.id, false);
    expect(store.getSetting(projectDef.id)).toBe(false);
    await vi.waitFor(() => expect(store.getSetting(projectDef.id)).toBe(true));
    expect(JSON.parse(String(fetch.mock.calls[2][1]!.body))).toEqual({ unset: [projectDef.id] });
  });

  it('sends nothing for someone who may not edit the project', async () => {
    const fetch = stubFetch({ 'GET /api/projects/p1/settings': { values: {}, rev: 1 } });
    const { store } = await load();
    store.setSettingsProject({ projectId: 'p1', canEdit: false });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    store.setSetting(projectDef.id, true);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.getSetting(projectDef.id)).toBe(false);
  });
});

describe('openSettings', () => {
  it('asks the page first, then loads the settings page itself', async () => {
    const { store, win } = await load();
    store.openSettings({ setting: ids.theme });
    expect(win.location.assign).toHaveBeenCalledWith('/settings/appearance#appearance.theme');
    const seen: unknown[] = [];
    win.addEventListener(OPEN_SETTINGS_EVENT, (e) => { seen.push((e as CustomEvent).detail); e.preventDefault(); });
    store.openSettings({ section: 'typing' });
    store.openSettings();
    expect(seen).toEqual([{ section: 'typing' }, null]);
    expect(win.location.assign).toHaveBeenCalledTimes(1);
  });
});
