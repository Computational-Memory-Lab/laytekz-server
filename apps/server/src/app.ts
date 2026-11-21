import Fastify, { LogController, type FastifyInstance, type FastifyReply } from 'fastify';
import { stampInstance } from './instance.js';
import { registerCanonicalHost } from './galley-canonical-host.js'; // Galley: one address for the site
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { config } from './config.js';
import { registerRoutes } from './routes.js';
import { initObservability } from './observability.js';
import { registerOriginCheck } from './origin-check.js';
import { registerSourceRoute, stampSource } from './galley-source.js';
import { PRODUCT_NAME } from './product.js'; // Galley: the product's own name
import { registerFeatures } from './features/host.js'; // Galley: V2 server feature host
// Galley: V2 web readiness (WP45): base headers, cache rules, static 404s, app page stamps.
import { appPagePolicy, isStaticMiss, registerHttpHeaders, sendStaticMiss, stampShell, REVALIDATE } from './http-headers.js';
import { buildRev } from './features/capabilities.js';

const BASE = config.basePath;

/** True when a raw request URL lies under the base path ('' matches everything). */
export function underBasePath(url: string): boolean {
  if (!BASE) return true;
  if (!url.startsWith(BASE)) return false;
  const next = url.charAt(BASE.length);
  return next === '' || next === '/' || next === '?';
}

/**
 * Routes are declared once, at '/api/...', and the base path is peeled off the
 * incoming URL before routing. Requests outside the base path 404 — the rest of
 * the host belongs to whatever else is deployed there — except the two probes
 * orchestrators aim at the container's own port and root: /api/health, and a
 * bare GET / (the default health check of most load balancers), which answers
 * 200 with a one-line pointer to where the app lives.
 */
export const ROOT_POINTER = '/__base-path-root__';
/** RFC 8414 §3.1 / RFC 9728 §3.1 put the discovery documents at the ORIGIN
 *  root with the issuer's path inserted after the well-known segment
 *  (…/.well-known/oauth-authorization-server/internal/aldine), which is the
 *  form MCP clients try first; they are routed to the same handlers as the
 *  app-relative form. Nothing else at the origin root is ours. */
const WELL_KNOWN_AT_ROOT = ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource'];
/** The only remainders that name a document: the issuer itself and the /mcp
 *  resource, each with an optional query. Anything else must stay outside
 *  the base path — an open-ended remainder would reach the static plugin,
 *  which decodes it and lets "..%2f" walk back into the web dist. */
const WELL_KNOWN_REST = /^(\/mcp)?(\?.*)?$/;
export function rewriteUrl(url: string): string {
  if (!BASE) return url;
  if (url === '/api/health') return url;
  if (url === '/') return ROOT_POINTER;
  for (const wk of WELL_KNOWN_AT_ROOT) {
    if (!url.startsWith(wk + BASE)) continue;
    const rest = url.slice(wk.length + BASE.length);
    if (WELL_KNOWN_REST.test(rest)) return wk + rest;
  }
  if (!underBasePath(url)) return `/__outside-base-path__${url}`;
  const rest = url.slice(BASE.length);
  return rest === '' || rest.startsWith('?') ? `/${rest}` : rest;
}

export function isCollabUpgrade(url: string | undefined): boolean {
  return !!url && rewriteUrl(url).startsWith('/collab');
}

/**
 * The built index.html is served at every app route (/, /p/<id>, …), so its
 * asset references cannot stay relative to the document: Vite emits them as
 * `./assets/…` (relative base, so chunks resolve from the loaded script's own
 * URL) and the server pins them to the base path here. The meta tag is how
 * the client learns the base path for API and websocket URLs.
 */
