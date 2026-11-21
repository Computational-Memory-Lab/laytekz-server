/**
 * F14 desk pet: "away for an hour" (WP44 pet-runtime). The time lives in
 * this browser only (engine/prefs.ts AWAY_KEY): another tab learns of it
 * through the `storage` event, this tab through the listeners below, so the
 * palette, the pet's own menu and the toast's "Bring back" all agree.
 */
import { safeStorage } from '../../util/safeStorage';
import type { Notify } from '../types';
import { AWAY_KEY, awayMessage, bringBack, readAwayUntil, sendAway, type AwayStore } from './engine/prefs';

const listeners = new Set<() => void>();
let hooked = false;

function hookStorage(): void {
  if (hooked || typeof window === 'undefined') return;
  hooked = true;
  window.addEventListener('storage', (e) => {
    if (e.key === AWAY_KEY || e.key === null) listeners.forEach((fn) => fn());
  });
}

let store: AwayStore = safeStorage;

/** The time the pet comes back, or null while it is here. */
export function awayUntil(now = Date.now()): number | null {
  return readAwayUntil(store, now);
}

/** Sends the pet away for an hour; returns when it comes back. */
export function goAway(now = Date.now()): number {
  const until = sendAway(store, now);
  listeners.forEach((fn) => fn());
  return until;
}

export function comeBack(): void {
  bringBack(store);
  listeners.forEach((fn) => fn());
}

/** Sends the pet away and says until when, with "Bring back" on the toast. */
export function sendPetAway(toast: Notify, now = Date.now()): number {
  const until = goAway(now);
  try { toast(awayMessage(until), 'info', { label: 'Bring back', run: comeBack }); } catch { /* no toast host: the palette brings it back */ }
  return until;
}

/** Called when the away time changes here or in another tab. Returns the removal. */
export function subscribeAway(fn: () => void): () => void {
  hookStorage();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tests only: a memory store in place of localStorage. */
export function __setAwayStore(s: AwayStore): void {
  store = s;
}
