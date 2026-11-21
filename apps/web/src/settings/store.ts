/**
 * The settings store (WP02 settings-core): every setting's effective value,
 * whatever its scope, with one way to read, change and watch it.
 *
 * - **Device and account scope** read the setting's device key (its
 *   `key`, default `aldine.<id>`, through its codec, default JSON). The key
 *   holds the effective value on this device, so the pre-paint script and an
 *   offline load need no network. A key is written only when the value
 *   changes: a V1 key in exactly the text V1 wrote, a JSON key removed when
 *   it goes back to its default (resetSetting removes either). A stored text
 *   the codec does not know reads as the default and is left as it is. A
 *   write the browser refuses (storage blocked, quota) lasts for this page.
 * - **Account scope** is also kept in the signed-in account (settings/sync.ts),
 *   which writes the device keys when the account changes elsewhere.
 * - **Project scope** is the open project's `ext` values (setSettingsProject,
 *   GET/PATCH /api/projects/:id/settings), the default until loaded.
 *
 * One `storage` listener keeps every tab in step (startSettings or
 * startLocalSettings). Readers that write a device key directly, without
 * setSetting, are read correctly but notify nobody in their own tab.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { apiRequest, onSessionUser, sessionUser, api } from '../api';
import { withBase } from '../basePath';
import { safeStorage, type SafeStore } from '../util/safeStorage';
import { JSON_CODEC, sameValue } from './codecs';
import { SETTINGS, settingDef } from './registry';
import { startApply } from './apply';
import { getCapabilities, loadCapabilities, subscribeCapabilities } from './capabilities';
import { createAccountSync, httpTransport, type AccountSync, type PrefsTransport, type SettingsConflict, type SyncStatus } from './sync';
import { settingsPath } from './url';
import {
  OPEN_SETTINGS_EVENT, TEST_DEFAULTS_KEY,
  type AnySettingDef, type ProjectSettingsPatch, type ProjectSettingsResponse, type SettingsTarget,
} from './types';

export type { SettingsConflict, SyncStatus } from './sync';

/** The `account.sync` switch (settings/registry/core.ts). */
const SYNC_SWITCH = 'account.sync';

// ---- device storage, with this page's memory for writes the browser refuses ----

/** `base` with a memory of its own: a value the browser refuses to store
 *  (blocked site data, a full quota) still reads back for this page. */
export function memoryBacked(base: () => SafeStore): SafeStore {
  const memory = new Map<string, string | null>();
  const get = (key: string): string | null => (memory.has(key) ? memory.get(key)! : base().get(key));
  const set = (key: string, value: string): boolean => {
    if (base().set(key, value)) { memory.delete(key); return true; }
    memory.set(key, value);
    return false;
  };
  return {
    get,
    set,
    remove(key) {
      base().remove(key);
      if (base().get(key) === null) memory.delete(key);
      else memory.set(key, null);
    },
    getJSON<T>(key: string, fallback: T, valid?: (v: unknown) => v is T): T {
      const raw = get(key);
      if (raw === null) return fallback;
      try {
        const v: unknown = JSON.parse(raw);
        return valid ? (valid(v) ? v : fallback) : (v as T);
      } catch {
        return fallback;
      }
    },
    setJSON(key, value) { return set(key, JSON.stringify(value)); },
    /** Another tab wrote `key`: what this page remembers of it is stale. */
    forget(key: string) { memory.delete(key); },
  } as SafeStore & { forget(key: string): void };
}

let backing: SafeStore = safeStorage;
const device = memoryBacked(() => backing) as SafeStore & { forget(key: string): void };

// ---- definitions ----

const keyOf = (def: AnySettingDef) => def.key ?? `aldine.${def.id}`;
const valid = (def: AnySettingDef, v: unknown): boolean => { try { return def.validate(v); } catch { return false; } };
const warned = new Set<string>();
function warnOnce(id: string, text: string): void {
  if (warned.has(`${id}:${text}`)) return;
  warned.add(`${id}:${text}`);
  console.warn(`Laytekz settings: ${id} ${text}`);
}

function lookup(id: string): AnySettingDef | undefined {
  const def = settingDef(id);
  if (!def) warnOnce(id, 'is not a registered setting');
  return def;
}

const testDefaults = () => device.get(TEST_DEFAULTS_KEY) === 'automatic-off';

/** A setting's default here: every `automatic` setting is off while the legacy e2e flag is set. */
export function defaultOf(def: AnySettingDef): unknown {
  return def.automatic && testDefaults() ? false : def.default;
}

