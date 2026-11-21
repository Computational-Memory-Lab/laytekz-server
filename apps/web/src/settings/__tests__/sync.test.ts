import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAccount, fakeWindow, memoryStorage, storageEvent } from './fakes';
import { BACKUP_KEY, BASE_KEY, OWNER_KEY, PENDING_KEY, fitsPrefLimits, mergePrefs, type SettingsConflict } from '../sync';
import { CORE_SETTING_IDS, type AnySettingDef } from '../types';

const THEME = CORE_SETTING_IDS.theme;
const VIM = CORE_SETTING_IDS.vim;
const AUTO = CORE_SETTING_IDS.autoTypeset;

describe('mergePrefs', () => {
  const isStr = (v: unknown): v is string => typeof v === 'string';
  const def = (id: string, d = 'a'): AnySettingDef => ({ id, section: 'appearance', label: id, scope: 'account', default: d, validate: isStr, control: { kind: 'text' } });
  const defs = ['x.a', 'x.b', 'x.c', 'x.d', 'x.e'].map((id) => def(id));
  const merge = (local: Record<string, unknown>, remote: Record<string, unknown>, base: Record<string, unknown> | null, pending: string[] = []) => mergePrefs({
    defs, local: (id) => local[id] ?? 'a', defaultOf: (d) => d.default, remote, base, pending: new Set(pending),
  });

  it('takes what changed in the account, sends what changed here, and lets the account win when both did', () => {
    const m = merge(
      { 'x.a': 'b', 'x.b': 'local', 'x.c': 'mine', 'x.d': 'a' },
      { 'x.a': 'b', 'x.b': 'b', 'x.c': 'theirs', 'x.d': 'z' },
      { 'x.a': 'b', 'x.b': 'b', 'x.c': 'b', 'x.d': 'a' },
    );
    expect(m.take).toEqual([['x.c', 'theirs'], ['x.d', 'z']]);
    expect(m.set).toEqual({ 'x.b': 'local' });
    expect(m.unset).toEqual([]);
    expect(m.conflicts).toEqual(['x.c']);
    expect(m.backup).toEqual({ 'x.c': 'mine' });
  });

  it('sends a reset made here as an unset, and takes a reset made elsewhere as the default', () => {
    const m = merge({ 'x.a': 'a', 'x.b': 'b' }, { 'x.a': 'b' }, { 'x.a': 'b', 'x.b': 'b' });
    expect(m.unset).toEqual(['x.a']);
    expect(m.take).toEqual([['x.b', undefined]]);
  });

  it('with every default as the base (a first sync), seeds what the account lacks and never unsets', () => {
    const m = merge({ 'x.a': 'b', 'x.b': 'c' }, { 'x.b': 'd', 'x.c': 'e' }, {});
    expect(m.set).toEqual({ 'x.a': 'b' });
    expect(m.conflicts).toEqual(['x.b']);
    expect(m.take).toEqual([['x.b', 'd'], ['x.c', 'e']]);
    expect(m.unset).toEqual([]);
  });

  it('with the device as the base (another account), takes everything and sends nothing', () => {
    const m = merge({ 'x.a': 'b', 'x.b': 'c' }, { 'x.c': 'e' }, null);
    expect(m.take).toEqual([['x.a', undefined], ['x.b', undefined], ['x.c', 'e']]);
    expect(m.set).toEqual({});
    expect(m.conflicts).toEqual([]);
  });

  it('leaves alone a key this device is about to send, and treats an invalid account value as absent', () => {
    const m = merge({ 'x.a': 'b', 'x.b': 'b' }, { 'x.a': 'c', 'x.b': 42 }, { 'x.a': 'a', 'x.b': 'b' }, ['x.a']);
    expect(m.take).toEqual([['x.b', undefined]]);
    expect(m.conflicts).toEqual([]);
  });
});

describe('fitsPrefLimits', () => {
  it('holds values to 2 KB and three levels', () => {
    expect(fitsPrefLimits({ a: { b: { c: 1 } } })).toBe(true);
    expect(fitsPrefLimits({ a: { b: { c: { d: 1 } } } })).toBe(false);
    expect(fitsPrefLimits('x'.repeat(2100))).toBe(false);
  });
});

