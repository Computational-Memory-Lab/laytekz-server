/**
 * The keybinding registry (WP04 input-core). util/shortcuts.ts keeps its V1
 * exports and delegates here; overrides stay in localStorage
 * 'aldine.shortcuts' (same JSON shape, one entry per binding id, `null` for a
 * binding someone cleared), read and written through the settings store as
 * CORE_SETTING_IDS.shortcuts so the account copy follows.
 */
import { useSyncExternalStore } from 'react';
import { isMac } from '../platform';
import { safeStorage } from '../util/safeStorage';
import { getSetting, resetSetting, setSetting, subscribeSetting } from '../settings/store';
import { CORE_SETTING_IDS } from '../settings/types';
import type { Chord, KeybindingDef, KeyScope, ReservedChord } from './types';
import { chord, codeForKey, formatChord, isChord, matchesChord, normalKey, sameChord } from './chords';
import { RESERVATIONS, reservationFor } from './reserved';

/** V1's device key; the settings store mirrors it as CORE_SETTING_IDS.shortcuts. */
export const SHORTCUTS_KEY = 'aldine.shortcuts';

/**
 * The app's own bindings, before every feature's. The first five are V1's
 * changeable shortcuts (ids, labels and defaults unchanged); Editor.tsx and
 * CommandPalette.tsx dispatch those themselves. `settings` is dispatched by
 * the page host; `follow` by modClickExtension (editor/core/modClick.ts).
 */
export const CORE_KEYBINDINGS: readonly KeybindingDef[] = [
  { id: 'typeset', label: 'Typeset', group: 'Typesetting', default: chord('mod+s'), changeable: true, scope: 'page', command: 'typeset' },
  // Shift, not Alt: Ctrl+Alt is AltGr on German Windows keyboards. ⇧⌘C is
  // also the developer tools' inspector; the owner chose it, so it stays
  // (README D7) while new bindings may not take it.
  { id: 'comment', label: 'Comment on the selection', group: 'Editor', default: chord('mod+shift+c'), changeable: true, scope: 'page-capture', command: 'comment' },
  { id: 'jump', label: 'Jump the PDF to the cursor', group: 'Typesetting', default: chord('mod+j'), changeable: true, scope: 'page', command: 'jump-pdf' },
  { id: 'palette', label: 'Command palette', group: 'General', default: chord('mod+k'), changeable: true, scope: 'page', command: 'palette' },
  { id: 'search', label: 'Search the project', group: 'General', default: chord('mod+shift+f'), changeable: true, scope: 'page', command: 'search' },
  // The desktop app's Settings… menu item owns ⌘, there.
  { id: 'settings', label: 'Open settings', group: 'General', default: chord('mod+,'), changeable: true, scope: 'page', command: 'settings', desktop: 'native-menu' },
  // Alt+Enter types nothing, so it needs no ⌘ (chordProblem allows it).
  { id: 'follow', label: 'Follow the link or reference at the cursor', group: 'Editor', default: chord('alt+Enter'), changeable: true, scope: 'editor', command: 'follow' },
];

/** Chords the browser, the OS, the desktop app or the editor keep, which chordProblem refuses. */
export const RESERVED: readonly ReservedChord[] = RESERVATIONS.map(({ chord: c, owner, platforms, kind }) => ({
  chord: c, owner: kind === 'editor' ? `${owner} in the editor` : owner, platforms,
}));

const SCOPES: readonly KeyScope[] = ['page', 'page-capture', 'editor'];

// ---- Overrides ----

type Raw = Record<string, unknown>;

let raw: Raw = {};
/** 'store': the settings store serves the value (and syncs it); 'local': localStorage directly, as V1 did. */
let backend: 'store' | 'local' | null = null;
let version = 0;
const listeners = new Set<() => void>();
const notify = () => { version += 1; listeners.forEach((l) => l()); };

const plain = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Raw) } : {});
const readLocal = (): Raw => plain(safeStorage.getJSON<unknown>(SHORTCUTS_KEY, {}));