let keyIndex: Map<string, string[]> | null = null;
function idsOfKey(key: string): string[] {
  if (!keyIndex) {
    keyIndex = new Map();
    for (const def of SETTINGS.values()) {
      if (def.scope === 'project') continue;
      const k = keyOf(def);
      keyIndex.set(k, [...(keyIndex.get(k) ?? []), def.id]);
    }
  }
  return keyIndex.get(key) ?? [];
}

// ---- subscribers ----

const listeners = new Map<string, Set<() => void>>();

function notify(ids: Iterable<string>): void {
  const fns = new Set<() => void>();
  for (const id of ids) for (const fn of listeners.get(id) ?? []) fns.add(fn);
  for (const fn of fns) {
    try { fn(); } catch (err) { console.warn('Laytekz settings: a subscriber failed', err); }
  }
}

/** Calls `fn` after any of `ids` changes, from this tab, another tab, the account or the project. */
export function subscribeSetting(ids: string | string[], fn: () => void): () => void {
  const list = typeof ids === 'string' ? [ids] : [...ids];
  for (const id of list) {
    let set = listeners.get(id);
    if (!set) listeners.set(id, (set = new Set()));
    set.add(fn);
  }
  return () => { for (const id of list) listeners.get(id)?.delete(fn); };
}

// ---- device and account values ----

interface Cached { raw: string | null; test: boolean; value: unknown }
const cache = new Map<string, Cached>();

function decodeRaw(def: AnySettingDef, raw: string | null, test: boolean): unknown {
  const dflt = def.automatic && test ? false : def.default;
  if (raw === null && def.automatic && test) return false;
  let v: unknown;
  try { v = (def.codec ?? JSON_CODEC).decode(raw); } catch { v = undefined; }
  return v !== undefined && valid(def, v) ? v : dflt;
}

/** Same text, same value object: React's useSyncExternalStore needs that. */
function deviceValue(def: AnySettingDef): unknown {
  const raw = device.get(keyOf(def));
  const test = !!def.automatic && testDefaults();
  const hit = cache.get(def.id);
  if (hit && hit.raw === raw && hit.test === test) return hit.value;
  const value = decodeRaw(def, raw, test);
  cache.set(def.id, { raw, test, value });
  return value;
}

/** A setting with a codec of its own (a V1 key) is written exactly as its
 *  codec encodes it, as V1 wrote it ('0' and '1', 'system'); a JSON setting's
 *  key is removed when the value is back at its default. */
function encodeValue(def: AnySettingDef, v: unknown): string | null {
  if (!def.codec) return sameValue(v, defaultOf(def)) ? null : JSON.stringify(v);
  try { return def.codec.encode(v); } catch { return null; }
}

function writeDevice(def: AnySettingDef, v: unknown): void {
  const raw = encodeValue(def, v);
  if (raw === null) device.remove(keyOf(def));
  else device.set(keyOf(def), raw);
}

/** The effective value of any setting (device, account or the open project's), its default until known. */
export function getSetting<T>(id: string): T {
  const def = lookup(id);
  if (!def) return undefined as T;
  return (def.scope === 'project' ? projectValue(def) : deviceValue(def)) as T;
}

/** Device and account scope; a project setting goes through useProjectSetting. */
export function setSetting<T>(id: string, v: T): void {
  const def = lookup(id);
  if (!def) return;
  if (def.scope === 'project') {
    // The page's setter reports failures; this path only logs them.
    void setProjectValue(def, v).catch((err) => console.warn(`Laytekz settings: ${id} was not saved`, err));
    return;
  }
  if (!valid(def, v)) { warnOnce(id, `refused the value ${JSON.stringify(v)}`); return; }
  if (sameValue(deviceValue(def), v)) return;
  writeDevice(def, v);
  notify([id]);
  if (def.scope === 'account') sync?.queue(id, sameValue(v, defaultOf(def)) ? undefined : v);
}

/** Back to the default: removes the device key and the account key. */
export function resetSetting(id: string): void {
  const def = lookup(id);
  if (!def) return;
  if (def.scope === 'project') {
    void setProjectValue(def, def.default).catch((err) => console.warn(`Laytekz settings: ${id} was not reset`, err));
    return;
  }
  const before = deviceValue(def);
  device.remove(keyOf(def));
  if (!sameValue(before, deviceValue(def))) notify([id]);
  if (def.scope === 'account') sync?.queue(id, undefined);
}

/** The account's value reached this device: write it (undefined: the default) without sending it back. */
function takeAccountValue(id: string, v: unknown): void {
  const def = settingDef(id);
  if (!def || def.scope !== 'account') return;
  const target = v === undefined || !valid(def, v) ? defaultOf(def) : v;
  if (sameValue(deviceValue(def), target)) return;
  writeDevice(def, target);
  notify([id]);
}

