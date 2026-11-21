/**
 * The WP15 routes as a deployment serves them: `GET /api/projects/:id/cite-setup`
 * (the citations feature, registered by the feature host) and V1's
 * `GET /api/projects/:id/labels`, whose entries now carry kind, environment,
 * title, line and offset and leave commented-out labels out. A live edit
 * reaches both (open docs are flushed first). Accounts off; env is set
 * before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-cite-setup-route-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'ALDINE_BASE_PATH', 'ALDINE_PUBLIC_URL', 'DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_MCP', 'ALDINE_TEST_HOOKS']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();

const p = await store.createProject('Cite setup', {
  'main.tex': '\\documentclass[man,biblatex]{apa7}\n\\input{preamble}\n\\begin{document}\n\\section{Method}\\label{sec:method}\n% \\label{sec:old}\n\\input{figs}\n\\end{document}\n',
  'preamble.tex': '\\usepackage[capitalise]{cleveref}\n\\addbibresource{refs.bib}\n',
  'figs.tex': '\\begin{figure}\n\\caption{Mean reaction times}\\label{fig:rt}\n\\end{figure}\n',
  'refs.bib': '@article{a,\n  title = {T},\n  doi = {10.1/x}\n}\n',
});
const get = async (url) => {
  const r = await app.inject({ method: 'GET', url });
  return { status: r.statusCode, body: r.statusCode === 200 ? r.json() : r.body };
};

const s = await get(`/api/projects/${p.id}/cite-setup`);
eq(s.status, 200, 'cite-setup answers');
eq([s.body.family, s.body.familySource, s.body.label, s.body.cleveref, s.body.cleverefCapitalise], ['biblatex', 'apa7[biblatex]', 'biblatex · APA', true, true], 'the family from the apa7 option, cleveref from the \\input preamble');
eq(s.body.bibFiles, ['refs.bib'], 'the loaded .bib files');
eq(s.body.rootFile, 'main.tex', 'the project root by default');
eq((await get(`/api/projects/${p.id}/cite-setup?branch=..%2Fx`)).status, 400, 'a bad branch name is refused');
eq((await get(`/api/projects/${p.id}/cite-setup?root=figs.tex`)).body.family, 'bibtex', '?root= asks about another root file');
eq((await get(`/api/projects/${p.id}/cite-setup?root=..%2Fx.tex`)).body.rootFile, 'main.tex', 'a root outside the project falls back to the project root');
eq((await get('/api/projects/nosuchproj/cite-setup')).status, 404, 'a missing project is 404');

const l = await get(`/api/projects/${p.id}/labels?detail=1`);
eq(l.status, 200, 'labels answers');
const rows = l.body.map(({ label, file, line, kind, env, title }) => ({ label, file, line, kind, env, title }));
eq(rows.sort((x, y) => x.label.localeCompare(y.label)), [
  { label: 'fig:rt', file: 'figs.tex', line: 2, kind: 'figure', env: 'figure', title: 'Mean reaction times' },
  { label: 'sec:method', file: 'main.tex', line: 4, kind: 'section', env: 'section', title: 'Method' },
], 'kinds, titles and lines; the commented-out label is left out');

const bib = await get(`/api/projects/${p.id}/bib`);
eq([bib.body[0].key, bib.body[0].line, bib.body[0].doi], ['a', 1, '10.1/x'], '/bib entries carry line and doi');

// the preamble changes: the cached answer follows the content version
store.writeFile(p.id, 'main', 'preamble.tex', Buffer.from('\\usepackage{hyperref}\n'));
const { markPathsChanged } = await import('../src/collab.ts');
markPathsChanged(p.id, 'main', ['preamble.tex']);
const s2 = await get(`/api/projects/${p.id}/cite-setup`);
check(s2.body.hyperref && !s2.body.cleveref, 'a changed preamble gives a new answer');

await app.close();
console.log('cite-setup-route: ok');
process.exit(0);
