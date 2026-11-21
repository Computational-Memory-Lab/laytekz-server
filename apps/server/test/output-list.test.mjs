/**
 * Galley: V2 build outputs (WP30). GET /api/projects/:id/output/list reads
 * the main document's .aldine-out: regular files only (no dotfiles, no fmt/,
 * no links), "this typeset" from the .aldine-run sentinel, a tracked state
 * for the files Add to project accepts. GET …/download/pdf names the PDF
 * after the project (inline or attachment, with an ASCII fallback). The
 * capability tells clients the routes exist.
 *
 * Real app (buildApp, features registered) on a throwaway JSON datastore, auth off.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-output-list-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN', 'ALDINE_BASE_PATH']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const { buildApp } = await import('../src/app.ts');
const { downloadName, contentDisposition } = await import('../src/features/outputs/server.ts');
const app = await buildApp();

const DOC = '\\documentclass{article}\n\\begin{document}\nA\n\\end{document}\n';
const p = await store.createProject('Ünïcode: paper/draft', { 'main.tex': DOC });
const dir = store.branchDir(p.id, 'main');
const out = path.join(dir, '.aldine-out');
const list = async (branch = 'main', id = p.id) => app.inject({ method: 'GET', url: `/api/projects/${id}/output/list?branch=${encodeURIComponent(branch)}` });
const write = (f, content, ageMs = 0) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(f, t, t); }
};

try {
  // ---- before any typeset ----
  let res = await list();
  eq(res.statusCode, 200, `list answers (${res.body})`);
  eq(res.json(), { root: 'main.tex', outDir: '.aldine-out', typesetAt: null, files: [] }, 'nothing generated yet');
  res = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/download/pdf` });
  eq(res.statusCode, 404, 'no PDF yet');
  eq(res.json().code, 'typeset-first', 'says to typeset first');

  // ---- after a typeset ----
  write(path.join(out, 'main.log'), 'old log', 120_000);
  write(path.join(out, '.aldine-run'), '', 1_000);
  write(path.join(out, 'main.bbl'), '\\begin{thebibliography}{1}\\end{thebibliography}\n');
  write(path.join(out, 'main.pdf'), '%PDF-1.5 test');
  write(path.join(out, 'main.aux'), '\\relax\n');
  write(path.join(out, '.main.thumb.jpg'), 'jpg');
  write(path.join(out, 'fmt', 'main', 'main.fmt'), 'fmt');
  fs.symlinkSync('../main.tex', path.join(out, 'link.gls'));
  res = await list();
  const body = res.json();
  eq(body.files.map((f) => f.name), ['main.aux', 'main.bbl', 'main.log', 'main.pdf'], 'regular files only: no dotfiles, no fmt/, no links');
  check(typeof body.typesetAt === 'string', 'typesetAt from the sentinel');
  const byName = Object.fromEntries(body.files.map((f) => [f.name, f]));
  eq(byName['main.log'].fromLastRun, false, 'a file older than the sentinel is from an earlier typeset');
  eq(byName['main.bbl'].fromLastRun, true, 'a newer one is this typeset\'s');
  eq(byName['main.bbl'].path, '.aldine-out/main.bbl', 'the path /output serves');
  eq(byName['main.bbl'].size, fs.statSync(path.join(out, 'main.bbl')).size, 'size');
  eq(byName['main.bbl'].keepable, true, '.bbl can be added to the project');
  eq(byName['main.bbl'].tracked, null, 'and is not in it');
  eq(byName['main.pdf'].keepable, false, 'the PDF cannot');
  check(!('tracked' in byName['main.pdf']), 'and has no tracked state');
  eq(res.headers['cache-control'], 'no-store', 'never cached');

  write(path.join(dir, 'main.bbl'), fs.readFileSync(path.join(out, 'main.bbl')));
  eq((await list()).json().files.find((f) => f.name === 'main.bbl').tracked, 'same', 'a project copy with the same bytes');
  write(path.join(dir, 'main.bbl'), 'edited');
  eq((await list()).json().files.find((f) => f.name === 'main.bbl').tracked, 'differs', 'a project copy that differs');

  // ---- the root in a subfolder ----
  const q = await store.createProject('Sub', { 'paper/main.tex': DOC });
  const qm = await store.readMeta(q.id);
  qm.rootFile = 'paper/main.tex';
  await store.writeMeta(qm);
  write(path.join(store.branchDir(q.id, 'main'), 'paper', '.aldine-out', 'main.bbl'), 'b');
  write(path.join(store.branchDir(q.id, 'main'), '.aldine-out', 'other.bbl'), 'not this root\'s');
  const sub = (await list('main', q.id)).json();
  eq(sub.outDir, 'paper/.aldine-out', 'the subfolder root\'s output folder');
  eq(sub.files.map((f) => f.path), ['paper/.aldine-out/main.bbl'], 'only that folder');

  // ---- refusals ----
  eq((await list('../x')).statusCode, 400, 'a bad branch name');
  eq((await list('nope')).statusCode, 404, 'an unknown branch');
  check((await list('main', 'zzzzzzzz')).statusCode >= 400, 'an unknown project');

  // ---- the PDF, named after the project ----
  res = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/download/pdf?branch=main` });
  eq(res.statusCode, 200, 'the PDF downloads');
  eq(res.headers['content-type'], 'application/pdf', 'as a PDF');
  eq(res.body, '%PDF-1.5 test', 'the typeset\'s bytes');
  eq(res.headers['content-disposition'], `attachment; filename="Unicode- paper-draft.pdf"; filename*=UTF-8''${encodeURIComponent('Ünïcode- paper-draft.pdf')}`, 'named after the project, with an ASCII fallback');
  res = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/download/pdf?inline=1` });
  check(res.headers['content-disposition'].startsWith('inline; '), 'inline=1 shows it in the browser');

  eq(downloadName('CON', '.pdf'), 'CON-.pdf', 'a Windows device name is changed');
  eq(downloadName('  ', '.pdf'), 'document.pdf', 'an empty name falls back');
  eq(downloadName('Draft. ', '.zip'), 'Draft.zip', 'no trailing dots or spaces');
  eq(downloadName('A "quoted" <name>?', '.pdf'), 'A -quoted- -name--.pdf', 'reserved characters');
  eq(contentDisposition('attachment', 'Ω.zip'), `attachment; filename="document.zip"; filename*=UTF-8''%CE%A9.zip`, 'a name with no ASCII letters falls back to document');
  eq(contentDisposition('attachment', 'My paper (arXiv).zip'), `attachment; filename="My paper (arXiv).zip"; filename*=UTF-8''My%20paper%20%28arXiv%29.zip`, 'parentheses escaped in the UTF-8 name');

  // ---- the capability ----
  res = await app.inject({ method: 'GET', url: '/api/capabilities' });
  eq(res.json().outputs, { list: true, keep: true, arxiv: true, pdf: true }, 'capabilities name the routes');

  console.log('output list: ALL PASSED');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
