import { vi } from 'vitest';
import { ApiError } from '../../api';
import type { PrefsTransport } from '../sync';
import type { AccountPrefsPatch } from '../types';

/** An in-memory Storage that can be told to fail the way browsers do. */
export function memoryStorage(fail: { get?: boolean; set?: boolean } = {}): Storage & { map: Map<string, string>; fail: typeof fail } {
  const map = new Map<string, string>();
  return {
    map,
    fail,
    get length() { return map.size; },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => { if (fail.get) throw new DOMException('denied', 'SecurityError'); return map.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (fail.set) throw new DOMException('full', 'QuotaExceededError'); map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

export interface FakeWindow extends EventTarget {
  localStorage: Storage;
  location: { assign: ReturnType<typeof vi.fn>; href: string };
  matchMedia(q: string): { matches: boolean; addEventListener(): void; removeEventListener(): void };
}

/** A window for the store: localStorage, events, matchMedia, location. `blocked` makes reading localStorage itself throw. */
export function fakeWindow(storage: Storage = memoryStorage(), o: { blocked?: boolean; dark?: boolean } = {}): FakeWindow {
  const target = new EventTarget() as FakeWindow;
  Object.defineProperty(target, 'localStorage', {
    get() { if (o.blocked) throw new DOMException('blocked', 'SecurityError'); return storage; },
  });
  target.location = { assign: vi.fn(), href: 'http://localhost/' };
  target.matchMedia = () => ({ matches: !!o.dark, addEventListener() {}, removeEventListener() {} });
  return target;
}

/** What another tab's write looks like to this one. */
export function storageEvent(storage: Storage, key: string | null, newValue: string | null): Event {
  return Object.assign(new Event('storage'), { key, newValue, storageArea: storage });
}

/** The account preferences route, in memory: ETags, keepExisting, offline, refusals. */
export function fakeAccount(initial: Record<string, unknown> = {}, rev = 0) {
  const state = {
    prefs: { ...initial } as Record<string, unknown>,
    rev,
    online: true,
    /** Answer every request with this status (401, 404, …). */
    status: 0,
    /** A 400 naming this key when a PATCH sets it. */
    refuseKey: null as string | null,
    calls: [] as string[],
    patches: [] as AccountPrefsPatch[],
  };
  const reply = () => ({ prefs: structuredClone(state.prefs), rev: state.rev, updatedAt: null });
  const transport: PrefsTransport = {
    async get(etag) {
      state.calls.push(`GET ${etag ?? '-'}`);
      if (!state.online) throw new TypeError('Failed to fetch');
      if (state.status) return { status: state.status };
      if (etag === `"p${state.rev}"`) return { status: 304 };
      return { status: 200, body: reply() };
    },
    async patch(body) {
      state.calls.push(`PATCH ${JSON.stringify(body)}`);
      state.patches.push(structuredClone(body));
      if (!state.online) throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
      if (state.status) throw new ApiError(`HTTP ${state.status}`, state.status);
      if (state.refuseKey && body.set && state.refuseKey in body.set) {
        throw new ApiError('That value is too large', 400, undefined, undefined, { error: 'That value is too large', key: state.refuseKey });
      }
      for (const [k, v] of Object.entries(body.set ?? {})) if (!(body.keepExisting && k in state.prefs)) state.prefs[k] = v;
      for (const k of body.unset ?? []) delete state.prefs[k];
      state.rev++;
      return reply();
    },
  };
  return { state, transport };
}
