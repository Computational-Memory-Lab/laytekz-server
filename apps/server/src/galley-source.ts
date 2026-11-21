import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { etagMatches } from './thumbnail.js';
import { PRODUCT_NAME, UPSTREAM_URL } from './product.js';

/**
 * AGPL-3.0 section 13: everyone using a modified instance over the network
 * must be offered the corresponding source of the version running here. The
 * web app's "Source code" links (About, the project list's colophon) point at
 * upstream unless the operator names this deployment's source:
 *
 *   GALLEY_SOURCE_URL      https URL of the source (a repository, a tarball);
 *                          a path starting with "/" is on this origin
 *   GALLEY_SOURCE_TARBALL  a .tar.gz on this machine, served at
 *                          <base path>/source.tar.gz; the links lead there
 *                          when GALLEY_SOURCE_URL is unset
 *
 * Both are read when used, so replacing the tarball needs no restart. The
 * stamped tarball link names the file's version (size and time), and the
 * route sends validators: a proxy that rewrites Cache-Control (Cloudflare
 * gives browsers a 4-hour max-age) cannot keep serving an older tarball
 * after a deploy, because the new link is a new URL.
 */

const UNSAFE = /[\u0000- "<>\\^`{|}\u007f]/;

/** GALLEY_SOURCE_URL when usable: an http(s) URL, or an absolute path on this origin. */
function configuredUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.GALLEY_SOURCE_URL || '').trim();
  if (!raw || raw.length > 2000 || UNSAFE.test(raw)) return null;
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch { return null; }
}

const tarballPath = (env: NodeJS.ProcessEnv) => (env.GALLEY_SOURCE_TARBALL || '').trim();

/** A short name for this version of the tarball: its size and modification time. */
export function tarballVersion(st: fs.Stats): string {
  return `${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}`;
}

/** Whether a configured URL is this server's own tarball route (as deploy/config/app.env.template sets it). */
function isOwnTarballRoute(url: string, env: NodeJS.ProcessEnv): boolean {
  const route = `${config.basePath}/source.tar.gz`;
  if (url === route) return true;
  try {
    const u = new URL(url);
    const own = new URL(env.ALDINE_PUBLIC_URL || '');
    return u.origin === own.origin && u.pathname === route && !u.search && !u.hash;
  } catch { return false; }
}

/** Where the web app's source links lead, or null for upstream's repository. */
export function sourceUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = configuredUrl(env);
  const file = tarballPath(env);
  // The tarball route, configured or implied, is linked by version.
  if (configured && !(file && isOwnTarballRoute(configured, env))) return configured;
  if (!file) return null;
  const st = regularFile(file);
  return `${configured ?? `${config.basePath}/source.tar.gz`}${st ? `?v=${tarballVersion(st)}` : ''}`;
}

/** Boot warnings for settings that cannot work. */
export function sourceConfigWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if ((env.GALLEY_SOURCE_URL || '').trim() && !configuredUrl(env)) {
    out.push('[aldine] GALLEY_SOURCE_URL is neither an http(s) URL nor a path starting with "/"; it is not used');
  }
  const file = tarballPath(env);
  if (file && !regularFile(file)) out.push(`[aldine] GALLEY_SOURCE_TARBALL=${file} is not a readable file; ${config.basePath}/source.tar.gz answers 404`);
  return out;
}

function regularFile(file: string): fs.Stats | null {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st : null;
  } catch { return null; }
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** index.html with the source link for the web app (apps/web/src/source.ts); unchanged when upstream's applies. */
export function stampSource(html: string, url: string | null = sourceUrl()): string {
  if (!url) return html;
  return html.replace('<head>', `<head>\n    <meta name="galley-source" content="${escAttr(url)}" />`);
}

/** The download's name: the product's, whatever the file on this machine is called. */
const DOWNLOAD_NAME = `${PRODUCT_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-source.tar.gz`;

/**
 * GET <base path>/source.tar.gz: the one configured file, or 404. No
 * parameters reach the file system.
 * GET <base path>/source: a redirect to wherever the source offer points now
 * (GALLEY_SOURCE_URL, the current tarball, or upstream), for clients that
 * cannot read the stamped link, such as the desktop app's About and Help menu.
 */
export function registerSourceRoute(app: FastifyInstance): void {
  app.get('/source', async (_req, reply) => reply.header('cache-control', 'no-store').redirect(sourceUrl() ?? UPSTREAM_URL));

  app.get('/source.tar.gz', async (req, reply) => {
    const file = tarballPath(process.env);
    const st = file ? regularFile(file) : null;
    if (!st) return reply.code(404).send({ error: 'not found' });
    const etag = `"${tarballVersion(st)}"`;
    const lastModified = st.mtime.toUTCString();
    reply
      .header('etag', etag)
      .header('last-modified', lastModified)
      .header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff');
    const inm = req.headers['if-none-match'];
    const ims = Date.parse(String(req.headers['if-modified-since'] || ''));
    const fresh = inm !== undefined ? etagMatches(inm, etag) : Number.isFinite(ims) && Math.floor(st.mtimeMs / 1000) * 1000 <= ims;
    if (fresh) return reply.code(304).send();
    return reply
      .header('content-type', 'application/gzip')
      .header('content-length', String(st.size))
      .header('content-disposition', `attachment; filename="${DOWNLOAD_NAME}"`)
      .send(fs.createReadStream(file));
  });
}