export function useSetting<T>(id: string): [T, (v: T) => void] {
  const subscribe = useCallback((fn: () => void) => subscribeSetting(id, fn), [id]);
  const get = useCallback(() => getSetting<T>(id), [id]);
  const value = useSyncExternalStore(subscribe, get, get);
  const set = useCallback((v: T) => setSetting(id, v), [id]);
  return [value, set];
}

// ---- project scope ----

let project: { projectId: string; canEdit: boolean } | null = null;
let projectValues: Record<string, unknown> = {};

const projectDefs = () => [...SETTINGS.values()].filter((d) => d.scope === 'project');
const projectUrl = (id: string) => `/api/projects/${encodeURIComponent(id)}/settings`;

function projectValue(def: AnySettingDef): unknown {
  const v = projectValues[def.id];
  return v !== undefined && valid(def, v) ? v : defaultOf(def);
}

function adoptProject(r: ProjectSettingsResponse): string[] {
  const next: Record<string, unknown> = {};
  const values = r && typeof r.values === 'object' && r.values ? r.values : {};
  for (const def of projectDefs()) if (Object.prototype.hasOwnProperty.call(values, def.id) && valid(def, values[def.id])) next[def.id] = values[def.id];
  const before = projectValues;
  projectValues = next;
  const changed = projectDefs().filter((d) => !sameValue(before[d.id], next[d.id])).map((d) => d.id);
  notify(changed);
  return changed;
}

/** The editor page's project for project-scope settings; null when no editor
 *  page is open. Called by the page host (WP06). */
export function setSettingsProject(p: { projectId: string; canEdit: boolean } | null): void {
  const ids = projectDefs().map((d) => d.id);
  if (p && project && p.projectId === project.projectId) {
    if (p.canEdit !== project.canEdit) { project = { ...p }; notify(ids); }
    return;
  }
  project = p ? { projectId: p.projectId, canEdit: p.canEdit } : null;
  projectValues = {};
  notify(ids);
  if (project) void refreshProjectSettings();
}

/** Refetches the open project's settings; resolves with the ids whose value
 *  changed. The page host calls it on the branch signal 'settings' and then
 *  emits `projectSettingsChanged`. Never rejects. */
export async function refreshProjectSettings(): Promise<string[]> {
  const p = project;
  // No project-scope setting is defined: nothing to ask the server for.
  if (!p || !projectDefs().length) return [];
  try {
    const r = await apiRequest<ProjectSettingsResponse>(projectUrl(p.projectId));
    return project === p ? adoptProject(r) : [];
  } catch {
    return [];
  }
}

async function setProjectValue(def: AnySettingDef, v: unknown): Promise<void> {
  const p = project;
  if (!p) throw new Error('Open a project to change its settings.');
  if (!p.canEdit) throw new Error('Only the project’s editors can change its settings.');
  if (!valid(def, v)) throw new Error(`That value isn’t allowed for “${def.label}”.`);
  const unset = sameValue(v, def.default);
  if (sameValue(projectValue(def), v) && unset === !(def.id in projectValues)) return;
  const before = projectValues[def.id];
  projectValues = { ...projectValues };
  if (unset) delete projectValues[def.id]; else projectValues[def.id] = v;
  notify([def.id]);
  const body: ProjectSettingsPatch = unset ? { unset: [def.id] } : { set: { [def.id]: v } };
  try {
    const r = await apiRequest<ProjectSettingsResponse>(projectUrl(p.projectId), { method: 'PATCH', body: JSON.stringify(body) });
    if (project === p) adoptProject(r);
  } catch (err) {
    if (project === p) {
      projectValues = { ...projectValues };
      if (before === undefined) delete projectValues[def.id]; else projectValues[def.id] = before;
      notify([def.id]);
    }
    throw err;
  }
}

/** The open project's value (see setSettingsProject), a setter that PATCHes it, and whether this person may. */
export function useProjectSetting<T>(id: string): [T, (v: T) => Promise<void>, { canEdit: boolean }] {
  const subscribe = useCallback((fn: () => void) => subscribeSetting(id, fn), [id]);
  const get = useCallback(() => getSetting<T>(id), [id]);
  const value = useSyncExternalStore(subscribe, get, get);
  const canEdit = useSyncExternalStore(subscribe, () => !!project?.canEdit, () => false);
  const set = useCallback((v: T) => {
    const def = lookup(id);
    return def && def.scope === 'project' ? setProjectValue(def, v) : Promise.reject(new Error(`${id} is not a project setting.`));
  }, [id]);
  return [value, set, { canEdit }];
}

// ---- tabs, account, start ----

