/**
 * Galley: V2 build outputs (WP30). GET /api/projects/:id/export/arxiv:
 * - 409 "Typeset first" before a typeset, after a draft, and when a .bib the
 *   document loads changed since the last typeset;
 * - the tracked tree plus main.bbl (named after the root) and the index and
 *   glossary files, minus hidden files (.gitignore, .latexmkrc), the working
 *   tree untouched;
 * - a biblatex .bbl outside ACCEPTED_BBL_FORMATS is left out with a warning;
 * - 00README.json only for XeLaTeX or several top-level documents;
 * - a subfolder root is re-rooted unless it reaches outside its folder;
 * - check=1 answers the warnings as JSON; the download is "<project> (arXiv).zip".
 *
 * Real app, auth off, throwaway JSON datastore.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-arxiv-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN', 'ALDINE_BASE_PATH']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const { unzip } = await import('../src/unzip.ts');
const { ACCEPTED_BBL_FORMATS, bblFormatVersion } = await import('../src/submission.ts');
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();

// The tested constant: arXiv's TeX Live 2025 reads biblatex .bbl format 3.3 only.
eq([...ACCEPTED_BBL_FORMATS], ['3.3'], 'accepted biblatex .bbl formats');
eq(bblFormatVersion('% $ biblatex auxiliary file $\n% $ biblatex bbl format version 3.3 $\n% Do not modify the above lines!\n'), '3.3', 'format line read');
eq(bblFormatVersion('\\begin{thebibliography}{1}\n'), null, 'a BibTeX .bbl has none');

const DOC = '\\documentclass{article}\n\\begin{document}\nA\\cite{k}\n\\bibliographystyle{plain}\\bibliography{refs}\n\\end{document}\n';
const BIB = '@book{k, title={T}, author={A}, year={2020}}\n';
const BBL = '\\begin{thebibliography}{1}\n\\bibitem{k} A. T. 2020.\n\\end{thebibliography}\n';
const age = (f, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(f, t, t); };
const write = (f, content, ageMs = 0) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); if (ageMs) age(f, ageMs); };
/** Stage what a full typeset leaves in <root dir>/.aldine-out: the sentinel after the sources, then the outputs. */
const typeset = (dir, { rootDir = '', base = 'main', aux = '\\citation{k}\n\\bibdata{refs}\n', bbl = BBL, extra = {} } = {}) => {
  const out = path.join(dir, rootDir, '.aldine-out');
  for (const f of fs.readdirSync(path.join(dir, rootDir))) if (!f.startsWith('.')) age(path.join(dir, rootDir, f), 120_000);
  write(path.join(out, '.aldine-run'), '', 60_000);
  write(path.join(out, `${base}.aux`), aux);
  write(path.join(out, `${base}.pdf`), '%PDF-1.5');
  if (bbl !== null) write(path.join(out, `${base}.bbl`), bbl);
  for (const [f, c] of Object.entries(extra)) write(path.join(out, f), c);
};
const exp = (id, q = '') => app.inject({ method: 'GET', url: `/api/projects/${id}/export/arxiv?branch=main${q}` });
const check1 = async (id) => { const r = await exp(id, '&check=1'); eq(r.statusCode, 200, `check answers (${r.body})`); return r.json(); };
const zipOf = async (id) => { const r = await exp(id); eq(r.statusCode, 200, `the ZIP downloads (${r.body.slice?.(0, 200)})`); return { res: r, files: unzip(r.rawPayload) }; };

