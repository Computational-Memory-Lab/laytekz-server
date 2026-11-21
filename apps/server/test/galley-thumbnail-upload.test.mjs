/**
 * Galley: PUT /api/projects/:id/thumbnail, the page-1 image the editor draws
 * with pdf.js (thumbnail-upload.ts), with accounts on.
 *
 * - Only someone who can edit the project stores one: a "Can view"
 *   collaborator and a stranger get 403, nobody signed in 401, an access
 *   token 403, and a trashed project 404 even for its owner.
 * - Only a JPEG of 64..1024 × 64..2048 pixels and at most 512 KB is taken
 *   (400 otherwise; Fastify answers 413 above the route's 600 KB limit).
 * - The image must be of the branch's current PDF: no PDF or another size
 *   than the client says it drew is 409 and writes nothing.
 * - The files land where the compiler's renderer writes them, and the GET
 *   route and the list row serve them. The same PDF again is 204 without a
 *   write; a second write within 10 s is 429.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-thumbnail-upload-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_PROTECTED_PROJECTS;

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const { thumbFiles, thumbVersion } = await import('../src/thumbnail.ts');
const { jpegSize, resetThumbnailUploadLimits } = await import('../src/thumbnail-upload.ts');
const { registerRoutes } = await import('../src/routes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify();
await registerRoutes(app);

const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAARAAwDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAL/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCtAIUAA//Z', 'base64');

/** TINY_JPEG with its frame header claiming `w` × `h` (the server reads the header, it never decodes). */
function sized(w, h, tail = '') {
  const buf = Buffer.concat([TINY_JPEG]);
  let i = 2;
  for (;;) {
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) break;
    i += 2 + buf.readUInt16BE(i + 2);
  }
  buf.writeUInt16BE(h, i + 5);
  buf.writeUInt16BE(w, i + 7);
  return tail ? Buffer.concat([buf, Buffer.from(tail)]) : buf;
}

const session = async (email, name) => {
  const u = await auth.register(email, 'password123', name);
  await db().setEmailPending(u.id, null);
  return `aldine_session=${await auth.createSession(u.id)}`;
};
const owner = await session('owner@example.com', 'Ada Owner');
const viewer = await session('viewer@example.com', 'Val Viewer');
const editor = await session('editor@example.com', 'Ed Editor');
const stranger = await session('stranger@example.com', 'Sam Stranger');
const ownerUser = await auth.userFromRequest(owner);

const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';
const meta = await store.createProject('Paper', { 'main.tex': doc }, ownerUser.id);
meta.share = { mode: 'private', collaborators: ['viewer@example.com', 'editor@example.com'], viewers: ['viewer@example.com'] };
await store.writeMeta(meta);
const id = meta.id;
const dir = store.branchDir(id, 'main');
const f = thumbFiles('main.tex');
const pdfAbs = path.join(dir, '.aldine-out', 'main.pdf');

const put = (headers, body, query) => app.inject({
  method: 'PUT',
  url: `/api/projects/${id}/thumbnail?${query}`,
  headers: { 'content-type': 'image/jpeg', ...headers },
  payload: body,
});
const sizeQ = () => `branch=main&pdfSize=${fs.statSync(pdfAbs).size}`;
const stored = () => fs.existsSync(path.join(dir, f.jpg)) || fs.existsSync(path.join(dir, f.json));
const listRow = async (cookie) => (await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } })).json().find((p) => p.id === id);

