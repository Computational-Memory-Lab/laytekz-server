/**
 * F14 desk pet, server side (features/pet, PET2): the recorded squeak.
 * audioType tells MP3, Ogg and WAV from their first bytes; loadPet takes
 * ALDINE_INSTANCE_PET_SQUEAK (512 KB at most, refusals with a reason, nothing
 * without a pet); withDefaultPet finds squeak.mp3/.ogg/.wav next to the
 * bundled pet, and `none` turns it off. Then through buildApp with accounts
 * on: /api/instance/pet/squeak is 401 signed out and 200 signed in with the
 * image route's headers, the capability's `q` is its version; with no squeak
 * `q` is null and the route is 404, so the app synthesizes the squeak.
 *
 * Env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-squeak-')));
const ORIGIN = 'https://laytekz.test';
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_PUBLIC_URL = ORIGIN;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
for (const k of ['ALDINE_BASE_PATH', 'DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_MCP', 'ALDINE_OAUTH_REGISTRATION', 'ALDINE_TEST_HOOKS', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_INSTANCE_LOGO']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];

// ---- tiny files built here ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
function png(w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 4 + 1) * h))), chunk('IEND', Buffer.alloc(0))]);
}
function wav(samples) {
  const data = Buffer.alloc(samples * 2);
  const b = Buffer.alloc(44);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + data.length, 4); b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1'); b.writeUInt32LE(data.length, 40);
  return Buffer.concat([b, data]);
}
const id3 = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(400)]);
const write = (name, bytes) => { const f = path.join(tmp, name); fs.writeFileSync(f, bytes); return f; };
const files = {
  pet: write('pet.png', png(96, 90)),
  mp3: write('squeak.mp3', id3),
  frameMp3: write('frame.mp3', Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(200)])),
  ogg: write('squeak.ogg', Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(100)])),
  wav: write('squeak.wav', wav(800)),
  big: write('big.mp3', Buffer.concat([id3, Buffer.alloc(600 * 1024)])),
  text: write('notes.mp3', Buffer.from('not audio at all')),
};
const bundledDir = path.join(tmp, 'bundled') + path.sep;
fs.mkdirSync(bundledDir);
fs.copyFileSync(files.ogg, path.join(bundledDir, 'squeak.ogg'));
const emptyDir = path.join(tmp, 'empty') + path.sep;
fs.mkdirSync(emptyDir);

process.env.ALDINE_INSTANCE_PET = files.pet;
process.env.ALDINE_INSTANCE_PET_SQUEAK = files.mp3;
const { audioType, loadPet, MAX_SQUEAK_BYTES } = await import('../src/features/pet/asset.ts');
const { withDefaultPet, bundledSqueak, resetPetForTests } = await import('../src/features/pet/server.ts');

// ---- audioType ----
eq(audioType(fs.readFileSync(files.mp3)), 'audio/mpeg', 'MP3 with an ID3 tag');
eq(audioType(fs.readFileSync(files.frameMp3)), 'audio/mpeg', 'MP3 starting with a frame');
eq(audioType(fs.readFileSync(files.ogg)), 'audio/ogg', 'Ogg');
eq(audioType(fs.readFileSync(files.wav)), 'audio/wav', 'WAV');
eq(audioType(fs.readFileSync(files.pet)), null, 'a PNG is not audio');
eq(audioType(Buffer.from([0xff, 0xe0, 0, 0])), null, 'a reserved MPEG layer is not audio');
eq(MAX_SQUEAK_BYTES, 512 * 1024, '512 KB at most');

// ---- loadPet ----
{
  const ok = loadPet({ ALDINE_INSTANCE_PET: files.pet, ALDINE_INSTANCE_PET_SQUEAK: files.mp3 });
  eq(ok.warnings, [], `a good MP3: no warnings (${ok.warnings})`);
  eq(ok.squeak?.type, 'audio/mpeg', 'served as audio/mpeg');
  check(/^[0-9a-f]{12}$/.test(ok.squeak?.v ?? ''), 'a 12-hex version');
  eq(loadPet({ ALDINE_INSTANCE_PET: files.pet, ALDINE_INSTANCE_PET_SQUEAK: files.wav }).squeak?.type, 'audio/wav', 'WAV accepted');
  eq(loadPet({ ALDINE_INSTANCE_PET: files.pet }).squeak, null, 'no squeak configured: none, quietly');

  const refused = (file, re, what) => {
    const r = loadPet({ ALDINE_INSTANCE_PET: files.pet, ALDINE_INSTANCE_PET_SQUEAK: file });
    eq(r.squeak, null, `${what}: refused`);
    eq(r.pet?.type, 'image/png', `${what}: the pet itself is still used`);
    check(r.warnings.length === 1 && re.test(r.warnings[0]) && r.warnings[0].includes('ALDINE_INSTANCE_PET_SQUEAK'), `${what}: says why (${r.warnings})`);
  };
  refused(files.big, /larger than 512 KB/, 'over 512 KB');
  refused(files.text, /not an MP3, Ogg or WAV/, 'not audio');
  refused(path.join(tmp, 'missing.mp3'), /does not exist/, 'a missing file');

  const lone = loadPet({ ALDINE_INSTANCE_PET_SQUEAK: files.mp3 });
  check(!lone.pet && !lone.squeak && lone.warnings.length === 0, 'a squeak without a pet: nothing, quietly');
}

// ---- the bundled squeak ----
{
  eq(bundledSqueak(bundledDir), path.join(bundledDir, 'squeak.ogg'), 'finds squeak.ogg next to the bundled pet');
  eq(bundledSqueak(emptyDir), '', 'no file: none');
  eq(withDefaultPet({}, bundledDir).ALDINE_INSTANCE_PET_SQUEAK, path.join(bundledDir, 'squeak.ogg'), 'used by default');
  eq(withDefaultPet({}, emptyDir).ALDINE_INSTANCE_PET_SQUEAK, '', 'no bundled file: the app synthesizes');
  eq(withDefaultPet({ ALDINE_INSTANCE_PET_SQUEAK: 'None' }, bundledDir).ALDINE_INSTANCE_PET_SQUEAK, '', '`none` turns it off');
  eq(withDefaultPet({ ALDINE_INSTANCE_PET_SQUEAK: files.wav }, bundledDir).ALDINE_INSTANCE_PET_SQUEAK, files.wav, "the operator's own file wins");
  eq(withDefaultPet({ ALDINE_INSTANCE_PET: 'none' }, bundledDir).ALDINE_INSTANCE_PET_SQUEAK, '', 'no pet, no squeak');
  eq(withDefaultPet({ ALDINE_INSTANCE_PET: files.pet }, bundledDir).ALDINE_INSTANCE_PET_SQUEAK, path.join(bundledDir, 'squeak.ogg'), "the bundled squeak also goes with an operator's image");
}

// ---- the route and the capability, accounts on ----
const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();
const u = await auth.register('ada@example.com', 'password123', 'Ada');
const cookie = `aldine_session=${await auth.createSession(u.id)}`;
const get = (url, headers = {}) => app.inject({ method: 'GET', url, headers });
const q = loadPet({ ALDINE_INSTANCE_PET: files.pet, ALDINE_INSTANCE_PET_SQUEAK: files.mp3 }).squeak.v;

{
  const out = await get('/api/instance/pet/squeak');
  eq(out.statusCode, 401, `signed out: 401 (${out.body})`);
  check(!out.headers['content-type']?.startsWith('audio/'), 'signed out: no audio bytes');

  const r = await get(`/api/instance/pet/squeak?v=${q}`, { cookie });
  eq(r.statusCode, 200, `signed in: 200 (${r.body.slice(0, 80)})`);
  eq(r.headers['content-type'], 'audio/mpeg', 'served as audio/mpeg');
  eq(r.headers['cache-control'], 'private, max-age=31536000, immutable', 'the current version: private and immutable');
  eq(r.headers.etag, `"${q}"`, 'an ETag of the version');
  eq(r.headers['x-content-type-options'], 'nosniff', 'nosniff');
  eq(r.headers['cross-origin-resource-policy'], 'same-origin', 'CORP same-origin');
  check(/sandbox/.test(r.headers['content-security-policy'] ?? ''), 'a sandbox CSP');
  eq(r.rawPayload.equals(fs.readFileSync(files.mp3)), true, 'the exact bytes');
  eq((await get('/api/instance/pet/squeak', { cookie, 'if-none-match': `"${q}"` })).statusCode, 304, 'a matching If-None-Match: 304');

  const caps = (await get('/api/capabilities', { cookie })).json();
  eq(caps.pet?.q, q, "the capability names the squeak's version");
  eq((await get('/api/capabilities')).json().pet, undefined, 'signed out: no pet capability');
}

// ---- no squeak: q is null, the route 404s, the image is unchanged ----
{
  process.env.ALDINE_INSTANCE_PET_SQUEAK = 'none';
  resetPetForTests();
  const caps = (await get('/api/capabilities', { cookie })).json();
  eq(caps.pet?.q, null, 'no squeak: q is null (the app synthesizes)');
  check(typeof caps.pet?.v === 'string', 'the pet is still offered');
  eq((await get('/api/instance/pet/squeak', { cookie })).statusCode, 404, 'no squeak: 404');
  eq((await get('/api/instance/pet', { cookie })).statusCode, 200, 'the image route is unchanged');
}

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('pet-squeak: ok');
process.exit(0);