describe('account sync', () => {
  let storage: ReturnType<typeof memoryStorage>;
  let win: ReturnType<typeof fakeWindow>;

  async function start(account: ReturnType<typeof fakeAccount>, user = 'u1') {
    vi.resetModules();
    const store = await import('../store');
    const hooks = store.__settingsTestHooks();
    const sync = hooks.startSync(account.transport);
    const conflicts: SettingsConflict[] = [];
    sync.onConflict((c) => conflicts.push(c));
    sync.setAvailable(true);
    sync.setUser(user);
    await vi.advanceTimersByTimeAsync(1000);
    return { store, sync, conflicts, hooks };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    storage = memoryStorage();
    win = fakeWindow(storage);
    vi.stubGlobal('window', win);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    const store = await import('../store');
    store.__settingsTestHooks().stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('seeds a new account from this browser’s choices with keepExisting, and rewrites no key', async () => {
    storage.map.set('aldine.theme', 'dark');
    storage.map.set('aldine.vim', '1');
    storage.map.set('aldine.autoTypeset', 'junk');
    const account = fakeAccount();
    const { conflicts, sync } = await start(account);
    expect(account.state.patches).toEqual([{ set: { [THEME]: 'dark', [VIM]: true }, keepExisting: true }]);
    expect(account.state.prefs).toEqual({ [THEME]: 'dark', [VIM]: true });
    expect(storage.map.get(OWNER_KEY)).toBe('u1');
    expect(storage.map.get('aldine.autoTypeset')).toBe('junk');
    expect(storage.map.has(PENDING_KEY)).toBe(false);
    expect(conflicts).toEqual([]);
    expect(sync.status()).toBe('saved');
  });

  it('lets the account win a first-sync conflict, keeps this browser’s value, and puts it back on request', async () => {
    storage.map.set('aldine.theme', 'dark');
    const account = fakeAccount({ [THEME]: 'light' }, 4);
    const { conflicts, store } = await start(account);
    expect(store.getSetting(THEME)).toBe('light');
    expect(storage.map.get('aldine.theme')).toBe('light');
    expect(conflicts.map((c) => c.ids)).toEqual([[THEME]]);
    expect(JSON.parse(storage.map.get(BACKUP_KEY)!).values).toEqual({ [THEME]: 'dark' });
    expect(account.state.patches).toEqual([]);
    conflicts[0].keepBrowser();
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getSetting(THEME)).toBe('dark');
    expect(account.state.prefs[THEME]).toBe('dark');
    expect(storage.map.has(BACKUP_KEY)).toBe(false);
  });

  it('never seeds from another account’s browser: the new account only applies its own values', async () => {
    storage.map.set(OWNER_KEY, 'u1');
    storage.map.set('aldine.theme', 'dark');
    storage.map.set('aldine.vim', '1');
    const account = fakeAccount({ [VIM]: true }, 2);
    const { store, conflicts } = await start(account, 'u2');
    expect(account.state.patches).toEqual([]);
    expect(store.getSetting(THEME)).toBe('system');
    expect(storage.map.get('aldine.theme')).toBe('system');
    expect(storage.map.get('aldine.vim')).toBe('1');
    expect(storage.map.get(OWNER_KEY)).toBe('u2');
    expect(conflicts).toEqual([]);
  });

  it('takes a change made on another device, and a reset made there, without resurrecting it', async () => {
    const account = fakeAccount({ [THEME]: 'dark', [VIM]: true }, 1);
    const { store, sync } = await start(account);
    expect(store.getSetting(THEME)).toBe('dark');
    account.state.prefs = { [THEME]: 'light' };
    account.state.rev = 2;
    await sync.syncNow();
    expect(store.getSetting(THEME)).toBe('light');
    expect(store.getSetting(VIM)).toBe(false);
    expect(storage.map.get('aldine.vim')).toBe('0');
    expect(account.state.patches).toEqual([]);
  });

  it('asks with If-None-Match once it agrees with the account, and a 304 changes nothing', async () => {
    const account = fakeAccount({ [THEME]: 'dark' }, 7);
    const { sync } = await start(account);
    account.state.calls.length = 0;
    await sync.syncNow();
    expect(account.state.calls).toEqual(['GET "p7"']);
    expect(account.state.patches).toEqual([]);
  });

  it('sends this tab’s changes in one PATCH, 400 ms after the last one', async () => {
    const account = fakeAccount();
    const { store } = await start(account);
    store.setSetting(THEME, 'light');
    await vi.advanceTimersByTimeAsync(200);
    store.setSetting(THEME, 'dark');
    store.setSetting(VIM, true);
    await vi.advanceTimersByTimeAsync(399);
    expect(account.state.patches).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(account.state.patches).toEqual([{ set: { [THEME]: 'dark', [VIM]: true } }]);
    store.resetSetting(THEME);
    await vi.advanceTimersByTimeAsync(500);
    expect(account.state.patches[1]).toEqual({ unset: [THEME] });
    expect(account.state.prefs).toEqual({ [VIM]: true });
  });

  it('keeps changes queued while offline, across a reload, and sends them once the server answers', async () => {
    const account = fakeAccount();
    const first = await start(account);
    account.state.online = false;
    first.store.setSetting(AUTO, false);
    await vi.advanceTimersByTimeAsync(500);
    expect(first.sync.status()).toBe('offline');
    expect(JSON.parse(storage.map.get(PENDING_KEY)!)).toMatchObject({ user: 'u1', set: { [AUTO]: false } });
    first.hooks.stop();

    // A reload: a new store over the same storage, the network back.
    account.state.online = true;
    const second = await start(account);
    expect(account.state.prefs).toEqual({ [AUTO]: false });
    expect(storage.map.has(PENDING_KEY)).toBe(false);
    expect(second.store.getSetting(AUTO)).toBe(false);
    expect(second.sync.status()).toBe('saved');
  });

  it('retries by itself after going offline', async () => {
    const account = fakeAccount();
    const { store, sync } = await start(account);
    account.state.online = false;
    store.setSetting(VIM, true);
    await vi.advanceTimersByTimeAsync(500);
    expect(sync.status()).toBe('offline');
    account.state.online = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(account.state.prefs).toEqual({ [VIM]: true });
    expect(sync.status()).toBe('saved');
  });

  it('sends a change made while signed out at the next sign-in, when the account has not moved', async () => {
    const account = fakeAccount({ [THEME]: 'dark' }, 3);
    const first = await start(account);
    first.sync.setUser(null);
    first.store.setSetting(VIM, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(account.state.patches).toEqual([]);
    first.sync.setUser('u1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(account.state.patches).toEqual([{ set: { [VIM]: true } }]);
    expect(account.state.prefs).toEqual({ [THEME]: 'dark', [VIM]: true });
  });

  it('never unsets keys it does not know', async () => {
    const account = fakeAccount({ 'pet.enabled': true, [THEME]: 'dark' }, 1);
    const { store } = await start(account);
    store.resetSetting(THEME);
    await vi.advanceTimersByTimeAsync(500);
    expect(account.state.patches).toEqual([{ unset: [THEME] }]);
    expect(account.state.prefs).toEqual({ 'pet.enabled': true });
  });

  it('never sends a change another tab made', async () => {
    const account = fakeAccount();
    const { store } = await start(account);
    store.startLocalSettings();
    storage.map.set('aldine.vim', '1');
    win.dispatchEvent(storageEvent(storage, 'aldine.vim', '1'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.getSetting(VIM)).toBe(true);
    expect(account.state.patches).toEqual([]);
  });

  it('drops a value the account refuses, keeping it on this browser, and sends the rest', async () => {
    const account = fakeAccount();
    const { store, sync } = await start(account);
    account.state.refuseKey = VIM;
    store.setSetting(VIM, true);
    store.setSetting(THEME, 'dark');
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.getSetting(VIM)).toBe(true);
    expect(account.state.prefs).toEqual({ [THEME]: 'dark' });
    expect(storage.map.has(PENDING_KEY)).toBe(false);
    expect(sync.status()).toBe('saved');
  });

  it('stays on this browser while the server refuses this caller, and while the switch is off', async () => {
    const account = fakeAccount();
    account.state.status = 404;
    const { store, sync } = await start(account);
    expect(sync.status()).toBe('local');
    store.setSetting(VIM, true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(account.state.patches).toEqual([]);

    account.state.status = 0;
    sync.setEnabled(false);
    sync.setEnabled(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(account.state.prefs).toEqual({ [VIM]: true });
    sync.setEnabled(false);
    store.setSetting(THEME, 'light');
    await vi.advanceTimersByTimeAsync(1000);
    expect(account.state.prefs).toEqual({ [VIM]: true });
    expect(sync.status()).toBe('local');
  });

  it('reads the account again on focus, at most every 30 seconds', async () => {
    const account = fakeAccount();
    await start(account);
    account.state.calls.length = 0;
    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(10);
    expect(account.state.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(10);
    expect(account.state.calls.length).toBe(1);
  });

  it('tells the page’s status listeners, even ones that subscribed before sync started', async () => {
    vi.resetModules();
    const store = await import('../store');
    const fn = vi.fn();
    store.subscribeSyncStatus(fn);
    expect(store.getSyncStatus()).toBe('local');
    const account = fakeAccount();
    const sync = store.__settingsTestHooks().startSync(account.transport);
    sync.setAvailable(true);
    sync.setUser('u1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalled();
    expect(store.getSyncStatus()).toBe('saved');
  });

  it('keeps a conflict found before the page listened for its first listener', async () => {
    storage.map.set('aldine.theme', 'dark');
    const account = fakeAccount({ [THEME]: 'light' }, 1);
    vi.resetModules();
    const store = await import('../store');
    const sync = store.__settingsTestHooks().startSync(account.transport);
    sync.setAvailable(true);
    sync.setUser('u1');
    await vi.advanceTimersByTimeAsync(1000);
    const seen: string[][] = [];
    store.onSettingsConflict((c) => seen.push(c.ids));
    store.onSettingsConflict((c) => seen.push(['second', ...c.ids]));
    expect(seen).toEqual([[THEME]]);
    expect(JSON.parse(storage.map.get(BASE_KEY)!)).toMatchObject({ user: 'u1', rev: 1, prefs: { [THEME]: 'light' } });
  });
});