export function renderIndexHtml(raw: string): string {
  return raw
    .replace(/(\s(?:src|href)=")\.\//g, `$1${BASE}/`)
    .replace('<head>', `<head>\n    <meta name="aldine-base-path" content="${BASE}/" />`);
}

const PROXY_NAMES = /^(loopback|linklocal|uniquelocal)$/;
const isProxyAddress = (entry: string) => {
  const [addr, bits, ...rest] = entry.split('/');
  return rest.length === 0 && net.isIP(addr) !== 0 && (bits === undefined || /^\d{1,3}$/.test(bits));
};

/**
 * Fastify's trustProxy for TRUST_PROXY: a hop count (`1` for the one reverse
 * proxy of the documented setups), or the comma-separated addresses / CIDR
 * ranges of the trusted proxies. Either way req.ip is the address the
 * outermost trusted proxy appended to X-Forwarded-For, never an entry the
 * client wrote itself (nginx's $proxy_add_x_forwarded_for and a load
 * balancer append to the client's header rather than replace it). Unset,
 * `0` or an unreadable value: off, req.ip is the socket address.
 */
export function trustProxySetting(raw: string | undefined): number | string | false {
  const v = (raw || '').trim();
  if (!v || v === '0') return false;
  if (/^\d+$/.test(v)) return Number(v);
  const entries = v.split(',').map((s) => s.trim());
  if (entries.every((e) => PROXY_NAMES.test(e) || isProxyAddress(e))) return entries.join(',');
  console.warn(`[aldine] TRUST_PROXY=${v} is neither a hop count nor a list of proxy addresses; X-Forwarded-For is ignored`);
  return false;
}

export async function buildApp(): Promise<FastifyInstance> {
  // trustProxy makes req.ip honor X-Forwarded-For — enable ONLY behind a trusted
  // reverse proxy (Caddy/nginx). Off by default so clients can't spoof their IP
  // to evade rate limits or lock others out.
  // Info level so operational lines (a failed ZIP import and its reason) reach
  // the hosted instance's log; per-request access lines stay off because the
  // load balancer already keeps those. LOG_LEVEL=warn restores the old quiet.
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 32 * 1024 * 1024,
    trustProxy: trustProxySetting(process.env.TRUST_PROXY),
    rewriteUrl: (req) => rewriteUrl(req.url || '/'),
  });

  // Galley: first onRequest hook, so a refused cross-origin request never
  // reaches the session lookup (origin-check.ts).
  registerCanonicalHost(app); // Galley: an old address redirects to ALDINE_PUBLIC_URL (opt-in), before anything else
  registerOriginCheck(app);
  registerHttpHeaders(app); // Galley: V2 (WP45) base headers and cache rules on every response
  await initObservability(app);
  await registerRoutes(app);
  await registerFeatures(app); // Galley: V2 server features, after the global guards registerRoutes installs
  registerSourceRoute(app);
  // MCP endpoint (agent connector), env-gated. Dynamic import keeps the SDK out
  // of the boot path entirely when the feature is off.
  if (process.env.ALDINE_MCP === '1') {
    const { registerMcp } = await import('./mcp/server.js');
    await registerMcp(app);
  }
  if (BASE) app.get(ROOT_POINTER, async (_req, reply) => reply.type('text/plain').send(`${PRODUCT_NAME} is served at ${BASE}/\n`));

  // Serve the built frontend (production). In dev, Vite serves it and proxies to us.
  const indexFile = path.join(config.webDist, 'index.html');
  if (fs.existsSync(indexFile)) {
    // Galley: V2 (WP45) the build revision and absolute preview links are stamped once.
    const indexHtml = stampShell(renderIndexHtml(fs.readFileSync(indexFile, 'utf8')), { rev: buildRev(), publicUrl: config.publicUrl });
    // Galley: V2 (WP45) report-only until a week of reports is clean; hashes every inline script of the page.
    const reportOnlyPolicy = appPagePolicy(indexHtml, config.publicUrl);
    // No page of the app renders inside another page's frame: the OAuth
    // consent page grants account access on a single click.
    const sendIndex = (_req: unknown, reply: FastifyReply) => reply
      .header('content-security-policy', "frame-ancestors 'none'")
      .header('content-security-policy-report-only', reportOnlyPolicy) // Galley: V2 (WP45)
      .header('cache-control', REVALIDATE) // Galley: V2 (WP45) a deploy changes the page under the same URL
      .header('x-frame-options', 'DENY')
      .type('text/html').send(stampSource(stampInstance(indexHtml)));
    // The raw index.html never goes on the wire: '/' has its own route, the
    // static plugin is told not to serve directory indexes or the file itself,
    // and every other app route lands in the not-found fallback below.
    app.get('/', sendIndex);
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: '/',
      index: false,
      // Compared after decoding and dot-segment collapse, the same view
      // send() takes: "/assets/..%2findex.html" is the raw file too.
      allowedPath: (pathname) => {
        let p = pathname;
        try { p = path.posix.normalize(decodeURIComponent(pathname)); } catch { return false; }
        return p !== '/index.html' && !p.startsWith('/.well-known/');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      // /oauth/authorize is the SPA's consent page; the other /oauth/* paths,
      // /.well-known/* and /mcp are protocol endpoints that must never answer with HTML.
      if (/^\/(api|plugins|collab|mcp|__outside-base-path__|\.well-known)(\/|$|\?)/.test(req.url) || /^\/oauth\/(?!authorize(\/|$|\?))/.test(req.url)) {
        return reply.code(404).send({ error: 'not found' });
      }
      // Galley: V2 (WP45) a missing file (an old lazy chunk, favicon.ico) is never answered with the app page.
      if (isStaticMiss(req.url)) return sendStaticMiss(reply);
      return sendIndex(req, reply);
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not found' }));
  }

  return app;
}
