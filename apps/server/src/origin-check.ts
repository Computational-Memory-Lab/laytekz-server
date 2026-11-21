import type { IncomingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';

/**
 * Browser Origin checks for cookie-authenticated requests. The session cookie
 * is SameSite=Lax, and "same site" means the registrable domain: every
 * sibling subdomain of the public host counts as the same site and gets the
 * cookie on its requests. So a state-changing request or a collab WebSocket
 * upgrade whose Origin header names any other origin is refused, except on
 * the cookie-less protocol endpoints that browser-based OAuth and MCP clients
 * call from their own origin (PROTOCOL_ROUTES).
 *
 * A request without an Origin header passes: browsers always send one on
 * these (WebSocket handshakes and every non-GET request), so its absence
 * means a non-browser client (bearer-token API and MCP clients, curl), which
 * a cookie-riding attack cannot be. Without ALDINE_PUBLIC_URL there is no
 * trustworthy origin to compare with and nothing is checked.
 */

/** The origin of ALDINE_PUBLIC_URL, or null when it is unset. */
export function publicOrigin(publicUrl: string = config.publicUrl): string | null {
  if (!publicUrl) return null;
  try { return new URL(publicUrl).origin; } catch { return null; }
}

/** True when the Origin header is present and names another origin than `expected`. */
export function foreignOrigin(origin: string | string[] | undefined, expected: string | null): boolean {
  if (expected === null || origin === undefined) return false;
  return origin !== expected;
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Routes that never read the session cookie and are meant for clients on other origins. */
const PROTOCOL_ROUTES = new Set(['/oauth/token', '/oauth/register', '/oauth/revoke', '/mcp']);

/**
 * Whether to refuse an HTTP request: a state-changing method from a foreign
 * origin on any route but PROTOCOL_ROUTES. `route` is the matched route
 * pattern (undefined when nothing matched), never the raw URL: the router
 * decodes percent-escapes before matching, so `/%61pi/...` reaches `/api/...`.
 */
export function refusesRequest(method: string, route: string | undefined, origin: string | string[] | undefined, expected: string | null = publicOrigin()): boolean {
  return STATE_CHANGING.has(method.toUpperCase()) && !(route !== undefined && PROTOCOL_ROUTES.has(route)) && foreignOrigin(origin, expected);
}

export const CROSS_ORIGIN_REFUSED = 'This request came from another site and was refused';

/** The onRequest hook that applies refusesRequest. Registered first, before anything reads the session. */
export function registerOriginCheck(app: FastifyInstance, expected: string | null = publicOrigin()): void {
  if (expected === null) return;
  app.addHook('onRequest', async (req, reply) => {
    if (refusesRequest(req.method, req.routeOptions.url, req.headers.origin, expected)) return reply.code(403).send({ error: CROSS_ORIGIN_REFUSED });
  });
}

/** For the HTTP upgrade handler: answers 403 and closes the socket when the handshake comes from a foreign origin. Returns true when it did. */
export function refuseForeignUpgrade(headers: IncomingHttpHeaders, socket: Duplex, expected: string | null = publicOrigin()): boolean {
  if (!foreignOrigin(headers.origin, expected)) return false;
  // Destroyed once the response is flushed, as ws aborts a handshake.
  socket.once('finish', () => socket.destroy());
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n');
  return true;
}
