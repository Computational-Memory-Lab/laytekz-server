/**
 * Galley: V2 build outputs (WP30). A .bbl in the project is source for arXiv
 * users (an arXiv source ZIP has ms.bbl and no .bib), so:
 * - a new project's .gitignore no longer ignores *.bbl (build output still
 *   goes to .aldine-out, which stays ignored);
 * - an imported archive keeps its own .gitignore instead of getting ours;
 * - an imported ms.bbl is committed, so it is in the source ZIP and on a new branch.
 *
 * Real routes, auth off, throwaway JSON datastore.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, eq } from './assert.mjs';
import { buildZip } from './zip.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-gitignore-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN', 'ALDINE_BASE_PATH']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();
const lsFiles = (dir) => execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').sort();
const DOC = '\\documentclass{article}\n\\begin{document}\nA\\cite{k}\n\\bibliographystyle{plain}\\bibliography{ms}\n\\end{document}\n';

try {
  // ---- a new project ----
  const p = await store.createProject('Fresh');
  const gi = fs.readFileSync(path.join(store.branchDir(p.id, 'main'), '.gitignore'), 'utf8');
  eq(gi, store.DEFAULT_GITIGNORE, 'the default .gitignore');
  check(gi.split('\n').includes('.aldine-out/'), 'build output stays ignored');
  check(!gi.split('\n').includes('*.bbl'), 'a .bbl in the project is not ignored');
  fs.writeFileSync(path.join(store.branchDir(p.id, 'main'), 'main.bbl'), 'bbl');
  eq(execFileSync('git', ['status', '--porcelain', '--', 'main.bbl'], { cwd: store.branchDir(p.id, 'main'), encoding: 'utf8' }).trim(), '?? main.bbl', 'git sees an added main.bbl');

  // ---- an imported arXiv source with its own .gitignore ----
  const res = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { name: 'arXiv source', zipBase64: buildZip({ 'ms.tex': DOC, 'ms.bbl': '\\begin{thebibliography}{1}\\end{thebibliography}\n', '.gitignore': '*.pdf\n*.bbl\n' }).toString('base64') } });
  eq(res.statusCode, 200, `the import works (${res.body.slice(0, 200)})`);
  const id = res.json().id;
  const dir = store.branchDir(id, 'main');
  eq(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*.pdf\n*.bbl\n', 'the archive keeps its own .gitignore');
  // Its own rules ignore *.bbl, but the import's first commit tracks every seeded file it was given.
  const tracked = lsFiles(dir);
  check(tracked.includes('ms.tex') && tracked.includes('.gitignore'), `the sources are committed (${tracked})`);

  // An import whose .gitignore does not mention .bbl: ms.bbl is committed and travels to a new branch.
  const res2 = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { name: 'arXiv source 2', zipBase64: buildZip({ 'ms.tex': DOC, 'ms.bbl': 'BBL\n', '.gitignore': '*.pdf\n' }).toString('base64') } });
  eq(res2.statusCode, 200, 'the second import works');
  const id2 = res2.json().id;
  check(lsFiles(store.branchDir(id2, 'main')).includes('ms.bbl'), 'ms.bbl is committed');
  await gitops.createBranch(id2, 'revision');
  eq(fs.readFileSync(path.join(store.branchDir(id2, 'revision'), 'ms.bbl'), 'utf8'), 'BBL\n', 'and is on a new branch');

  // An import without a .gitignore gets the default one.
  const res3 = await app.inject({ method: 'POST', url: '/api/projects/import', payload: { name: 'Plain', zipBase64: buildZip({ 'main.tex': DOC, 'main.bbl': 'B\n' }).toString('base64') } });
  const dir3 = store.branchDir(res3.json().id, 'main');
  eq(fs.readFileSync(path.join(dir3, '.gitignore'), 'utf8'), store.DEFAULT_GITIGNORE, 'no .gitignore in the archive: the default');
  check(lsFiles(dir3).includes('main.bbl'), 'its main.bbl is committed');

  console.log('arxiv gitignore: ALL PASSED');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
