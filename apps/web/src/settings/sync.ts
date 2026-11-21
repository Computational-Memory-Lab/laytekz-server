/**
 * Account sync (WP02 settings-core): keeps the account-scope settings of this
 * browser and of the signed-in account in step, through
 * GET/PATCH /api/account/preferences (plan §2.5).
 *
 * The device keys always hold the effective values (the store reads only
 * them), so this module's whole job is a three-way merge: the device's
 * values, the account's, and the "base" (what both agreed on at the last
 * sync, kept in `aldine.settingsBase`). Per setting:
 *
 * - device = base: the account's value is taken (a change on another device);
 * - account = base: the device's value is sent (a change made here while not
 *   syncing: signed out, offline before the queue existed, sync switched off);
 * - both moved apart: the account wins, the device's value is kept in
 *   `aldine.settingsBackup`, and a conflict is reported so the page can offer
 *   "Keep this browser's".
 *
 * On the first sync of this browser (no `aldine.settingsOwner`) the base is
 * every default, so the device's non-default values seed the account with
 * `keepExisting`. A different account signing in here never seeds: its base
 * is the device itself, so it only takes its own values.
 *
 * Changes made in this tab while syncing go into `aldine.settingsPending`
 * (persisted, so a reload while offline keeps them) and are sent in one PATCH
 * 400 ms after the last change; the merge never overrides a pending key.
 * Changes that arrive from another tab by a `storage` event are never sent
 * again: only the tab where the change was made sends it. The account is
 * read again on focus (at most every 30 s) and every 10 minutes while the tab
 * is visible, with `If-None-Match`, so an unchanged account costs a 304.
 */
import { apiRequest } from '../api';
import { withBase } from '../basePath';
import type { SafeStore } from '../util/safeStorage';
import { sameValue } from './codecs';
import { PREF_KEY_RE, PREF_LIMITS, type AccountPrefsPatch, type AccountPrefsResponse, type AnySettingDef } from './types';

export const OWNER_KEY = 'aldine.settingsOwner';
export const BASE_KEY = 'aldine.settingsBase';
export const PENDING_KEY = 'aldine.settingsPending';
export const BACKUP_KEY = 'aldine.settingsBackup';

export const FLUSH_DELAY_MS = 400;
export const FOCUS_MIN_MS = 30_000;
export const POLL_MS = 10 * 60_000;
const RETRY_MAX_MS = 60_000;

/** 'local': settings stay on this browser (no accounts, signed out, or the switch is off). */
export type SyncStatus = 'local' | 'saving' | 'saved' | 'offline' | 'error';

export interface SettingsConflict {
  /** The settings whose account value replaced this browser's. */
  ids: string[];
  /** Puts this browser's values back, and sends them to the account. */
  keepBrowser(): void;
}

export type PrefsGetResult = { status: 200; body: AccountPrefsResponse } | { status: 304 } | { status: number };

export interface PrefsTransport {
  /** Rejects only when the server was not reached. */
  get(etag: string | null): Promise<PrefsGetResult>;
  /** Rejects with an ApiError (status 0: not reached). */
  patch(body: AccountPrefsPatch): Promise<AccountPrefsResponse>;
}

export const httpTransport: PrefsTransport = {
  async get(etag) {
    const res = await fetch(withBase('/api/account/preferences'), {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: etag ? { 'if-none-match': etag } : undefined,
    });
    if (res.status === 304) return { status: 304 };
    if (!res.ok) return { status: res.status };
    return { status: 200, body: (await res.json()) as AccountPrefsResponse };
  },
  patch: (body) => apiRequest<AccountPrefsResponse>('/api/account/preferences', { method: 'PATCH', body: JSON.stringify(body) }),
};

export interface SyncHost {
  /** Where the sync keeps its own keys (the device's localStorage). */
  storage: SafeStore;
  /** Every account-scope setting. */
  defs(): readonly AnySettingDef[];
  /** A setting's effective value on this device. */
  local(id: string): unknown;
  defaultOf(def: AnySettingDef): unknown;
  /** Makes the device hold the account's value (undefined: the default), without sending anything. */
  take(id: string, value: unknown): void;
  /** Changes a setting as the person would (device, then the account). */
  setLocal(id: string, value: unknown): void;
  transport: PrefsTransport;
}

