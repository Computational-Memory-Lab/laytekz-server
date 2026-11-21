import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as store from './store.js';
import type { PublicUser } from './auth.js';
import { canEdit } from './authz.js';
import { outputPdfRel } from './compile.js';
import { BRANCH_RE } from './util.js';
import { thumbFiles, thumbVersion } from './thumbnail.js';

/**
 * Galley: page-1 thumbnails drawn by the browser. The deployed compiler has
 * no PDF rasterizer (ALDINE_THUMBNAILS=0, deploy/config/compiler.env.template),
 * so the editor renders page 1 of the PDF it already shows with pdf.js and
 * sends it here as a JPEG. The files land where apps/compiler/thumbnail.js
 * would have written them (thumbnail.ts thumbFiles), image first and sidecar
 * second, so GET /api/projects/:id/thumbnail and the list rows serve them
 * unchanged. The server never decodes the image: it checks the JPEG markers
 * and the frame size, and the GET route serves it as image/jpeg with nosniff.
 */

export const UPLOAD_MAX_BYTES = 512 * 1024;
/** Fastify's limit on this route alone, a little above UPLOAD_MAX_BYTES so an oversize image gets the plain 400. */
const BODY_LIMIT = 600 * 1024;
const MIN_W = 64, MAX_W = 1024, MIN_H = 64, MAX_H = 2048;
/** One stored image per project per this many milliseconds. */
export const WRITE_INTERVAL_MS = 10_000;

/** Pixel size from the first frame header, or null when `buf` is not a JPEG (the compiler's jpegSize). */
export function jpegSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    // SOF0-SOF15; C4 (DHT), C8 (JPG) and CC (DAC) share the range and are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = buf.readUInt16BE(i + 5);
      const w = buf.readUInt16BE(i + 7);
      return w > 0 && h > 0 ? { w, h } : null;
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/** When each project last had an image stored. */
const lastWrite = new Map<string, number>();

/** Takes the project's write slot, or returns the seconds until it is free. Synchronous, so two requests cannot both take it. */
function takeWriteSlot(projectId: string, now = Date.now()): number {
  const at = lastWrite.get(projectId);
  if (at !== undefined && now - at < WRITE_INTERVAL_MS) return Math.ceil((WRITE_INTERVAL_MS - (now - at)) / 1000);
  if (lastWrite.size > 10_000) for (const [k, t] of lastWrite) if (now - t >= WRITE_INTERVAL_MS) lastWrite.delete(k);
  lastWrite.set(projectId, now);
  return 0;
}

/** Tests only: forget every write slot. */
export function resetThumbnailUploadLimits(): void { lastWrite.clear(); }

/** Whether the sidecar under `dirAbs` was made from exactly this PDF, with its image there. */
function sidecarMatches(dirAbs: string, rootFile: string, st: fs.Stats): boolean {
  const f = thumbFiles(rootFile);
  try {
    const side = JSON.parse(fs.readFileSync(path.join(dirAbs, f.json), 'utf8'));
    return !!side?.pdf && side.pdf.size === st.size && side.pdf.mtimeMs === st.mtimeMs && fs.statSync(path.join(dirAbs, f.jpg)).isFile();
  } catch {
    return false;
  }
}

/** Writes `data` to a fresh temp file beside `dest` and renames it over `dest`. Never follows a link at either name, never creates a directory. */
function writeAtomic(dest: string, data: Buffer | string): void {
  const tmp = path.join(path.dirname(dest), `.thumb.up-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx', mode: 0o644 });
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * PUT /api/projects/:id/thumbnail?branch=<b>&pdfSize=<bytes>, body image/jpeg.
 * The global guard has already refused the trash (but for its owner, whom
 * the GET's trash view lets through), access tokens, showcases and people
 * who can only view; the handler checks the trash and edit rights again.
 */
export async function registerThumbnailUpload(app: FastifyInstance, reqUser: (req: FastifyRequest) => PublicUser | null): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, body, done) => done(null, body));
    scope.put<{ Params: { id: string }; Querystring: { branch?: string; pdfSize?: string } }>('/api/projects/:id/thumbnail', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
      const branch = req.query.branch || 'main';
      if (!BRANCH_RE.test(branch) || branch.includes('..')) return reply.code(400).send({ error: 'invalid branch name' });
      let meta: store.ProjectMeta;
      try { meta = await store.readMeta(req.params.id); } catch { return reply.code(404).send({ error: 'project not found' }); }
      if (meta.deletedAt) return reply.code(404).send({ error: 'project not found' });
      if (!canEdit(meta, reqUser(req))) return reply.code(403).send({ error: 'You can view this project, not change it. Ask its owner for edit access.' });

      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'Send the page image as an image/jpeg body' });
      if (body.length > UPLOAD_MAX_BYTES) return reply.code(400).send({ error: `The image is larger than ${UPLOAD_MAX_BYTES / 1024} KB` });
      const size = jpegSize(body);
      if (!size) return reply.code(400).send({ error: 'The image is not a JPEG' });
      if (size.w < MIN_W || size.w > MAX_W || size.h < MIN_H || size.h > MAX_H) {
        return reply.code(400).send({ error: `The image must be ${MIN_W} to ${MAX_W} pixels wide and ${MIN_H} to ${MAX_H} high` });
      }
      const sent = Number(req.query.pdfSize);
      if (!req.query.pdfSize || !Number.isSafeInteger(sent) || sent <= 0) return reply.code(400).send({ error: 'pdfSize (the size in bytes of the PDF the image was drawn from) is required' });

      let dir: string;
      try { dir = store.branchDir(meta.id, branch); } catch { return reply.code(400).send({ error: 'invalid branch name' }); }
      let st: fs.Stats;
      try {
        st = fs.statSync(path.join(dir, outputPdfRel(meta.rootFile)));
        if (!st.isFile()) throw new Error('not a file');
      } catch {
        return reply.code(409).send({ error: 'This branch has no typeset PDF' });
      }
      if (st.size !== sent) return reply.code(409).send({ error: 'The PDF changed since this image was drawn' });
      if (sidecarMatches(dir, meta.rootFile, st)) return reply.code(204).send();
      const wait = takeWriteSlot(meta.id);
      if (wait) return reply.code(429).header('retry-after', String(wait)).send({ error: 'A thumbnail was stored for this project moments ago — try again shortly' });

      const f = thumbFiles(meta.rootFile);
      const v = thumbVersion(body);
      try {
        // Image before sidecar: a reader that finds the sidecar finds its image.
        writeAtomic(path.join(dir, f.jpg), body);
        writeAtomic(path.join(dir, f.json), JSON.stringify({ v, w: size.w, h: size.h, pdf: { size: st.size, mtimeMs: st.mtimeMs } }));
      } catch (err) {
        req.log.warn({ err: (err as Error)?.message }, 'thumbnail upload could not be stored');
        return reply.code(409).send({ error: 'The typeset output moved while the image was being stored' });
      }
      return { ok: true, v, w: size.w, h: size.h };
    });
  });
}
