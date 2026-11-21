/**
 * Galley: one address for the site. With GALLEY_CANONICAL_HOST_REDIRECT=1 and
 * ALDINE_PUBLIC_URL set, a request that arrives under any other host name (an
 * old address still pointed at this server) is sent to the same path on
 * ALDINE_PUBLIC_URL with a permanent redirect: 308, so a POST stays a POST.
 *
 * Loopback names (127.0.0.1, ::1, localhost) are never redirected: the deploy
 * tooling's health checks, the compiler and local tests reach the app that way.
 * Off by default, so nothing changes for an installation that does not opt in.
 */
import type { FastifyInstance } from 'fastify';

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

/** The host name without a port, lower-cased; '' when there is none. */
export function hostName(header: string | string[] | undefined): string {
  const raw = (Array.isArray(header) ? header[0] : header) ?? '';
  const v = raw.trim().toLowerCase();
  if (v.startsWith('[')) return v.slice(0, v.indexOf(']') + 1);
  return v.replace(/:\d+$/, '');
}

/** Where a request for `host` + `url` goes, or null to serve it here. */
export function canonicalTarget(publicUrl: string, host: string, url: string): string | null {
  let canonical: URL;
  try { canonical = new URL(publicUrl); } catch { return null; }
  if (!host || LOOPBACK.test(host) || host === canonical.hostname.toLowerCase()) return null;
  const path = url.startsWith('/') ? url : `/${url}`;
  return `${canonical.origin}${path}`;
}

export function registerCanonicalHost(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): void {
  if (env.GALLEY_CANONICAL_HOST_REDIRECT !== '1') return;
  const publicUrl = (env.ALDINE_PUBLIC_URL || '').trim();
  if (!publicUrl) {
    console.warn('[laytekz] GALLEY_CANONICAL_HOST_REDIRECT=1 has no effect without ALDINE_PUBLIC_URL');
    return;
  }
  app.addHook('onRequest', async (req, reply) => {
    // req.raw.url: the address as sent, before the base-path rewrite.
    const target = canonicalTarget(publicUrl, hostName(req.headers.host), req.raw.url || '/');
    if (target) return reply.code(308).header('location', target).header('cache-control', 'public, max-age=3600').send();
  });
}