function init(): void {
  if (backend) return;
  try {
    raw = plain(getSetting<unknown>(CORE_SETTING_IDS.shortcuts));
    subscribeSetting(CORE_SETTING_IDS.shortcuts, () => { raw = plain(getSetting<unknown>(CORE_SETTING_IDS.shortcuts)); notify(); });
    backend = 'store';
  } catch {
    // The store is not there (an isolated build, a test): V1's own storage
    // and cross-tab listener keep shortcuts working.
    backend = 'local';
    raw = readLocal();
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => { if (e.key === SHORTCUTS_KEY || e.key === null) { raw = readLocal(); notify(); } });
    }
  }
}

function write(next: Raw): void {
  raw = next;
  notify();
  if (backend === 'store') {
    try {
      if (Object.keys(next).length) setSetting(CORE_SETTING_IDS.shortcuts, next);
      else resetSetting(CORE_SETTING_IDS.shortcuts);
      return;
    } catch { /* stored below, as V1 did */ }
  }
  // Without storage this tab keeps it.
  safeStorage.setJSON(SHORTCUTS_KEY, next);
}

/** The stored chord for `id`: a chord, null (cleared), or undefined (none, or not a chord). */
function override(id: string): Chord | null | undefined {
  init();
  if (!Object.prototype.hasOwnProperty.call(raw, id)) return undefined;
  const v = raw[id];
  if (v === null) return null;
  return isChord(v) ? v : undefined;
}

// ---- Bindings ----

let registered: readonly KeybindingDef[] = [];
let all: readonly KeybindingDef[] | null = null;
let byId: Map<string, KeybindingDef> | null = null;

function index(): Map<string, KeybindingDef> {
  if (!byId) byId = new Map(keybindings().map((d) => [d.id, d]));
  return byId;
}

/** The binding with this id, core or registered. */
export function keybinding(id: string): KeybindingDef | null {
  return index().get(id) ?? null;
}

function invalid(d: KeybindingDef, taken: ReadonlySet<string>): string | null {
  if (!d || typeof d !== 'object') return 'not an object';
  if (typeof d.id !== 'string' || !d.id) return 'no id';
  if (taken.has(d.id)) return `the id ${d.id} is taken`;
  if (d.default !== null && !isChord(d.default)) return 'the default is not a chord';
  if (!SCOPES.includes(d.scope)) return `unknown scope ${String(d.scope)}`;
  if (typeof d.command !== 'string' || !d.command) return 'no command';
  return null;
}

/** Adds bindings (the page host registers every feature's at boot); returns their removal. */
export function registerKeybindings(defs: readonly KeybindingDef[]): () => void {
  const taken = new Set(keybindings().map((d) => d.id));
  const added: KeybindingDef[] = [];
  for (const d of defs) {
    const why = invalid(d, taken);
    if (why) { console.warn(`Keybinding ${d?.id ?? '?'} skipped: ${why}`); continue; }
    taken.add(d.id);
    added.push(d);
  }
  if (!added.length) return () => {};
  registered = [...registered, ...added];
  all = null; byId = null;
  notify();
  return () => {
    const before = registered.length;
    registered = registered.filter((d) => !added.includes(d));
    if (registered.length === before) return;
    all = null; byId = null;
    notify();
  };
}

/** Core bindings first, then the registered ones. */
export function keybindings(): readonly KeybindingDef[] {
  if (!all) all = Object.freeze([...CORE_KEYBINDINGS, ...registered]);
  return all;
}

/** The current chord, the override or the default; null when unbound. A
 *  stored chord for a binding not registered on this page still counts. */
export function chordFor(id: string): Chord | null {
  const def = keybinding(id);
  if (def && !def.changeable) return def.default;
  const o = override(id);
  if (o !== undefined) return o;
  return def ? def.default : null;
}

/** A chord is stored for `id` (a changed or cleared binding). */
export function isOverridden(id: string): boolean {
  const def = keybinding(id);
  return (!def || def.changeable) && override(id) !== undefined;
}