function onStorage(e: StorageEvent): void {
  try {
    if (e.storageArea && typeof window !== 'undefined' && e.storageArea !== window.localStorage) return;
  } catch { /* storage blocked: the event cannot be ours to compare */ }
  if (e.key === null) { notify(SETTINGS.keys()); return; }
  device.forget(e.key);
  if (e.key === TEST_DEFAULTS_KEY) { notify([...SETTINGS.values()].filter((d) => d.automatic).map((d) => d.id)); return; }
  const ids = idsOfKey(e.key);
  if (ids.length) notify(ids);
}

let localStarted = false;

/** This tab follows other tabs' changes and the page shows the appearance
 *  settings (settings/apply.ts); no network. startSettings includes it;
 *  theme.ts's startThemeSync calls only this. Once per tab. */
export function startLocalSettings(): void {
  if (localStarted || typeof window === 'undefined') return;
  localStarted = true;
  window.addEventListener('storage', onStorage);
  startApply((id) => getSetting(id), (ids, fn) => subscribeSetting(ids, fn));
}

let sync: AccountSync | null = null;
let started = false;

function createSync(transport: PrefsTransport): AccountSync {
  return connect(createAccountSync({
    storage: device,
    defs: () => [...SETTINGS.values()],
    local: (id) => getSetting(id),
    defaultOf,
    take: takeAccountValue,
    setLocal: (id, v) => setSetting(id, v),
    transport,
  }));
}

/** Once per tab, from main.tsx: storage listener, account sync, apply. */
export function startSettings(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  startLocalSettings();
  const s = (sync = createSync(httpTransport));
  s.setEnabled(getSetting<boolean>(SYNC_SWITCH) !== false);
  subscribeSetting(SYNC_SWITCH, () => s.setEnabled(getSetting<boolean>(SYNC_SWITCH) !== false));
  subscribeCapabilities(() => s.setAvailable(getCapabilities().prefs === true));
  void loadCapabilities().then((c) => s.setAvailable(c.prefs === true));
  onSessionUser((id) => s.setUser(id));
  const known = sessionUser();
  if (known !== undefined) s.setUser(known);
  else {
    // The auth provider asks /api/auth/me as the page starts; a page without
    // one (an error screen) still gets the account, a little later.
    setTimeout(() => { if (sessionUser() === undefined) api.me().catch(() => { /* no session: settings stay local */ }); }, 3000);
  }
}

const statusListeners = new Set<() => void>();
const conflictListeners = new Set<(c: SettingsConflict) => void>();
let heldConflict: SettingsConflict | null = null;

/** Forwards one sync's status and conflicts to the page's listeners, whenever they subscribed. */
function connect(s: AccountSync): AccountSync {
  s.subscribeStatus(() => { for (const fn of [...statusListeners]) fn(); });
  s.onConflict((c) => {
    if (conflictListeners.size) for (const fn of [...conflictListeners]) fn(c);
    else heldConflict = c;
  });
  return s;
}

/** Where account sync stands: 'local' while settings stay on this browser. */
export function getSyncStatus(): SyncStatus {
  return sync?.status() ?? 'local';
}

export function subscribeSyncStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => { statusListeners.delete(fn); };
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus);
}

/** The account replaced this browser's values for some settings at sign-in
 *  (the page shows "Keep this browser's"). A conflict found before anyone
 *  listened goes to the first listener. */
export function onSettingsConflict(fn: (c: SettingsConflict) => void): () => void {
  conflictListeners.add(fn);
  if (heldConflict) { const c = heldConflict; heldConflict = null; fn(c); }
  return () => { conflictListeners.delete(fn); };
}

/** Reads the account now, after sending what is queued (the page's "Sync now"). */
export function syncSettingsNow(): Promise<void> {
  return sync ? sync.syncNow() : Promise.resolve();
}

/** Dispatches OPEN_SETTINGS_EVENT; loads /settings/<section> when nobody handles it. */
export function openSettings(t?: SettingsTarget): void {
  if (typeof window === 'undefined') return;
  const detail: SettingsTarget | null = t ? { ...t } : null;
  const ev = new CustomEvent<SettingsTarget | null>(OPEN_SETTINGS_EVENT, { detail, cancelable: true });
  if (window.dispatchEvent(ev)) window.location.assign(withBase(settingsPath(detail)));
}

/** Test seam: a fresh store over `storage`, with the account reached through `transport`. */
export function __settingsTestHooks(o: { storage?: SafeStore; transport?: PrefsTransport } = {}) {
  if (o.storage) backing = o.storage;
  cache.clear();
  return {
    device,
    sync: () => sync,
    startSync(transport: PrefsTransport): AccountSync {
      sync?.stop();
      sync = createSync(transport);
      return sync;
    },
    stop() { sync?.stop(); sync = null; },
  };
}
