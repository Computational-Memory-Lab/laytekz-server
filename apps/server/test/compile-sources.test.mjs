/**
 * WP21: a typeset reports the hash of every open file's text it typeset
 * (CompileResult.sources, read in the flush itself), only when its PDF is
 * the one shown; and `GET /api/projects/:id/output/synctex` sends the SyncTeX
 * file with `x-synctex-run` naming the run that wrote it, refusing (409)
 * while no run is known for it. The compiler is a mock that answers whatever
 * the test queues next. Accounts off; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-compile-sources-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'ALDINE_BASE_PATH', 'ALDINE_PUBLIC_URL', 'DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_MCP', 'ALDINE_TEST_HOOKS']) delete process.env[k];

const queue = [];
const mock = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const buf = Buffer.from(JSON.stringify(queue.shift() ?? { ok: false, error: 'mock queue empty' }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
    res.end(buf);
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.COMPILER_URL = `http://127.0.0.1:${mock.address().port}`;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const { compileProject, outputSynctexRel, synctexRunId } = await import('../src/compile.ts');
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();

const sha16 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const meta = await store.createProject('Sources', { 'main.tex': 'One\r\nTwo é\r\n', 'other.tex': 'Closed.\n' }, null);
const dir = store.branchDir(meta.id, 'main');
fs.mkdirSync(path.join(dir, '.aldine-out'), { recursive: true });
fs.writeFileSync(path.join(dir, '.aldine-out', 'main.pdf'), '%PDF-1.5 placeholder');
const gz = zlib.gzipSync('SyncTeX Version:1\nInput:1:/x/./main.tex\nContent:\n');
fs.writeFileSync(path.join(dir, '.aldine-out', 'main.synctex.gz'), gz);

const good = { ok: true, pdf: '.aldine-out/main.pdf', pdfFresh: true, synctex: '.aldine-out/main.synctex.gz', synctexFresh: true, log: 'ok', errors: [], durationMs: 5 };
const fatal = { ok: false, exitCode: 1, pdf: '.aldine-out/main.pdf', pdfFresh: false, synctex: '.aldine-out/main.synctex.gz', synctexFresh: false, log: '! Emergency stop.', errors: [{ type: 'error', line: null, message: 'Emergency stop' }], durationMs: 5 };
const getSynctex = (q = '') => app.inject({ method: 'GET', url: `/api/projects/${meta.id}/output/synctex${q}` });

try {
  eq(outputSynctexRel('paper/main.tex'), 'paper/.aldine-out/main.synctex.gz', 'the SyncTeX file sits beside the PDF');
  eq(outputSynctexRel('main.tex'), '.aldine-out/main.synctex.gz', 'at the top too');
  eq(synctexRunId(meta.id, 'main'), null, 'no run known before the first typeset');
  eq((await getSynctex()).statusCode, 409, 'no SyncTeX file is offered for a run nobody knows');

  const conn = await collab.hocuspocus.openDirectConnection(collab.docName(meta.id, 'main', 'main.tex'), {});
  const text = collab.hocuspocus.documents.get(collab.docName(meta.id, 'main', 'main.tex')).getText('content');
  text.insert(text.length, 'Typed after the last save.\n');
  const typed = text.toString();

  queue.push({ ...good });
  const first = await compileProject(meta.id, 'main');
  check(first.sources && typeof first.sources === 'object', 'a typeset that shows its PDF reports the sources');
  eq(first.sources['main.tex'], sha16(typed.replace(/\r\n?/g, '\n')), "the open doc's text as it was flushed, with LF line endings");
  eq(Object.keys(first.sources), ['main.tex'], 'only open files are hashed');
  eq(synctexRunId(meta.id, 'main'), { id: first.compileId, path: '.aldine-out/main.synctex.gz' }, 'the SyncTeX file on disk is this run\'s');

  const r = await getSynctex();
  eq(r.statusCode, 200, 'the SyncTeX file is served');
  eq(r.headers['x-synctex-run'], String(first.compileId), 'x-synctex-run names the run that wrote it');
  eq(r.headers['x-synctex-path'], encodeURIComponent('.aldine-out/main.synctex.gz'), 'and which file it is');
  eq(r.headers['cache-control'], 'no-store', 'never cached');
  check(Buffer.compare(r.rawPayload, gz) === 0, 'the bytes as the compiler wrote them');
  eq((await getSynctex('?branch=..%2Fx')).statusCode, 400, 'a bad branch name is refused');
  eq((await app.inject({ method: 'GET', url: '/api/projects/nosuch/output/synctex' })).statusCode, 404, 'a missing project is 404');

  // latexmk found nothing to redo: the PDF shown is this run's result, and so are the hashes
  queue.push({ ...good, pdfFresh: false, synctexFresh: false });
  const same = await compileProject(meta.id, 'main');
  eq(same.compileId, first.compileId, 'an unchanged document keeps its compileId');
  eq(same.sources?.['main.tex'], first.sources['main.tex'], 'and reports the same hash');

  // a run that wrote no PDF: the PDF on screen is the previous one, which these hashes would not describe
  text.insert(0, 'X');
  queue.push({ ...fatal });
  const failed = await compileProject(meta.id, 'main');
  eq(failed.pdfStale, true, 'the failed run keeps the previous PDF');
  eq(failed.sources, undefined, 'and reports no sources');
  eq(synctexRunId(meta.id, 'main')?.id, first.compileId, 'the SyncTeX file on disk is still the first run\'s');
  eq((await getSynctex()).headers['x-synctex-run'], String(first.compileId), 'so the header still names it');

  queue.push({ ...good });
  const next = await compileProject(meta.id, 'main');
  check(next.compileId > first.compileId, 'a new run gets a new compileId');
  eq(next.sources['main.tex'], sha16(text.toString().replace(/\r\n?/g, '\n')), 'and the hash of the text it typeset');
  eq((await getSynctex()).headers['x-synctex-run'], String(next.compileId), 'the header follows the new SyncTeX file');
  await conn.disconnect();
} finally {
  mock.close();
  await app.close();
}
console.log('compile-sources: ok');
process.exit(0);