interface Base { user: string; rev: number; prefs: Record<string, unknown> }
interface Pending { user: string; set: Record<string, unknown>; unset: string[]; seed: string[] }

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const valid = (def: AnySettingDef, v: unknown): boolean => { try { return def.validate(v); } catch { return false; } };

function depth(v: unknown): number {
  if (v === null || typeof v !== 'object') return 0;
  const kids = Array.isArray(v) ? v : Object.values(v as object);
  return 1 + kids.reduce<number>((m, k) => Math.max(m, depth(k)), 0);
}

/** A value the server's limits accept (PREF_LIMITS): its JSON text size and nesting. */
export function fitsPrefLimits(v: unknown): boolean {
  const text = JSON.stringify(v);
  return text !== undefined && new TextEncoder().encode(text).length <= PREF_LIMITS.valueBytes && depth(v) <= PREF_LIMITS.valueDepth;
}

/** The account-scope settings the server can store under their own id. */
export function syncable(defs: readonly AnySettingDef[]): AnySettingDef[] {
  return defs.filter((d) => d.scope === 'account' && PREF_KEY_RE.test(d.id));
}

export interface MergeInput {
  defs: readonly AnySettingDef[];
  local(id: string): unknown;
  defaultOf(def: AnySettingDef): unknown;
  remote: Record<string, unknown>;
  /** null: the device is the base (another account signs in here: take everything). */
  base: Record<string, unknown> | null;
  /** Keys this device is about to send: left alone. */
  pending: ReadonlySet<string>;
}

export interface MergeResult {
  /** [id, the account's value or undefined for "the default"]. */
  take: [string, unknown][];
  set: Record<string, unknown>;
  unset: string[];
  conflicts: string[];
  /** The device's values the account replaced, by id. */
  backup: Record<string, unknown>;
}

/** The three-way merge described at the top of this file. Pure. */
export function mergePrefs(m: MergeInput): MergeResult {
  const out: MergeResult = { take: [], set: {}, unset: [], conflicts: [], backup: {} };
  for (const def of m.defs) {
    const id = def.id;
    if (m.pending.has(id)) continue;
    const dflt = m.defaultOf(def);
    const L = m.local(id);
    const hasR = has(m.remote, id) && valid(def, m.remote[id]);
    const R = hasR ? m.remote[id] : dflt;
    const B = m.base === null ? L : has(m.base, id) && valid(def, m.base[id]) ? m.base[id] : dflt;
    if (sameValue(L, R)) continue;
    if (sameValue(L, B)) out.take.push([id, hasR ? R : undefined]);
    else if (sameValue(R, B)) {
      if (sameValue(L, dflt)) out.unset.push(id);
      else out.set[id] = L;
    } else {
      out.conflicts.push(id);
      out.backup[id] = L;
      out.take.push([id, hasR ? R : undefined]);
    }
  }
  return out;
}

