/** Libraries (F8): an account's connection to a reference manager (GET /api/libraries/:provider/connection). */
import { withBase } from '../../basePath';
import type { Capabilities } from '../types';

export type ConnectionState =
  | { kind: 'connected'; name: string | null }
  | { kind: 'disconnected' }
  /** The server has no such route (no WP35 yet, or the provider is off): 404. */
  | { kind: 'unsupported' }
  | { kind: 'error' };

/** `{connected, name|username}`; a 404 means the server cannot connect to it. */
export function parseConnection(status: number, body: unknown): ConnectionState {
  if (status === 404) return { kind: 'unsupported' };
  if (status < 200 || status >= 300 || !body || typeof body !== 'object') return { kind: 'error' };
  const o = body as { connected?: unknown; name?: unknown; username?: unknown };
  if (o.connected !== true) return { kind: 'disconnected' };
  const name = typeof o.name === 'string' && o.name ? o.name : typeof o.username === 'string' && o.username ? o.username : null;
  return { kind: 'connected', name };
}

export async function readConnection(provider: string): Promise<ConnectionState> {
  try {
    const res = await fetch(withBase(`/api/libraries/${encodeURIComponent(provider)}/connection`));
    return parseConnection(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: 'error' };
  }
}

/** The OAuth start: a top-level navigation, so the desktop app's auth window takes it. */
export function connectUrl(provider: string, returnTo: string): string {
  return withBase(`/api/libraries/${encodeURIComponent(provider)}/connect?returnTo=${encodeURIComponent(returnTo)}`);
}

/** `libraries.<key>` in the capabilities (flat, or nested under `libraries`). */
export function providerConfigured(caps: Capabilities, key: string): boolean {
  if (caps[`libraries.${key}`] === true) return true;
  const nested = caps.libraries;
  return !!nested && typeof nested === 'object' && (nested as Record<string, unknown>)[key] === true;
}
