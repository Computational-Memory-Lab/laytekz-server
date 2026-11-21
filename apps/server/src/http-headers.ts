/**
 * Galley: the HTTP layer behind Cloudflare (V2 WP45 web readiness).
 *
 * - Base headers on every response, unless a route set its own: nosniff,
 *   a referrer policy, a permissions policy, and X-Robots-Tag (instances hold
 *   private documents; robots.txt stays open so crawlers can read the tag).
 * - Cache rules by path, because Cloudflare's Browser Cache TTL rewrites a
 *   missing or zero max-age to four hours: hashed /assets are immutable, the
 *   app page and /plugins must be revalidated on every load (a deploy changes
 *   them under the same URL), icons and the manifest keep a day.
 * - A missing static file (anything under /assets or /cmaps, or a path whose
 *   last segment has an extension) is a JSON 404, never the app page: a page
 *   served as `favicon.ico` or as a lazy chunk gets cached at the edge and
 *   breaks the tab that asked for it.
 * - The app page carries its build revision (the update notice compares it
 *   with /api/capabilities), absolute og:url / og:image when the public URL
 *   is known, and a report-only CSP that hashes every inline script.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const BASE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), browsing-topics=()',
  'x-robots-tag': 'noindex, nofollow',
});

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const REVALIDATE = 'no-cache';
const ONE_WEEK = 'public, max-age=604800';
const ONE_DAY = 'public, max-age=86400';

/** Files in apps/web/public served at the app's root (icons, manifest, preview image). */
const SHELL_FILES = /^\/(favicon\.ico|apple-touch-icon\.png|manifest\.webmanifest|og\.png|icons\/[^/]+\.png)$/;

const pathOf = (url: string) => {
  const q = url.search(/[?#]/);
  return q === -1 ? url : url.slice(0, q);
};

/** The Cache-Control a successful response for this (base-path-free) URL gets, or null to leave it alone. */
export function cacheControlFor(url: string): string | null {
  const p = pathOf(url);
  if (p.startsWith('/assets/')) return IMMUTABLE;
  if (p.startsWith('/cmaps/')) return ONE_WEEK;
  if (p.startsWith('/plugins/')) return REVALIDATE;
  if (SHELL_FILES.test(p)) return ONE_DAY;
  return null;
}

/** Whether a URL the router did not match names a static file (JSON 404) rather than an app route (the app page). */
export function isStaticMiss(url: string): boolean {
  // Judged after decoding and dot-segment collapse, the view the static plugin takes.
  let p = pathOf(url);
  try { p = path.posix.normalize(decodeURIComponent(p)); } catch { return false; }
  if (p.startsWith('/assets/') || p.startsWith('/cmaps/')) return true;
  const last = p.slice(p.lastIndexOf('/') + 1);
  // A page name (/index.html) still gets the app page, as it always has.
  return /\.[A-Za-z0-9]{1,8}$/.test(last) && !/\.html?$/i.test(last);
}

export function sendStaticMiss(reply: FastifyReply): FastifyReply {
  return reply.code(404).header('cache-control', 'no-store').send({ error: 'not found' });
}

/** Every inline <script> body of a page, as CSP source expressions. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    out.push(`'sha256-${crypto.createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  return out;
}

/** Hosts the in-browser suggestion model downloads from (WP43); nothing else leaves the origin. */
export const MODEL_HOSTS = ['https://huggingface.co', 'https://*.huggingface.co', 'https://*.hf.co'];

/** The report-only policy for the app page. `publicUrl` adds its websocket origin explicitly. */
export function appPagePolicy(html: string, publicUrl: string): string {
  let ws = '';
  try {
    if (publicUrl) { const u = new URL(publicUrl); ws = ` ${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`; }
  } catch { /* none */ }
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${inlineScriptHashes(html).join(' ')}`.trim(), // 'wasm-unsafe-eval': the optional suggestion model (WP43) compiles WebAssembly in a worker
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${ws} ${MODEL_HOSTS.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const escAttr = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The app page's own stamps: its build revision, and the absolute preview
 * links (social cards need absolute URLs). Never a project's name: previews
 * of /p/<id> are fetched signed out.
 */
export function stampShell(html: string, o: { rev: string; publicUrl: string }): string {
  const tags: string[] = [];
  if (o.rev) tags.push(`<meta name="laytekz-rev" content="${escAttr(o.rev)}" />`);
  if (o.publicUrl) {
    const base = o.publicUrl.replace(/\/+$/, '');
    tags.push(`<meta property="og:url" content="${escAttr(`${base}/`)}" />`);
    tags.push(`<meta property="og:image" content="${escAttr(`${base}/og.png`)}" />`);
  }
  if (!tags.length) return html;
  return html.replace('<head>', `<head>\n    ${tags.join('\n    ')}`);
}

/** Installs the base headers and the cache rules. Call before any route is registered. */
export function registerHttpHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload) => {
    for (const [k, v] of Object.entries(BASE_HEADERS)) if (!reply.hasHeader(k)) reply.header(k, v);
    const code = reply.statusCode;
    if (req.method === 'GET' || req.method === 'HEAD') {
      const cc = (code >= 200 && code < 300) || code === 304 ? cacheControlFor(req.url) : null;
      // The static plugin's own 'public, max-age=0' is replaced; a route's explicit choice (no-store) wins.
      if (cc && (!reply.hasHeader('cache-control') || /^public, max-age=0$/.test(String(reply.getHeader('cache-control'))))) reply.header('cache-control', cc);
    }
    return payload;
  });
}
