/**
 * F14 desk pet, server side (features/pet, WP39): loadPet's checks (still
 * PNG, WebP and SVG accepted with their sizes; JPEG, APNG, animated WebP,
 * GIF, oversize and missing files refused, each with a reason; silhouette
 * rules), then through buildApp with accounts on: the route is 401 signed
 * out and 200 signed in with `private` caching, `immutable` only for the
 * current version, an ETag and 304, nosniff, a sandbox CSP and CORP
 * same-origin; 404 for an unknown variant; the `pet` capability only for a
 * signed-in caller; the logo route unchanged.
 *
 * Env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-pet-')));
// Env before any src import (config.ts reads it at import time).
const ORIGIN = 'https://laytekz.test';
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_PUBLIC_URL = ORIGIN;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
for (const k of ['ALDINE_BASE_PATH', 'DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_MCP', 'ALDINE_OAUTH_REGISTRATION', 'ALDINE_TEST_HOOKS', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_INSTANCE_LOGO']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];


// ---- tiny images built here (never artwork) ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
function png(w, h, { animated = false } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (animated) parts.push(chunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])));
  parts.push(chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
function webpVp8x(w, h, flags) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(22, 4); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16); b[20] = flags; b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}
const write = (name, bytes) => { const f = path.join(tmp, name); fs.writeFileSync(f, bytes); return f; };

const files = {
  still: write('still.png', png(191, 178)),
  silhouette: write('silhouette.png', png(191, 178)),
  wide: write('wide.png', png(300, 100)),
  tiny: write('tiny.png', png(40, 37)),
  apng: write('anim.png', png(20, 20, { animated: true })),
  jpeg: write('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1])),
  gif: write('anim.gif', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')),
  webpStill: write('still.webp', webpVp8x(120, 110, 0x10)),
  webpAnim: write('anim.webp', webpVp8x(120, 110, 0x02)),
  svg: write('pet.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 90"><ellipse cx="48" cy="45" rx="40" ry="40" fill="#888"/></svg>')),
  big: write('big.png', Buffer.concat([png(10, 10), Buffer.alloc(600 * 1024)])),
  text: write('notes.txt', Buffer.from('hello')),
};

process.env.ALDINE_INSTANCE_PET = files.still;
process.env.ALDINE_INSTANCE_PET_SILHOUETTE = files.silhouette;
// No recorded squeak here (pet-squeak.test.mjs covers it), even when one is bundled.
process.env.ALDINE_INSTANCE_PET_SQUEAK = 'none';
const { loadPet } = await import('../src/features/pet/asset.ts');

// ---- loadPet ----
{
  const none = loadPet({});
  eq(none.pet, null, 'nothing configured: no pet');
  eq(none.warnings, [], 'nothing configured: no warnings');

  const ok = loadPet({ ALDINE_INSTANCE_PET: files.still });
  eq(ok.warnings, [], `a still PNG: no warnings (${ok.warnings})`);
  eq([ok.pet.type, ok.pet.w, ok.pet.h], ['image/png', 191, 178], 'a still PNG with its size');
  check(/^[0-9a-f]{12}$/.test(ok.pet.v), 'version is 12 hex digits');

  const webp = loadPet({ ALDINE_INSTANCE_PET: files.webpStill });
  eq([webp.pet?.type, webp.pet?.w, webp.pet?.h], ['image/webp', 120, 110], 'a still WebP with its size');
  const svg = loadPet({ ALDINE_INSTANCE_PET: files.svg });
  eq([svg.pet?.type, svg.pet?.w, svg.pet?.h], ['image/svg+xml', 96, 90], 'an SVG with its viewBox size');

  const refused = (file, re, what) => {
    const r = loadPet({ ALDINE_INSTANCE_PET: file });
    eq(r.pet, null, `${what}: refused`);
    check(r.warnings.length === 1 && re.test(r.warnings[0]), `${what}: says why (${r.warnings})`);
    check(r.warnings[0].includes('ALDINE_INSTANCE_PET'), `${what}: names the variable`);
  };
  refused(files.jpeg, /transparent background/, 'JPEG');
  refused(files.apng, /animated/, 'APNG');
  refused(files.webpAnim, /animated/, 'animated WebP');
  refused(files.gif, /animated/, 'GIF');
  refused(files.big, /larger than 512 KB/, 'over 512 KB');
  refused(path.join(tmp, 'missing.png'), /does not exist/, 'a missing file');
  refused(files.text, /not a PNG, WebP or SVG/, 'not an image');

  const small = loadPet({ ALDINE_INSTANCE_PET: files.tiny });
  check(small.pet && small.warnings.length === 1 && /37 px tall/.test(small.warnings[0]), 'a small image is used, with a warning');

  const sil = loadPet({ ALDINE_INSTANCE_PET: files.still, ALDINE_INSTANCE_PET_SILHOUETTE: files.silhouette });
  check(sil.silhouette && sil.warnings.length === 0, 'a matching silhouette is used');
  const lone = loadPet({ ALDINE_INSTANCE_PET_SILHOUETTE: files.silhouette });
  check(!lone.silhouette && /without a usable/.test(lone.warnings[0] ?? ''), 'a silhouette without an image: warning');
  const odd = loadPet({ ALDINE_INSTANCE_PET: files.still, ALDINE_INSTANCE_PET_SILHOUETTE: files.wide });
  check(!odd.silhouette && /different shape/.test(odd.warnings[0] ?? ''), 'a silhouette of another shape: warning');
}

// ---- the route and the capability, accounts on ----
const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();
const u = await auth.register('ada@example.com', 'password123', 'Ada');
const cookie = `aldine_session=${await auth.createSession(u.id)}`;
const v = loadPet({ ALDINE_INSTANCE_PET: files.still }).pet.v;
const get = (url, headers = {}) => app.inject({ method: 'GET', url, headers });

{
  const out = await get('/api/instance/pet');
  eq(out.statusCode, 401, `signed out: 401 (${out.body})`);
  check(!out.headers['content-type']?.startsWith('image/'), 'signed out: no image bytes');

  const r = await get('/api/instance/pet', { cookie });
  eq(r.statusCode, 200, `signed in: 200 (${r.body.slice(0, 100)})`);
  eq(r.headers['content-type'], 'image/png', 'served as PNG');
  eq(r.headers['cache-control'], 'private, no-cache', 'no version: private, revalidated');
  eq(r.headers.etag, `"${v}"`, 'an ETag of the version');
  eq(r.headers['x-content-type-options'], 'nosniff', 'nosniff');
  check(/sandbox/.test(r.headers['content-security-policy'] ?? ''), 'a sandbox CSP');
  eq(r.headers['cross-origin-resource-policy'], 'same-origin', 'CORP same-origin');
  eq(r.rawPayload.equals(fs.readFileSync(files.still)), true, 'the exact bytes');

  const hit = await get(`/api/instance/pet?v=${v}`, { cookie });
  eq(hit.headers['cache-control'], 'private, max-age=31536000, immutable', 'the current version: private and immutable');
  check(!/public/.test(hit.headers['cache-control']), 'never public');
  const stale = await get('/api/instance/pet?v=000000000000', { cookie });
  eq(stale.headers['cache-control'], 'private, no-cache', 'an old version is not immutable');

  const n = await get('/api/instance/pet', { cookie, 'if-none-match': `"${v}"` });
  eq(n.statusCode, 304, 'a matching If-None-Match: 304');

  eq((await get('/api/instance/pet/silhouette', { cookie })).statusCode, 200, 'the silhouette variant');
  eq((await get('/api/instance/pet/other', { cookie })).statusCode, 404, 'an unknown variant: 404');
  eq((await get('/api/instance/logo')).statusCode, 404, 'the logo route is unchanged (no logo configured: 404, public)');

  const capsOut = (await get('/api/capabilities')).json();
  eq(capsOut.pet, undefined, 'signed out: no pet capability');
  const caps = (await get('/api/capabilities', { cookie })).json();
  eq(caps.pet, { v, w: 191, h: 178, s: loadPet({ ALDINE_INSTANCE_PET: files.silhouette }).pet.v, q: null }, 'signed in: the pet capability');
}

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('pet-asset: ok');
process.exit(0);