/** null unbinds; setting the default chord removes the override. */
export function setChord(id: string, c: Chord | null): void {
  init();
  const def = keybinding(id);
  if (def && !def.changeable) { console.warn(`Keybinding ${id} cannot be changed`); return; }
  if (c !== null && !isChord(c)) return;
  const next = { ...raw };
  const isDefault = def && (c === null ? def.default === null : def.default !== null && sameChord(c, def.default));
  if (isDefault) delete next[id];
  else next[id] = c;
  write(next);
}

/** The chord bindingFor and matchesShortcut compare: code-matched bindings by the physical key. */
function matchChord(id: string): Chord | null {
  const c = chordFor(id);
  if (!c) return null;
  if (keybinding(id)?.matchCode && !c.code) {
    const code = codeForKey(c.key);
    return code ? { ...c, code } : c;
  }
  return c;
}

export function matchesShortcut(e: KeyboardEvent, id: string): boolean {
  const c = matchChord(id);
  return !!c && matchesChord(e, c);
}

function subscribe(l: () => void): () => void {
  init();
  listeners.add(l);
  return () => { listeners.delete(l); };
}
const snapshot = () => version;

/** The live label ("⇧⌘E", "Ctrl+Shift+E"), '' when unbound. */
export function useChordLabel(id: string): string {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return chordLabel(id);
}

/** The same label outside React (palette hints). */
export function chordLabel(id: string): string {
  const c = chordFor(id);
  return c ? formatChord(c) : '';
}

/** Called after any override or registration changes (this tab, another tab, the account). */
export function subscribeKeybindings(fn: () => void): () => void {
  return subscribe(fn);
}

/** Option chords that type nothing, or that a binding matches by physical key (plan §2.3). */
function typesNothing(c: Chord): boolean {
  if (c.mod || !c.alt) return false;
  const k = normalKey(c);
  return k === 'enter' || (c.shift && (k === 'a' || k === 'f')) || (!c.shift && k === '\\');
}

/** Why `c` cannot be used for `id`, or null. Accepts Alt+Enter and Shift+Alt+Enter without Mod. */
export function chordProblem(c: Chord, id: string, mac = isMac): string | null {
  const label = formatChord(c, mac);
  const def = keybinding(id);
  // A binding's own default is always allowed back (⇧⌘C for comment).
  const own = !!def?.default && sameChord(c, def.default);
  if (!own) {
    if (!c.mod && !/^f\d{1,2}$/.test(normalKey(c)) && !typesNothing(c)) return `Hold ${mac ? '⌘' : 'Ctrl'} with the key, or it would type`;
    if (c.mod && c.alt) {
      return mac
        ? `${label} is Ctrl+Alt on Windows, which types characters there (AltGr)`
        : `${label} types characters on many keyboards (AltGr)`;
    }
    const r = reservationFor(c, mac);
    if (r) return r.kind === 'editor' ? `${label} is ${r.owner} in the editor` : `${label} belongs to ${r.owner}`;
  }
  const other = keybindings().find((d) => {
    if (d.id === id) return false;
    const theirs = chordFor(d.id);
    return !!theirs && sameChord(theirs, c);
  });
  return other ? `${label} is already ${other.label}` : null;
}

/** Another binding on the same keys as `id`, as the keys stand now (a chord
 *  saved before a later default took the same keys): its label, or null. */
export function chordConflict(id: string): string | null {
  const mine = chordFor(id);
  if (!mine) return null;
  return keybindings().find((d) => {
    if (d.id === id) return false;
    const theirs = chordFor(d.id);
    return !!theirs && sameChord(theirs, mine);
  })?.label ?? null;
}

/** The binding a keydown triggers among `scopes`, or null. Skips 'native-menu'
 *  bindings when `desktop` is true. Page hosts (WP06) and the editor (WP05)
 *  dispatch through it. */
export function bindingFor(e: KeyboardEvent, scopes: readonly KeyScope[], o?: { desktop?: boolean }): KeybindingDef | null {
  if (e.isComposing) return null;
  for (const d of keybindings()) {
    if (!scopes.includes(d.scope)) continue;
    if (o?.desktop && d.desktop === 'native-menu') continue;
    const c = matchChord(d.id);
    if (c && matchesChord(e, c)) return d;
  }
  return null;
}
