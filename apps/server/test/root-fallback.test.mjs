/**
 * Galley: V2 build outputs (WP30). The main document is one project setting
 * for every branch. On a branch where that file does not exist (renamed or
 * deleted there), the typeset uses the root that branch would pick, for this
 * run only, adds a warning row, and leaves the project setting alone; other
 * branches typeset their own main document as before. SyncTeX lookups use the
 * same root. The project switch outputs.buildAux = false reaches the compiler
 * as buildAux: false.
 *
 * The compiler is a mock that records each request and answers success.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-root-fallback-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['DATABASE_URL', 'REDIS_URL', 'COMPILE_DEADLINE_MS']) delete process.env[k];

const requests = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    requests.push({ url: req.url, body });
    const base = path.basename(body.rootFile || 'main.tex', '.tex');
    const answer = req.url === '/compile'
      ? { ok: true, pdf: `.aldine-out/${base}.pdf`, pdfFresh: true, synctex: null, synctexFresh: false, log: 'ok', errors: [], durationMs: 1 }
      : { ok: true, file: 'x.tex', line: 1 };
    const buf = Buffer.from(JSON.stringify(answer));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
    res.end(buf);
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.COMPILER_URL = `http://127.0.0.1:${mock.address().port}`;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { compileProject, synctexLookup, rootFallback, BUILD_AUX_SETTING } = await import('../src/compile.ts');

const DOC = '\\documentclass{article}\n\\begin{document}\nA\n\\end{document}\n';
const last = () => requests[requests.length - 1];

try {
  const p = await store.createProject('Branches', { 'thesis.tex': DOC, 'refs.bib': '' });
  eq(p.rootFile, 'thesis.tex', 'the project\'s main document');
  await gitops.createBranch(p.id, 'b');
  const bdir = store.branchDir(p.id, 'b');
  fs.renameSync(path.join(bdir, 'thesis.tex'), path.join(bdir, 'paper.tex'));

  // ---- the branch without the main document ----
  eq(rootFallback(p.id, 'b', 'thesis.tex')?.root, 'paper.tex', 'the root branch b would pick');
  eq(rootFallback(p.id, 'main', 'thesis.tex'), null, 'main has its root: no fallback');
  let r = await compileProject(p.id, 'b');
  eq(last().body.rootFile, 'paper.tex', 'branch b typesets paper.tex');
  eq(r.errors[0], { type: 'warning', line: null, message: 'The main document thesis.tex isn\u2019t on this branch, so Laytekz typeset paper.tex instead.' }, 'and says so first');
  eq(r.ok, true, 'the run stands');
  eq(r.pdf, '.aldine-out/paper.pdf', 'with paper.pdf');
  eq((await store.readMeta(p.id)).rootFile, 'thesis.tex', 'the project setting is unchanged');

  // ---- other branches as before ----
  r = await compileProject(p.id, 'main');
  eq(last().body.rootFile, 'thesis.tex', 'main typesets thesis.tex');
  check(!r.errors.some((e) => /isn\u2019t on this branch/.test(e.message)), 'without the row');

  // ---- SyncTeX on the fallback branch ----
  await synctexLookup(p.id, 'b', { direction: 'forward', file: 'paper.tex', line: 1 });
  eq(last().url, '/synctex', 'a SyncTeX lookup');
  eq(last().body.rootFile, 'paper.tex', 'uses the root that branch typesets');

  // ---- nothing to fall back to: the stored root goes through, as today ----
  fs.rmSync(path.join(bdir, 'paper.tex'));
  eq(rootFallback(p.id, 'b', 'thesis.tex'), null, 'no .tex on the branch: no fallback');
  await compileProject(p.id, 'b');
  eq(last().body.rootFile, 'thesis.tex', 'the compiler reports the missing root itself');

  // ---- the build switch ----
  check(!('buildAux' in last().body), 'by default no buildAux field (the rules run)');
  const meta = await store.readMeta(p.id);
  meta.ext = { ...(meta.ext ?? {}), [BUILD_AUX_SETTING]: false };
  await store.writeMeta(meta);
  await compileProject(p.id, 'main');
  eq(last().body.buildAux, false, 'switched off: buildAux: false');
  meta.ext[BUILD_AUX_SETTING] = true;
  await store.writeMeta(meta);
  await compileProject(p.id, 'main');
  check(!('buildAux' in last().body), 'switched on again: no field');

  console.log('root fallback: ALL PASSED');
} finally {
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
