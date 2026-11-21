/**
 * WP35 Mendeley, through the real routes (accounts off) and a mock Mendeley:
 *  - Sign in with Mendeley: the state cookie is checked (a wrong state is
 *    refused), the code exchange uses Basic auth, the profile name is kept
 *  - a refused access token is refreshed and the rotated refresh token is
 *    saved at once; an expired one is refreshed before use
 *  - folders come through `Link: rel=next` pages; a folder link includes its
 *    subfolders, de-duplicated by document id
 *  - entries are built from the JSON: DOIs keep their underscores, a
 *    document's own citation key is kept, others get surname and year
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-mendeley-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_PUBLIC_URL', 'REMOTE_PROVIDERS']) delete process.env[k];
process.env.MENDELEY_CLIENT_ID = 'test-id';
process.env.MENDELEY_CLIENT_SECRET = 'test-secret';

const tokenCalls = [];
const valid = new Set(['A2', 'A3']); // A1 is refused: the first API call must refresh
const docs = {
  D1: { id: 'D1', type: 'journal', title: 'Owned Key Paper', authors: [{ first_name: 'Mia', last_name: 'Ross' }], year: 2020, source: 'Journal of Tests', identifiers: { doi: '10.1000/a_b' }, citation_key: 'mia2020own', abstract: 'Private', tags: ['t'] },
  D2: { id: 'D2', type: 'book_section', title: 'Notes on the Engine', authors: [{ first_name: 'Ada', last_name: 'Lovelace' }], year: 1843, source: 'Scientific Memoirs' },
};
const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (status, v, h = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(v)); };
  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const p = new URLSearchParams(body);
    tokenCalls.push({ auth: req.headers.authorization, grant: p.get('grant_type'), code: p.get('code'), refresh: p.get('refresh_token') });
    if (p.get('grant_type') === 'authorization_code' && p.get('code') === 'good') return json(200, { access_token: 'A1', refresh_token: 'R1', expires_in: 3600 });
    if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'R1') return json(200, { access_token: 'A2', refresh_token: 'R2', expires_in: 3600 });
    if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'R2') return json(200, { access_token: 'A3', refresh_token: 'R3', expires_in: 3600 });
    return json(400, { error: 'invalid_grant' });
  }
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (url.pathname === '/api/profiles/me') return json(200, { id: 'p1', display_name: 'Mia Ross' });
  if (!valid.has(token)) return json(401, { message: 'token expired' });
  const base = `http://127.0.0.1:${mock.address().port}/api`;
  if (url.pathname === '/api/groups') return json(200, [{ id: 'g1', name: 'Lab' }]);
  if (url.pathname === '/api/folders' && !url.searchParams.get('marker')) return json(200, [{ id: 'F1', name: 'Thesis' }], { Link: `<${base}/folders?limit=500&marker=2>; rel="next"` });
  if (url.pathname === '/api/folders') return json(200, [{ id: 'F2', name: 'Chapter', parent_id: 'F1' }]);
  if (url.pathname === '/api/documents') {
    const f = url.searchParams.get('folder_id');
    return json(200, f === 'F1' ? [docs.D1] : f === 'F2' ? [docs.D2, docs.D1] : [docs.D1, docs.D2]);
  }
  json(404, {});
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const port = mock.address().port;
process.env.MENDELEY_API_BASE = `http://127.0.0.1:${port}/api`;
process.env.MENDELEY_OAUTH_BASE = `http://127.0.0.1:${port}/oauth`;

const { default: Fastify } = await import('fastify');
const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const { registerFeatures } = await import('../src/features/host.ts');
const store = await import('../src/store.ts');
const link = await import('../src/refs/link.ts');
const { mendeleyEntry, nextLink } = await import('../src/refs/providers/mendeley.ts');
const app = Fastify({ logger: false });
await registerRoutes(app);
await registerFeatures(app);
await app.ready();

eq(nextLink('<https://a/x?p=1>; rel="prev", <https://a/x?p=3>; rel="next"'), 'https://a/x?p=3', 'the next page comes from the Link header');
const bib = mendeleyEntry(docs.D1, 'bibtex').bibtex;
check(bib.includes('doi     = {10.1000/a_b}') || /doi\s*=\s*\{10\.1000\/a_b\}/.test(bib), `a DOI keeps its underscore (${bib})`);

const p = await store.createProject('Mendeley');
const id = p.id;
const dir = store.branchDir(id, 'main');

eq((await app.inject({ method: 'GET', url: '/api/capabilities' })).json().libraries.mendeley, true, 'with an app registered, Mendeley is on');

// ---- sign in ----
let res = await app.inject({ method: 'GET', url: `/api/libraries/mendeley/connect?return=/p/${id}` });
eq(res.statusCode, 302, 'connect redirects to Mendeley');
const to = new URL(res.headers.location);
eq([to.pathname, to.searchParams.get('client_id'), to.searchParams.get('scope'), to.searchParams.get('response_type')], ['/oauth/authorize', 'test-id', 'all', 'code'], 'to the authorize page with the app and scope');
const state = to.searchParams.get('state');
const cookie = String(res.headers['set-cookie']).split(';')[0];
check(cookie.startsWith('laytekz_library_oauth=') && cookie.includes(state), 'with the state in a cookie');

res = await app.inject({ method: 'GET', url: `/api/libraries/mendeley/callback?code=good&state=${'0'.repeat(32)}`, headers: { cookie } });
check(res.statusCode === 302 && res.headers.location.endsWith('error=state'), `a wrong state is refused (${res.headers.location})`);
eq(tokenCalls.length, 0, 'and no code is exchanged');
res = await app.inject({ method: 'GET', url: `/api/libraries/mendeley/callback?code=good&state=${state}` });
check(res.headers.location.endsWith('error=state'), 'so is the right state without its cookie');

res = await app.inject({ method: 'GET', url: `/api/libraries/mendeley/connect?return=/p/${id}` });
const state2 = new URL(res.headers.location).searchParams.get('state');
const cookie2 = String(res.headers['set-cookie']).split(';')[0];
res = await app.inject({ method: 'GET', url: `/api/libraries/mendeley/callback?code=good&state=${state2}`, headers: { cookie: cookie2 } });
eq([res.statusCode, res.headers.location], [302, `/p/${id}?library=mendeley&connected=1`], 'the callback connects and sends the person back');
eq(tokenCalls[0], { auth: `Basic ${Buffer.from('test-id:test-secret').toString('base64')}`, grant: 'authorization_code', code: 'good', refresh: null }, 'the code exchange uses Basic auth');
res = await app.inject({ method: 'GET', url: '/api/libraries/mendeley/connection' });
eq([res.json().connected, res.json().name], [true, 'Mia Ross'], 'the connection names the account');
check(!res.body.includes('A1') && !res.body.includes('R1'), 'and never shows a token');

// ---- a refused token is refreshed, and the rotated token saved ----
res = await app.inject({ method: 'GET', url: '/api/libraries/mendeley/libraries' });
eq(res.json().libraries, [{ id: 'me', name: 'My library', kind: 'user' }, { id: 'group:g1', name: 'Lab', kind: 'group' }], `libraries list after a refresh (${res.body.slice(0, 200)})`);
eq(tokenCalls.at(-1).refresh, 'R1', 'the refresh used the first refresh token');
eq((await db().getConnection('local', 'mendeley')).refreshToken, 'R2', 'the rotated refresh token is saved');

res = await app.inject({ method: 'GET', url: '/api/libraries/mendeley/collections?library=me' });
eq(res.json().collections.map((c) => [c.id, c.path]), [['F1', 'Thesis'], ['F2', 'Thesis / Chapter']], 'folders from both Link pages, with paths');

await db().setConnection('local', 'mendeley', { ...(await db().getConnection('local', 'mendeley')), expiresAt: 0 });
valid.delete('A2');

// ---- link a folder ----
res = await app.inject({ method: 'POST', url: `/api/projects/${id}/libraries`, payload: { provider: 'mendeley', library: 'me', collection: 'F1' } });
eq(res.statusCode, 200, `link a folder (${res.body.slice(0, 200)})`);
eq([res.json().link.bibFile, res.json().link.collectionName], ['mendeley.bib', 'Thesis'], 'into mendeley.bib');
await link.settled(res.json().jobId);
const job = (await app.inject({ method: 'GET', url: `/api/projects/${id}/libraries/jobs/${res.json().jobId}` })).json();
eq([job.state, job.result?.itemCount], ['done', 2], `the folder and its subfolder, each document once (${JSON.stringify(job)})`);
eq(tokenCalls.at(-1).refresh, 'R2', 'an expired token was refreshed before use');
eq((await db().getConnection('local', 'mendeley')).refreshToken, 'R3', 'and the new refresh token saved');
const file = fs.readFileSync(path.join(dir, 'mendeley.bib'), 'utf8');
check(file.includes('@article{mia2020own,'), 'the document\'s own key is kept');
check(file.includes('@incollection{lovelace1843,'), `a document without one gets surname and year (${file})`);
check(file.includes('10.1000/a_b') && !file.includes('a\\_b'), 'the DOI is not escaped');
check(!/abstract|keywords/.test(file), 'abstracts and tags are left out by default');

eq((await app.inject({ method: 'DELETE', url: '/api/libraries/mendeley/connection' })).statusCode, 200, 'disconnect');
const list = (await app.inject({ method: 'GET', url: `/api/projects/${id}/libraries` })).json();
eq(list[0].pausedReason, 'Paused: you disconnected Mendeley. Link your own library or unlink.', 'the link pauses once its account is disconnected');

await app.close();
mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('mendeley: ok');
process.exit(0);
