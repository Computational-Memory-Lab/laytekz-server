/**
 * The AGPL source offer (galley-source.ts): GALLEY_SOURCE_URL, or the
 * GALLEY_SOURCE_TARBALL served at <base path>/source.tar.gz, is stamped into
 * index.html for the web app's source links; without either the page is
 * unchanged and the links stay upstream's. The tarball route serves that one
 * file or answers 404, whatever the request adds.
 *
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-galley-source-'));
process.env.ALDINE_BASE_PATH = '/x';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
delete process.env.ALDINE_PUBLIC_URL;
delete process.env.AUTH_ENABLED;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.GALLEY_SOURCE_URL;
delete process.env.GALLEY_SOURCE_TARBALL;
fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<!doctype html><html><head><title>Aldine</title></head><body></body></html>\n');
const tarball = path.join(tmp, 'galley 1.16.0+fork.tar.gz');
const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]);
fs.writeFileSync(tarball, bytes);

const { initDb } = await import('../src/db/index.ts');
await initDb();
const { buildApp } = await import('../src/app.ts');
const s = await import('../src/galley-source.ts');
const app = await buildApp();

const meta = (html) => /<meta name="galley-source" content="([^"]*)"/.exec(html)?.[1] ?? null;

// ---- settings ----
{
  eq(s.sourceUrl({}), null, 'nothing set: upstream');
  eq(s.sourceUrl({ GALLEY_SOURCE_URL: 'https://git.example.org/galley' }), 'https://git.example.org/galley', 'an https URL');
  eq(s.sourceUrl({ GALLEY_SOURCE_URL: '/x/source.tar.gz' }), '/x/source.tar.gz', 'a path on this origin');
  const version = s.tarballVersion(fs.statSync(tarball));
  check(/^[0-9a-z]+-[0-9a-z]+$/.test(version), `the tarball's version is its size and time (${version})`);
  eq(s.sourceUrl({ GALLEY_SOURCE_TARBALL: tarball }), `/x/source.tar.gz?v=${version}`, 'a tarball alone: its route, under the base path, named by version');
  eq(s.sourceUrl({ GALLEY_SOURCE_TARBALL: path.join(tmp, 'missing.tar.gz') }), '/x/source.tar.gz', 'an unreadable tarball: the bare route');
  eq(s.sourceUrl({ GALLEY_SOURCE_URL: 'https://git.example.org/galley', GALLEY_SOURCE_TARBALL: tarball }), 'https://git.example.org/galley', 'the URL wins');
  // deploy/config/app.env.template names the server's own route as the URL too: it is linked by version.
  eq(s.sourceUrl({ GALLEY_SOURCE_URL: 'https://laytekz.example/x/source.tar.gz', ALDINE_PUBLIC_URL: 'https://laytekz.example', GALLEY_SOURCE_TARBALL: tarball }),
    `https://laytekz.example/x/source.tar.gz?v=${version}`, 'the server\'s own tarball route as GALLEY_SOURCE_URL is linked by version');
  eq(s.sourceUrl({ GALLEY_SOURCE_URL: '/x/source.tar.gz', GALLEY_SOURCE_TARBALL: tarball }), `/x/source.tar.gz?v=${version}`, 'as a path too');
  eq(s.sourceUrl({ GALLEY_SOURCE_URL: 'https://other.example/x/source.tar.gz', ALDINE_PUBLIC_URL: 'https://laytekz.example', GALLEY_SOURCE_TARBALL: tarball }),
    'https://other.example/x/source.tar.gz', 'another host\'s tarball is left alone');
  eq(s.sourceUrl({ GALLEY_SOURCE_URL: '/x/source.tar.gz' }), '/x/source.tar.gz', 'without a tarball there is no version to add');
  for (const bad of ['javascript:alert(1)', '//evil.example/x', 'ftp://x.example/y', 'https://x.example/"><script>', 'not a url'])
    eq(s.sourceUrl({ GALLEY_SOURCE_URL: bad }), null, `refuses ${bad}`);
  eq(s.sourceConfigWarnings({}), [], 'no warnings when unset');
  check(s.sourceConfigWarnings({ GALLEY_SOURCE_URL: 'javascript:alert(1)' })[0]?.includes('GALLEY_SOURCE_URL'), 'an unusable URL is warned about');
  check(s.sourceConfigWarnings({ GALLEY_SOURCE_TARBALL: path.join(tmp, 'missing.tar.gz') })[0]?.includes('404'), 'a missing tarball is warned about');
  eq(s.sourceConfigWarnings({ GALLEY_SOURCE_TARBALL: tarball }), [], 'a readable tarball is not');
  eq(s.stampSource('<head><title>A</title></head>', null), '<head><title>A</title></head>', 'no stamp for upstream');
  eq(meta(s.stampSource('<head></head>', 'https://x.example/?a=1&b="2"')), 'https://x.example/?a=1&amp;b=&quot;2&quot;', 'the stamp is attribute-escaped');
}

// ---- the page and the route ----
{
  let page = await app.inject({ method: 'GET', url: '/x/' });
  eq(meta(page.body), null, 'unset: the page is not stamped');
  let r = await app.inject({ method: 'GET', url: '/x/source.tar.gz' });
  eq(r.statusCode, 404, 'unset: no tarball');
  r = await app.inject({ method: 'GET', url: '/x/source' });
  eq(r.statusCode, 302, '/source redirects');
  eq(r.headers.location, 'https://github.com/trahloff/Aldine', 'to upstream while nothing is configured');
  eq(r.headers['cache-control'], 'no-store', 'and is never cached');

  process.env.GALLEY_SOURCE_TARBALL = path.join(tmp, 'missing.tar.gz');
  eq((await app.inject({ method: 'GET', url: '/x/source.tar.gz' })).statusCode, 404, 'a missing file: 404');
  process.env.GALLEY_SOURCE_TARBALL = tmp;
  eq((await app.inject({ method: 'GET', url: '/x/source.tar.gz' })).statusCode, 404, 'a directory: 404, never a listing');

  process.env.GALLEY_SOURCE_TARBALL = tarball;
  page = await app.inject({ method: 'GET', url: '/x/' });
  eq(meta(page.body), `/x/source.tar.gz?v=${s.tarballVersion(fs.statSync(tarball))}`, 'the page points the source links at the tarball');
  r = await app.inject({ method: 'GET', url: '/x/source.tar.gz' });
  eq(r.statusCode, 200, 'the tarball is served');
  check(r.rawPayload.equals(bytes), 'byte for byte');
  eq(r.headers['content-type'], 'application/gzip', 'as gzip');
  eq(r.headers['content-disposition'], 'attachment; filename="laytekz-source.tar.gz"', 'as a download named after the product, whatever the file on disk is called');
  eq(r.headers['x-content-type-options'], 'nosniff', 'never sniffed');
  const etag = r.headers.etag;
  check(/^"[0-9a-z]+-[0-9a-z]+"$/.test(etag), `with an ETag (${etag})`);
  eq(r.headers['last-modified'], fs.statSync(tarball).mtime.toUTCString(), 'and Last-Modified');
  eq(r.headers['cache-control'], 'no-cache', 'revalidated on every use');
  r = await app.inject({ method: 'GET', url: '/x/source.tar.gz', headers: { 'if-none-match': etag } });
  eq(r.statusCode, 304, 'a matching If-None-Match: 304');
  eq(r.rawPayload.length, 0, 'with no body');
  r = await app.inject({ method: 'GET', url: '/x/source.tar.gz', headers: { 'if-modified-since': new Date(Date.now() + 60_000).toUTCString() } });
  eq(r.statusCode, 304, 'If-Modified-Since after the file\'s time: 304');
  r = await app.inject({ method: 'GET', url: '/x/source.tar.gz', headers: { 'if-none-match': '"other"', 'if-modified-since': new Date(Date.now() + 60_000).toUTCString() } });
  eq(r.statusCode, 200, 'If-None-Match decides when both are sent');
  // A new tarball (a deploy) is a new version: new ETag, new link.
  const later = new Date(Date.now() + 5_000);
  fs.writeFileSync(tarball, Buffer.concat([bytes, Buffer.from([9])]));
  fs.utimesSync(tarball, later, later);
  r = await app.inject({ method: 'GET', url: '/x/source.tar.gz', headers: { 'if-none-match': etag } });
  eq(r.statusCode, 200, 'the old ETag no longer matches a replaced tarball');
  check(r.headers.etag !== etag, 'which has a new one');
  page = await app.inject({ method: 'GET', url: '/x/' });
  eq(meta(page.body), `/x/source.tar.gz?v=${s.tarballVersion(fs.statSync(tarball))}`, 'and the page links the new version without a restart');
  fs.writeFileSync(tarball, bytes);
  r = await app.inject({ method: 'GET', url: '/x/source.tar.gz?file=../../etc/passwd' });
  check(r.statusCode === 200 && r.rawPayload.equals(bytes), 'the query changes nothing');
  r = await app.inject({ method: 'GET', url: '/x/source.tar.gz/other.tar.gz' });
  check(r.headers['content-type'] !== 'application/gzip' && !r.rawPayload.equals(bytes), 'no path parameters: a longer path is not the tarball');
  eq((await app.inject({ method: 'GET', url: '/source.tar.gz' })).statusCode, 404, 'outside the base path: not served');
  eq((await app.inject({ method: 'HEAD', url: '/x/source.tar.gz' })).statusCode, 200, 'HEAD works');

  r = await app.inject({ method: 'GET', url: '/x/source' });
  eq(r.headers.location, `/x/source.tar.gz?v=${s.tarballVersion(fs.statSync(tarball))}`, '/source leads to the current tarball');

  process.env.GALLEY_SOURCE_URL = 'https://git.example.org/galley/tree/v1';
  page = await app.inject({ method: 'GET', url: '/x/' });
  eq(meta(page.body), 'https://git.example.org/galley/tree/v1', 'GALLEY_SOURCE_URL wins on the page');
  r = await app.inject({ method: 'GET', url: '/x/source' });
  eq(r.headers.location, 'https://git.example.org/galley/tree/v1', 'and for /source');
  delete process.env.GALLEY_SOURCE_URL;
  delete process.env.GALLEY_SOURCE_TARBALL;
}

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('galley source: ALL PASSED');
