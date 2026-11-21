/**
 * WP16 reference lookup, the project side, through the real routes (feature
 * host included) on a throwaway datastore with auth off and a mock doi.org:
 *  - the smith2020 collision: another Smith 2020 paper gets smith2020a and
 *    leaves the first entry untouched; the same paper again is a duplicate
 *    (preview, insert, and V1's /references/add)
 *  - a Latin-1 .bib is refused and its bytes left untouched
 *  - remove takes an append back by its hash, and refuses once it changed
 *  - an append into an open .bib goes through the live doc, beside typing
 *  - pasted BibTeX keeps its key; a looked-up entry gets the project's key
 *    style and capital protection; lookup and targets answer
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-refs-insert-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN', 'REMOTE_PROVIDERS', 'REFERENCES_ONLINE', 'REFERENCES_CONTACT_EMAIL']) delete process.env[k];

const ENTRIES = {
  '10.1000/b': '@article{Smith_2020, title={Protein Folding at Scale}, author={Smith, Bob}, year={2020}, doi={10.1000/b}}',
  '10.1000/c': '@article{Smith_2020, title={Weather Models and BERT}, author={Smith, Cal}, year={2020}, doi={10.1000/c}, journal={J}}',
};
const doiMock = http.createServer((req, res) => {
  const doi = decodeURIComponent(req.url.slice(1));
  if (ENTRIES[doi]) { res.writeHead(200, { 'content-type': 'application/x-bibtex' }); return res.end(ENTRIES[doi]); }
  res.writeHead(404); res.end();
});
await new Promise((r) => doiMock.listen(0, '127.0.0.1', r));
process.env.DOI_API_BASE = `http://127.0.0.1:${doiMock.address().port}`;
process.env.OPENALEX_API_BASE = `${process.env.DOI_API_BASE}/openalex`;

const { default: Fastify } = await import('fastify');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const { registerFeatures } = await import('../src/features/host.ts');
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const app = Fastify({ logger: false });
await registerRoutes(app);
await registerFeatures(app);
await app.ready();

const p = await store.createProject('Refs');
const id = p.id;
const dir = store.branchDir(id, 'main');
const disk = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const call = (method, tail, payload) => app.inject({ method, url: `/api/projects/${id}${tail}`, ...(payload ? { payload } : {}) });

const SMITH_A = '@article{smith2020,\n  title  = {Graph Methods for Sparse Data},\n  author = {Smith, Ann},\n  year   = {2020},\n  doi    = {10.1000/a},\n}\n';
fs.writeFileSync(path.join(dir, 'references.bib'), SMITH_A);

// ---- the collision regression ----
const SMITH_B = '@article{smith2020,\n  title = {Protein Folding at Scale},\n  author = {Smith, Bob},\n  year = {2020},\n  doi = {10.1000/b},\n}';
let res = await call('POST', '/references/preview', { branch: 'main', bibtex: SMITH_B, bibFile: 'references.bib' });
eq(res.statusCode, 200, `preview answers (${res.body.slice(0, 200)})`);
let pv = res.json();
eq([pv.key, pv.duplicate], ['smith2020a', null], 'another Smith 2020 paper: a suffixed key, not a duplicate');
check(/taken by another entry/.test(pv.keyNote || ''), `and a note says why (got ${pv.keyNote})`);
eq(disk('references.bib'), SMITH_A, 'a preview writes nothing');

res = await call('POST', '/references/insert', { branch: 'main', bibtex: pv.bibtex, key: pv.key, bibFile: 'references.bib' });
eq(res.statusCode, 200, `insert answers (${res.body.slice(0, 200)})`);
let ins = res.json();
eq([ins.key, ins.duplicate, ins.created], ['smith2020a', false, false], 'inserted as smith2020a');
check(/^[0-9a-f]{64}$/.test(ins.entryHash), 'with the entry hash');
check(disk('references.bib').startsWith(SMITH_A), 'the first entry is untouched');
check(disk('references.bib').includes('@article{smith2020a,'), 'the new entry is there under its own key');

res = await call('POST', '/references/insert', { branch: 'main', bibtex: '@article{whatever,\n  title = {Graph methods for sparse data},\n  doi = {10.1000/A},\n}', bibFile: 'references.bib' });
eq([res.json().duplicate, res.json().key], [true, 'smith2020'], 'the same paper again (DOI in another case) is a duplicate under the existing key');
res = await call('POST', '/references/preview', { branch: 'main', bibtex: SMITH_B });
eq([res.json().duplicate?.key, res.json().key], ['smith2020a', 'smith2020a'], 'and a preview of the second paper finds it now');

// V1's add (also behind MCP references_add) gains the same fix
res = await call('POST', '/references/add', { branch: 'main', query: '10.1000/c', bibFile: 'references.bib' });
eq([res.statusCode, res.json().key, res.json().duplicate], [200, 'smith2020b', false], `V1 add: a third Smith 2020 paper gets smith2020b (${res.body.slice(0, 200)})`);
res = await call('POST', '/references/add', { branch: 'main', query: '10.1000/c', bibFile: 'references.bib' });
eq([res.json().key, res.json().duplicate], ['smith2020b', true], 'and the same DOI again is a duplicate');

// ---- remove by hash ----
const beforeAdd = disk('references.bib');
res = await call('POST', '/references/insert', { branch: 'main', bibtex: '@misc{undo1,\n  title = {To Be Undone},\n  year = {2024},\n}', bibFile: 'references.bib' });
ins = res.json();
eq(ins.key, 'undo1', 'pasted BibTeX keeps its key');
res = await call('POST', '/references/remove', { branch: 'main', bibFile: 'references.bib', entryHash: ins.entryHash });
eq([res.statusCode, res.json().removed], [200, true], 'remove takes it back');
eq(disk('references.bib'), beforeAdd, 'the file is as before the add');
res = await call('POST', '/references/remove', { branch: 'main', bibFile: 'references.bib', entryHash: ins.entryHash });
eq([res.statusCode, res.json().code], [409, 'changed'], 'a second remove finds nothing to take back');
res = await call('POST', '/references/insert', { branch: 'main', bibtex: '@misc{undo2,\n  title = {Edited After},\n  year = {2024},\n}', bibFile: 'references.bib' });
ins = res.json();
fs.writeFileSync(path.join(dir, 'references.bib'), disk('references.bib').replace('Edited After', 'Edited After, by hand'));
res = await call('POST', '/references/remove', { branch: 'main', bibFile: 'references.bib', entryHash: ins.entryHash });
eq([res.statusCode, res.json().code], [409, 'changed'], 'an entry changed since is left in place');
check(disk('references.bib').includes('by hand'), 'and is still there');

// ---- a Latin-1 .bib is refused untouched ----
const latin1 = Buffer.from('@book{caf\xe9,\n  title = {Caf\xe9},\n}\n', 'latin1');
fs.writeFileSync(path.join(dir, 'latin1.bib'), latin1);
res = await call('POST', '/references/insert', { branch: 'main', bibtex: '@misc{x1,\n  title = {New},\n}', bibFile: 'latin1.bib' });
eq([res.statusCode, res.json().code], [409, 'not-utf8'], 'a non-UTF-8 target is refused');
check(/isn't UTF-8/.test(res.json().error), 'with a sentence that says why');
check(fs.readFileSync(path.join(dir, 'latin1.bib')).equals(latin1), 'and its bytes are untouched');
res = await call('POST', '/references/add', { branch: 'main', query: '10.1000/b', bibFile: 'latin1.bib' });
check(res.statusCode >= 400 && fs.readFileSync(path.join(dir, 'latin1.bib')).equals(latin1), 'V1 add refuses it too, bytes untouched');

// ---- targets ----
res = await call('GET', '/references/targets?branch=main');
const t = res.json();
eq(t.default, 'references.bib', 'the paper\'s loaded .bib is the default');
eq(t.targets.find((x) => x.path === 'latin1.bib')?.editable, false, 'the Latin-1 file is not editable');
eq(t.targets.find((x) => x.path === 'references.bib')?.loaded, true, 'references.bib is loaded by main.tex');

// ---- lookup, key style and capital protection ----
res = await app.inject({ method: 'GET', url: '/api/references/lookup?q=10.1000/c' });
eq([res.statusCode, res.json().kind, res.json().results[0]?.title], [200, 'doi', 'Weather Models and BERT'], `a DOI resolves to one result (${res.body.slice(0, 200)})`);
res = await call('GET', '/references/lookup?branch=main&q=10.1000/c');
eq(res.json().results[0]?.inProject, { key: 'smith2020b', bibFile: 'references.bib' }, 'the project lookup marks a paper already there');
res = await call('PATCH', '/settings', { set: { 'references.keyStyle': 'scholar' } });
eq(res.statusCode, 200, `the project key style is a project setting (${res.body.slice(0, 200)})`);
fs.writeFileSync(path.join(dir, 'other.bib'), '');
res = await call('POST', '/references/preview', { branch: 'main', id: 'doi:10.1000/c', bibFile: 'other.bib' });
pv = res.json();
eq(pv.duplicate, { key: 'smith2020b', bibFile: 'references.bib' }, 'a paper in another .bib is found there');
fs.writeFileSync(path.join(dir, 'references.bib'), SMITH_A);
res = await call('POST', '/references/preview', { branch: 'main', id: 'doi:10.1000/c', bibFile: 'other.bib' });
pv = res.json();
eq([pv.key, pv.duplicate], ['smith2020weather', null], `the Scholar key style (got ${pv.key})`);
check(/title\s+= \{Weather Models and \{BERT\}\}/.test(pv.bibtex), `capitals are protected (got ${pv.bibtex})`);
check(/journaltitle\s+= \{J\}/.test(pv.bibtex), 'biblatex field names for a biblatex paper');
res = await call('PATCH', '/settings', { set: { 'references.keyStyle': 'nonsense' } });
eq(res.statusCode, 400, 'an unknown key style is refused');

// ---- an open .bib: the append goes through the live doc, beside typing ----
fs.writeFileSync(path.join(dir, 'other.bib'), '@misc{first,\n  title = {First},\n}\n');
const conn = await collab.hocuspocus.openDirectConnection(collab.docName(id, 'main', 'other.bib'), {});
const ytext = conn.document.getText('content');
ytext.insert(0, '% typed, not saved\n');
res = await call('POST', '/references/insert', { branch: 'main', bibtex: pv.bibtex, key: pv.key, bibFile: 'other.bib' });
eq([res.statusCode, res.json().key], [200, 'smith2020weather'], 'added to the open file');
const live = ytext.toString();
check(live.startsWith('% typed, not saved\n@misc{first,') && live.includes('@article{smith2020weather,'), `the live doc has the typing and the entry (got ${JSON.stringify(live)})`);
eq(disk('other.bib'), live, 'and the disk copy matches');
res = await call('POST', '/references/remove', { branch: 'main', bibFile: 'other.bib', entryHash: res.json().entryHash });
eq(res.statusCode, 200, 'remove works on the open doc');
eq(ytext.toString(), '% typed, not saved\n@misc{first,\n  title = {First},\n}\n', 'and leaves the typing');
await conn.disconnect();

await app.close();
doiMock.close();
console.log('refs-insert tests passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