function readJSON<T>(s: SafeStore, key: string, ok: (v: unknown) => v is T): T | null {
  return s.getJSON<T | null>(key, null, (v): v is T | null => v === null || ok(v));
}
/** An ApiError's parts, read by shape (status 0: the server was not reached). */
function httpError(err: unknown): { status: number; retryAfter?: number; body?: Record<string, unknown> } {
  const e = err as { status?: unknown; retryAfter?: unknown; body?: unknown } | null;
  return {
    status: e && typeof e.status === 'number' ? e.status : 0,
    retryAfter: e && typeof e.retryAfter === 'number' ? e.retryAfter : undefined,
    body: e && e.body && typeof e.body === 'object' ? (e.body as Record<string, unknown>) : undefined,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isBase = (v: unknown): v is Base => isObj(v) && typeof v.user === 'string' && typeof v.rev === 'number' && isObj(v.prefs);
const isPending = (v: unknown): v is Pending => isObj(v) && typeof v.user === 'string' && isObj(v.set)
  && Array.isArray(v.unset) && v.unset.every((x) => typeof x === 'string') && Array.isArray(v.seed) && v.seed.every((x) => typeof x === 'string');
const isPrefsResponse = (v: unknown): v is AccountPrefsResponse => isObj(v) && isObj(v.prefs) && typeof v.rev === 'number';

export interface AccountSync {
  /** The signed-in account (null: nobody), whether the server offers sync to it, and the switch. */
  setUser(id: string | null): void;
  setAvailable(prefs: boolean): void;
  setEnabled(on: boolean): void;
  /** This tab changed `id` (undefined: back to the default). Ignored while not syncing. */
  queue(id: string, value: unknown): void;
  /** Reads the account now (after sending what is queued). */
  syncNow(): Promise<void>;
  status(): SyncStatus;
  subscribeStatus(fn: () => void): () => void;
  /** Conflicts as they happen; a conflict found before anyone listened goes to the first listener. */
  onConflict(fn: (c: SettingsConflict) => void): () => void;
  /** Stops timers and listeners (tests, and a page that unloads the store). */
  stop(): void;
}

export function createAccountSync(host: SyncHost): AccountSync {
  const { storage, transport } = host;
  let user: string | null = null;
  let available = false;
  let enabled = true;
  let status: SyncStatus = 'local';
  /** The server refused this caller (401, 403, 404): nothing more is sent until the account, the answer or the switch changes. */
  let refused = false;
  let generation = 0;
  let pulledAt = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryMs = 2000;
  let chain: Promise<void> = Promise.resolve();
  let lastConflict: SettingsConflict | null = null;
  /** Keys the account refused (400): they stay on this browser until changed again; the
   *  merge treats them as about to be sent, so it neither resends nor overwrites them. */
  const refusedIds = new Set<string>();
  const statusListeners = new Set<() => void>();
  const conflictListeners = new Set<(c: SettingsConflict) => void>();
  const disposers: (() => void)[] = [];

  const active = () => available && enabled && !refused && typeof user === 'string';
  const defs = () => syncable(host.defs());

  function setStatus(s: SyncStatus): void {
    if (s === status) return;
    status = s;
    for (const fn of [...statusListeners]) fn();
  }

  const readBase = (): Base | null => { const b = readJSON(storage, BASE_KEY, isBase); return b && b.user === user ? b : null; };
  const emptyPending = (): Pending => ({ user: user ?? '', set: {}, unset: [], seed: [] });
  const readPending = (): Pending => { const p = readJSON(storage, PENDING_KEY, isPending); return p && p.user === user ? p : emptyPending(); };
  const pendingIds = (p: Pending) => new Set([...Object.keys(p.set), ...p.unset, ...refusedIds]);
  const writePending = (p: Pending) => { if (Object.keys(p.set).length || p.unset.length) storage.setJSON(PENDING_KEY, p); else storage.remove(PENDING_KEY); };

  /** One network task at a time, in order; a task from before a sign-out or account switch is dropped. */
  function run(task: () => Promise<void>): Promise<void> {
    const gen = generation;
    const next = chain.then(() => (gen === generation && active() ? task() : undefined)).catch((err) => { console.warn('Laytekz settings sync:', err); });
    chain = next;
    return next;
  }

  function tooLarge(id: string): void {
    refusedIds.add(id);
    console.warn(`Laytekz settings sync: ${id} is too large for the account, kept on this browser`);
  }

  function retryLater(ms?: number): void {
    if (retryTimer) clearTimeout(retryTimer);
    const wait = ms ?? retryMs;
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    retryTimer = setTimeout(() => { retryTimer = null; void run(pull); }, wait);
  }

  /** Base after a merge: the device's values, except for keys still to be sent, which keep the account's. */
  function baseFrom(remote: AccountPrefsResponse, pending: ReadonlySet<string>): Base {
    const prefs: Record<string, unknown> = {};
    for (const def of defs()) {
      if (pending.has(def.id)) { if (has(remote.prefs, def.id)) prefs[def.id] = remote.prefs[def.id]; continue; }
      const v = host.local(def.id);
      if (!sameValue(v, host.defaultOf(def))) prefs[def.id] = v;
    }
    return { user: user!, rev: remote.rev, prefs };
  }

  function report(conflicts: string[], backup: Record<string, unknown>): void {
    if (!conflicts.length) return;
    storage.setJSON(BACKUP_KEY, { at: new Date().toISOString(), values: backup });
    const c: SettingsConflict = {
      ids: conflicts,
      keepBrowser() {
        for (const id of conflicts) if (has(backup, id)) host.setLocal(id, backup[id]);
        storage.remove(BACKUP_KEY);
        if (lastConflict === c) lastConflict = null;
      },
    };
    if (conflictListeners.size) for (const fn of [...conflictListeners]) fn(c);
    else lastConflict = c;
  }

  /** Merges an account answer into the device; returns what this device must send. */
  function adopt(remote: AccountPrefsResponse, mode: 'normal' | 'seed' | 'adopt'): void {
    const pending = readPending();
    const ids = pendingIds(pending);
    const base = mode === 'adopt' ? null : mode === 'seed' ? {} : readBase()?.prefs ?? {};
    const m = mergePrefs({ defs: defs(), local: host.local, defaultOf: host.defaultOf, remote: remote.prefs, base, pending: ids });
    for (const [id, v] of m.take) host.take(id, v);
    let queued = false;
    for (const [id, v] of Object.entries(m.set)) {
      if (!fitsPrefLimits(v)) { tooLarge(id); ids.add(id); continue; }
      pending.set[id] = v;
      if (mode === 'seed') pending.seed.push(id);
      ids.add(id);
      queued = true;
    }
    for (const id of m.unset) { pending.unset.push(id); ids.add(id); queued = true; }
    if (queued) writePending(pending);
    storage.setJSON(BASE_KEY, baseFrom(remote, ids));
    if (user) storage.set(OWNER_KEY, user);
    report(m.conflicts, m.backup);
  }

  function modeNow(): 'normal' | 'seed' | 'adopt' {
    const owner = storage.get(OWNER_KEY);
    if (owner === null) return 'seed';
    if (owner !== user) return 'adopt';
    return readBase() ? 'normal' : 'seed';
  }

  function failed(err: unknown): 'retry' | 'stop' | 'drop' {
    const s = httpError(err).status;
    if (s === 0 || s >= 500) { setStatus(s === 0 ? 'offline' : 'error'); retryLater(); return 'retry'; }
    if (s === 429) { setStatus('error'); const after = httpError(err).retryAfter; retryLater(after ? after * 1000 : undefined); return 'retry'; }
    if (s === 401 || s === 403 || s === 404) { refused = true; setStatus('local'); return 'stop'; }
    setStatus('error');
    return 'drop';
  }

  async function flush(): Promise<void> {
    const gen = generation;
    const p = readPending();
    const seedSet: Record<string, unknown> = {};
    const set: Record<string, unknown> = {};
    for (const [id, v] of Object.entries(p.set)) (p.seed.includes(id) ? seedSet : set)[id] = v;
    if (!Object.keys(seedSet).length && !Object.keys(set).length && !p.unset.length) return;
    setStatus('saving');
    let reply: AccountPrefsResponse | null = null;
    const sent = { set: { ...p.set }, unset: [...p.unset] };
    try {
      if (Object.keys(seedSet).length) reply = await transport.patch({ set: seedSet, keepExisting: true });
      if (Object.keys(set).length || p.unset.length) reply = await transport.patch({ ...(Object.keys(set).length ? { set } : {}), ...(p.unset.length ? { unset: p.unset } : {}) });
    } catch (err) {
      if (gen !== generation) return;
      const what = failed(err);
      if (what !== 'drop') return;
      // A refusal (400: a key or a value the server will never accept) would
      // fail the same way forever: the named key, or else the whole batch, stays on this browser only.
      const named = httpError(err).body?.key;
      const key = typeof named === 'string' ? named : null;
      const now = readPending();
      for (const id of key ? [key] : [...Object.keys(sent.set), ...sent.unset]) {
        refusedIds.add(id);
        delete now.set[id];
        now.unset = now.unset.filter((x) => x !== id);
        now.seed = now.seed.filter((x) => x !== id);
      }
      writePending(now);
      console.warn('Laytekz settings sync: the account refused', key ?? 'the change', err);
      if (key) scheduleFlush();
      return;
    }
    if (gen !== generation) return;
    // A change queued while the request was out stays queued.
    const now = readPending();
    for (const [id, v] of Object.entries(sent.set)) if (has(now.set, id) && sameValue(now.set[id], v)) { delete now.set[id]; now.seed = now.seed.filter((x) => x !== id); }
    now.unset = now.unset.filter((id) => !sent.unset.includes(id));
    writePending(now);
    retryMs = 2000;
    if (reply && isPrefsResponse(reply)) adopt(reply, 'normal');
    setStatus(Object.keys(now.set).length || now.unset.length ? 'saving' : 'saved');
    if (status === 'saving') scheduleFlush();
  }

  async function pull(): Promise<void> {
    const gen = generation;
    await flush();
    if (gen !== generation || !active() || status === 'offline') return;
    const mode = modeNow();
    const base = readBase();
    let r: PrefsGetResult;
    try {
      r = await transport.get(mode === 'normal' && base ? `"p${base.rev}"` : null);
    } catch {
      if (gen !== generation) return;
      setStatus('offline');
      retryLater();
      return;
    }
    if (gen !== generation) return;
    pulledAt = Date.now();
    if (r.status === 304 && mode === 'normal' && base) adopt({ prefs: base.prefs, rev: base.rev, updatedAt: null }, 'normal');
    else if (r.status === 200 && 'body' in r && isPrefsResponse(r.body)) adopt(r.body, mode);
    else if (r.status === 401 || r.status === 403 || r.status === 404) { refused = true; setStatus('local'); return; }
    else { setStatus('error'); retryLater(); return; }
    retryMs = 2000;
    const p = readPending();
    if (Object.keys(p.set).length || p.unset.length) await flush();
    else setStatus('saved');
  }

  function scheduleFlush(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flushTimer = null; void run(flush); }, FLUSH_DELAY_MS);
  }

  function restart(): void {
    generation++;
    refused = false;
    refusedIds.clear();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryMs = 2000;
    if (!active()) { setStatus('local'); return; }
    // Another account's queue never reaches this one.
    const p = readJSON(storage, PENDING_KEY, isPending);
    if (p && p.user !== user) storage.remove(PENDING_KEY);
    setStatus('saving');
    void run(pull);
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const wake = () => {
      if (!active()) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (Date.now() - pulledAt >= FOCUS_MIN_MS) void run(pull);
    };
    const online = () => { if (active()) void run(pull); };
    window.addEventListener('focus', wake);
    window.addEventListener('online', online);
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', wake);
    const poll = setInterval(() => {
      if (active() && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) void run(pull);
    }, POLL_MS);
    disposers.push(() => {
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', online);
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', wake);
      clearInterval(poll);
    });
  }

  return {
    setUser(id) { if (id === user) return; user = id; restart(); },
    setAvailable(on) { if (on === available) return; available = on; restart(); },
    setEnabled(on) { if (on === enabled) return; enabled = on; restart(); },
    queue(id, value) {
      if (!active()) return;
      const def = defs().find((d) => d.id === id);
      if (!def) return;
      if (value !== undefined && !fitsPrefLimits(value)) { tooLarge(id); return; }
      const p = readPending();
      p.user = user!;
      refusedIds.delete(id);
      p.seed = p.seed.filter((x) => x !== id);
      if (value === undefined) { delete p.set[id]; if (!p.unset.includes(id)) p.unset.push(id); }
      else { p.set[id] = value; p.unset = p.unset.filter((x) => x !== id); }
      writePending(p);
      setStatus('saving');
      scheduleFlush();
    },
    syncNow() { return run(pull); },
    status: () => status,
    subscribeStatus(fn) { statusListeners.add(fn); return () => { statusListeners.delete(fn); }; },
    onConflict(fn) {
      conflictListeners.add(fn);
      if (lastConflict) { const c = lastConflict; lastConflict = null; fn(c); }
      return () => { conflictListeners.delete(fn); };
    },
    stop() {
      generation++;
      if (flushTimer) clearTimeout(flushTimer);
      if (retryTimer) clearTimeout(retryTimer);
      for (const d of disposers.splice(0)) d();
    },
  };
}