try {
  // ---- a top-level root ----
  const p = await store.createProject('My paper', { 'main.tex': DOC, 'refs.bib': BIB, '.latexmkrc': '$pdf_mode = 1;\n', 'fig/plot.txt': 'data\n' });
  const dir = store.branchDir(p.id, 'main');

  let res = await exp(p.id);
  eq(res.statusCode, 409, 'before a typeset');
  eq(res.json(), { error: 'Typeset first: the arXiv ZIP includes files the typeset makes.', code: 'typeset-first' }, 'says to typeset first');

  typeset(dir, { extra: { 'main.ind': '\\begin{theindex}\\end{theindex}\n', 'main.log': 'log', 'main.blg': 'blg' } });
  let c = await check1(p.id);
  eq(c.warnings, [], 'no warnings for a plain pdfLaTeX paper');
  eq(c.name, 'My paper (arXiv).zip', 'named after the project');
  eq(c.files, ['fig/plot.txt', 'main.bbl', 'main.ind', 'main.tex', 'refs.bib'], 'tracked files plus main.bbl and main.ind; no .gitignore, .latexmkrc, log or .blg');
  eq(c.rerooted, null, 'not re-rooted');
  const { res: zres, files } = await zipOf(p.id);
  eq(Object.keys(files).sort(), c.files, 'the ZIP holds exactly those');
  eq(files['main.bbl'].toString(), BBL, 'main.bbl is the typeset\'s');
  eq(files['main.tex'].toString(), DOC, 'sources as committed');
  eq(zres.headers['content-type'], 'application/zip', 'a ZIP');
  check(zres.headers['content-disposition'].includes(`filename*=UTF-8''My%20paper%20%28arXiv%29.zip`), zres.headers['content-disposition']);
  eq(JSON.parse(decodeURIComponent(zres.headers['x-laytekz-warnings'])), [], 'the warnings travel in a header too');
  check(!fs.existsSync(path.join(dir, 'main.bbl')), 'the working tree is untouched');
  eq(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(), '', 'and git status is clean');

  // ---- stale: draft, edited .bib ----
  write(path.join(dir, '.aldine-out', '.aldine-draft'), '');
  res = await exp(p.id);
  eq(res.statusCode, 409, 'after a draft that skipped the bibliography');
  fs.rmSync(path.join(dir, '.aldine-out', '.aldine-draft'));
  fs.writeFileSync(path.join(dir, 'refs.bib'), `${BIB}@book{j, title={U}}\n`);
  res = await exp(p.id);
  eq(res.statusCode, 409, 'a .bib changed since the typeset');
  eq(res.json().error, 'Typeset first: refs.bib changed since the last typeset.', 'names the .bib');
  typeset(dir);
  eq((await exp(p.id, '&check=1')).statusCode, 200, 'a new typeset clears it');

  // ---- biblatex format ----
  const biblatexBbl = (v) => `% $ biblatex auxiliary file $\n% $ biblatex bbl format version ${v} $\n% Do not modify the above lines!\n\\endinput\n`;
  typeset(dir, { aux: '\\abx@aux@cite{0}{k}\n', bbl: biblatexBbl('3.2'), extra: { 'main.bcf': '<bcf:datasource type="file" datatype="bibtex" glob="false">refs.bib</bcf:datasource>' } });
  c = await check1(p.id);
  check(!c.files.includes('main.bbl'), 'a format 3.2 .bbl is left out');
  check(c.files.includes('refs.bib'), 'the .bib stays');
  eq(c.warnings.length, 1, 'with one warning');
  check(/main\.bbl was left out: it is in biblatex format 3\.2/.test(c.warnings[0]), c.warnings[0]);
  typeset(dir, { aux: '\\abx@aux@cite{0}{k}\n', bbl: biblatexBbl('3.3'), extra: { 'main.bcf': '<bcf:datasource type="file" datatype="bibtex" glob="false">refs.bib</bcf:datasource>' } });
  c = await check1(p.id);
  check(c.files.includes('main.bbl') && !c.warnings.length, 'format 3.3 is included');
  fs.rmSync(path.join(dir, '.aldine-out', 'main.bcf'));

  // ---- engines and 00README.json ----
  typeset(dir);
  const meta = await store.readMeta(p.id);
  meta.engine = 'xelatex';
  await store.writeMeta(meta);
  ({ files: c } = await zipOf(p.id));
  eq(JSON.parse(c['00README.json'].toString()), { process: { compiler: 'xelatex' }, sources: [{ filename: 'main.tex', usage: 'toplevel' }] }, 'XeLaTeX gets a 00README.json');
  meta.engine = 'lualatex';
  await store.writeMeta(meta);
  c = await check1(p.id);
  check(c.warnings.some((w) => /arXiv does not offer LuaLaTeX/.test(w)), 'LuaLaTeX is warned about');
  check(!c.files.includes('00README.json'), 'without a 00README');
  meta.engine = 'pdf';
  await store.writeMeta(meta);
  fs.writeFileSync(path.join(dir, 'response.tex'), '\\documentclass{letter}\n\\begin{document}x\\end{document}\n');
  typeset(dir);
  ({ files: c } = await zipOf(p.id));
  eq(JSON.parse(c['00README.json'].toString()).sources, [{ filename: 'main.tex', usage: 'toplevel' }], 'two top-level documents: the README names the main one');
  eq(JSON.parse(c['00README.json'].toString()).process.compiler, 'pdflatex', 'as pdfLaTeX');

  // ---- names arXiv may change ----
  fs.writeFileSync(path.join(dir, 'my figure.txt'), 'x');
  typeset(dir);
  c = await check1(p.id);
  check(c.warnings.some((w) => w.includes('my figure.txt')), 'a name with a space is warned about');

  // ---- a subfolder root ----
  const q = await store.createProject('Sub', { 'paper/main.tex': DOC, 'paper/refs.bib': BIB, 'notes/todo.md': 'x\n' });
  const qm = await store.readMeta(q.id);
  qm.rootFile = 'paper/main.tex';
  await store.writeMeta(qm);
  const qdir = store.branchDir(q.id, 'main');
  typeset(qdir, { rootDir: 'paper' });
  c = await check1(q.id);
  eq(c.rerooted, 'paper', 're-rooted at the main document\'s folder');
  eq(c.files, ['main.bbl', 'main.tex', 'refs.bib'], 'only that folder, main.bbl beside main.tex');
  const sub = await zipOf(q.id);
  eq(Object.keys(sub.files).sort(), ['main.bbl', 'main.tex', 'refs.bib'], 'the ZIP is re-rooted');
  fs.writeFileSync(path.join(qdir, 'paper', 'main.tex'), DOC.replace('A\\cite', '\\input{../notes/extra}A\\cite'));
  typeset(qdir, { rootDir: 'paper' });
  c = await check1(q.id);
  eq(c.rerooted, null, 'a document that reaches outside its folder is not re-rooted');
  check(c.files.includes('paper/main.tex') && c.files.includes('paper/main.bbl'), 'the whole tree, main.bbl beside main.tex');
  check(c.warnings.some((w) => /arXiv typesets from the top of the ZIP/.test(w)), 'and a warning says why');

  // ---- manual commits: the working tree, uncommitted file included ----
  const m = await store.readMeta(p.id);
  m.manualCommits = true;
  m.engine = 'pdf';
  await store.writeMeta(m);
  fs.rmSync(path.join(dir, 'response.tex'));
  fs.writeFileSync(path.join(dir, 'extra.tex'), 'uncommitted\n');
  typeset(dir);
  c = await check1(p.id);
  check(c.files.includes('extra.tex'), 'an uncommitted file is in the ZIP with manual commits');
  check(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).includes('extra.tex'), 'and stays uncommitted');

  console.log('arxiv archive: ALL PASSED');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
