/**
 * The capabilities client (WP02 settings-core): GET /api/capabilities, what
 * this server offers this caller (accounts, preference sync, MCP, and each
 * server feature's own keys). One request per tab, again after a sign-in or
 * a sign-out; a server without the route (an older one) or an unreachable
 * one leaves the defaults in place.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { apiRequest, onSessionUser, sessionUser } from '../api';
import type { Capabilities } from '../features/types';
import { sameValue } from './codecs';

/** What a client assumes before the first answer, and when the route is missing (an older server). */
export const DEFAULT_CAPABILITIES: Capabilities = { rev: '', accounts: false, prefs: false, mcp: false, oauthRegistration: false };

let caps: Capabilities = DEFAULT_CAPABILITIES;
/** An answer (or a definite "no such route") has arrived for the current session. */
let loaded = false;
let inflight: Promise<Capabilities> | null = null;
let hooked = false;
const listeners = new Set<() => void>();

/** The server's answer with the five core keys made well-typed; anything unusable is the defaults. */
export function normaliseCapabilities(raw: unknown): Capabilities {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_CAPABILITIES;
  const r = raw as Record<string, unknown>;
  return {
    ...r,
    rev: typeof r.rev === 'string' ? r.rev : '',
    accounts: r.accounts === true,
    prefs: r.prefs === true,
    mcp: r.mcp === true,
    oauthRegistration: r.oauthRegistration === true,
  };
}

function publish(next: Capabilities): void {
  if (sameValue(next, caps)) return;
  caps = next;
  for (const fn of [...listeners]) fn();
}

async function fetchCapabilities(): Promise<Capabilities> {
  try {
    publish(normaliseCapabilities(await apiRequest<unknown>('/api/capabilities')));
    loaded = true;
  } catch (err) {
    // No answer at all keeps what this tab already knew, and asks again on
    // the next load; a refusal (404 on an older server) is the defaults.
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status > 0) { publish(DEFAULT_CAPABILITIES); loaded = true; }
  }
  return caps;
}

/** A sign-in or sign-out changes what the server offers this caller. The first
 *  answer of /api/auth/me is neither: the cookie was already on the request. */
function hookSession(): void {
  if (hooked) return;
  hooked = true;
  let known = sessionUser();
  onSessionUser((id) => {
    const before = known;
    known = id;
    if (before === undefined || before === id) return;
    loaded = false;
    void loadCapabilities();
  });
}

/** The last answer, or DEFAULT_CAPABILITIES before one arrives. */
export function getCapabilities(): Capabilities {
  return caps;
}

/** Fetches once per tab and again after a sign-in or sign-out; never rejects (falls back to the defaults). */
export function loadCapabilities(): Promise<Capabilities> {
  hookSession();
  if (inflight) return inflight;
  if (loaded) return Promise.resolve(caps);
  inflight = fetchCapabilities().finally(() => { inflight = null; });
  return inflight;
}

/** `fn` runs whenever the answer changes. */
export function subscribeCapabilities(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useCapabilities(): Capabilities {
  const value = useSyncExternalStore(subscribeCapabilities, getCapabilities, getCapabilities);
  useEffect(() => { void loadCapabilities(); }, []);
  return value;
}
