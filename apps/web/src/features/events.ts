/**
 * The page event emitter (WP06 page-host). A listener that throws is logged
 * and skipped; the others still run. Listeners run synchronously, in the
 * order they subscribed, over a snapshot: one that subscribes or
 * unsubscribes during an emit takes effect from the next emit.
 */
import type { Emitter } from './types';

export function createEmitter<E>(): Emitter<E> {
  const listeners = new Map<keyof E, Set<(payload: never) => void>>();
  return {
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      // A function subscribed twice is two subscriptions: wrap it so each
      // unsubscribe removes its own.
      const entry = (payload: never) => fn(payload);
      set.add(entry);
      return () => { listeners.get(event)?.delete(entry); };
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set?.size) return;
      for (const fn of [...set]) {
        try {
          (fn as (p: typeof payload) => void)(payload);
        } catch (err) {
          console.warn(`[laytekz] a '${String(event)}' listener failed`, err);
        }
      }
    },
  };
}