try {
  const A4 = sized(512, 724);
  eq(jpegSize(A4), { w: 512, h: 724 }, 'the test image claims 512 × 724');

  // ---- no PDF yet ----
  let res = await put({ cookie: owner }, A4, 'branch=main&pdfSize=1234');
  eq(res.statusCode, 409, 'no typeset PDF: 409');
  check(!stored(), 'and nothing written');

  fs.mkdirSync(path.dirname(pdfAbs), { recursive: true });
  fs.writeFileSync(pdfAbs, '%PDF-1.5\n% the first typeset\n%%EOF\n');

  // ---- who may ----
  eq((await put({ cookie: viewer }, A4, sizeQ())).statusCode, 403, 'a "Can view" collaborator: 403');
  eq((await put({ cookie: stranger }, A4, sizeQ())).statusCode, 403, 'a stranger: 403');
  eq((await put({}, A4, sizeQ())).statusCode, 401, 'nobody signed in: 401');
  const token = (await auth.createAccessToken(ownerUser.id, 'this', [id], null)).token;
  eq((await put({ authorization: `Bearer ${token}` }, A4, sizeQ())).statusCode, 403, "the owner's access token: 403");
  check(!stored(), 'none of them wrote anything');

  // ---- what is taken ----
  for (const [what, body, q] of [
    ['not a JPEG', Buffer.from('\x89PNG\r\n\x1a\n not a jpeg'), sizeQ()],
    ['a JPEG of 12 × 17', TINY_JPEG, sizeQ()],
    ['a JPEG 2000 wide', sized(2000, 724), sizeQ()],
    ['a JPEG 3000 high', sized(512, 3000), sizeQ()],
    ['over 512 KB', sized(512, 724, 'x'.repeat(520 * 1024)), sizeQ()],
    ['no pdfSize', A4, 'branch=main'],
    ['a branch name that is no branch', A4, `branch=${encodeURIComponent('../x')}&pdfSize=1`],
  ]) {
    res = await put({ cookie: owner }, body, q);
    eq(res.statusCode, 400, `${what}: 400`);
    check(typeof res.json().error === 'string', `${what}: a plain message (${res.json().error})`);
  }
  eq((await put({ cookie: owner }, sized(512, 724, 'x'.repeat(700 * 1024)), sizeQ())).statusCode, 413, 'over the route body limit: 413');
  eq((await put({ cookie: owner, 'content-type': 'application/octet-stream' }, A4, sizeQ())).statusCode, 415, 'another content type: 415');
  check(!stored(), 'nothing written for any of them');

  // ---- of the current PDF only ----
  res = await put({ cookie: owner }, A4, `branch=main&pdfSize=${fs.statSync(pdfAbs).size + 1}`);
  eq(res.statusCode, 409, 'drawn from a PDF of another size: 409');
  check(!stored(), 'and nothing written');

  // ---- stored ----
  res = await put({ cookie: editor }, A4, sizeQ());
  eq(res.statusCode, 200, 'an invited editor stores it');
  const v = thumbVersion(A4);
  eq(res.json(), { ok: true, v, w: 512, h: 724 }, 'the answer names version and size');
  check(fs.readFileSync(path.join(dir, f.jpg)).equals(A4), "the image is at the compiler's path");
  const st = fs.statSync(pdfAbs);
  eq(JSON.parse(fs.readFileSync(path.join(dir, f.json), 'utf8')), { v, w: 512, h: 724, pdf: { size: st.size, mtimeMs: st.mtimeMs } }, "the sidecar is the compiler's, stamped with the PDF on disk");
  check(!fs.readdirSync(path.dirname(pdfAbs)).some((n) => n.includes('.tmp')), 'no temp file left behind');
  res = await app.inject({ method: 'GET', url: `/api/projects/${id}/thumbnail?branch=main&v=${v}`, headers: { cookie: owner } });
  eq(res.statusCode, 200, 'the GET route serves it');
  eq(res.headers['content-type'], 'image/jpeg', 'as image/jpeg');
  check(res.rawPayload.equals(A4), 'the bytes uploaded');
  eq((await listRow(owner)).thumb, { branch: 'main', w: 512, h: 724, v }, 'and the list row points at it');
  eq((await app.inject({ method: 'GET', url: `/api/projects/${id}/thumbnail?branch=main`, headers: { cookie: viewer } })).statusCode, 200, 'a "Can view" collaborator sees it');
  eq((await app.inject({ method: 'GET', url: `/api/projects/${id}/thumbnail?branch=main`, headers: { cookie: stranger } })).statusCode, 403, 'a stranger still does not');

  // ---- unchanged: no write ----
  const before = fs.statSync(path.join(dir, f.json)).mtimeMs;
  res = await put({ cookie: owner }, sized(512, 724, 'again'), sizeQ());
  eq(res.statusCode, 204, 'the same PDF again: 204');
  eq(fs.statSync(path.join(dir, f.json)).mtimeMs, before, 'the sidecar untouched');
  check(fs.readFileSync(path.join(dir, f.jpg)).equals(A4), 'and the image too');

  // ---- a new typeset ----
  fs.writeFileSync(pdfAbs, '%PDF-1.5\n% the second typeset, a little longer\n%%EOF\n');
  const B = sized(512, 662, 'second');
  res = await put({ cookie: owner }, B, sizeQ());
  eq(res.statusCode, 429, 'a second write within 10 s: 429');
  check(Number(res.headers['retry-after']) > 0, 'with Retry-After');
  resetThumbnailUploadLimits();
  res = await put({ cookie: owner }, B, sizeQ());
  eq(res.statusCode, 200, 'after the interval the new image is stored');
  eq((await listRow(owner)).thumb, { branch: 'main', w: 512, h: 662, v: thumbVersion(B) }, 'and listed');

  // ---- the trash ----
  resetThumbnailUploadLimits();
  eq((await app.inject({ method: 'DELETE', url: `/api/projects/${id}`, headers: { cookie: owner } })).statusCode, 200, 'the owner trashes the project');
  fs.writeFileSync(pdfAbs, '%PDF-1.5\n% a third\n%%EOF\n');
  eq((await put({ cookie: owner }, A4, sizeQ())).statusCode, 404, 'a trashed project takes no image, even from its owner');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('galley-thumbnail-upload: all assertions passed');
process.exit(0);
