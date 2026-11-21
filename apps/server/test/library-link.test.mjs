/**
 * WP35 library links, through the real routes and feature host, accounts on,
 * a throwaway datastore and a mock Zotero API:
 *  - a legacy meta.zotero shows as the link `zotero`
 *  - the owner links a collection: subcollections are included, de-duplicated
 *    by item key, and abstracts and tags are left out by default
 *  - a second member links their own library to zotero-<name>.bib
 *  - a link visitor cannot link; a member cannot unlink another's link
 *  - a sync answers a job at once (a slow library does not hold the request)
 *  - a key renamed in Zotero is reported and "update citations" rewrites the .tex
 *  - the sync commit holds only the .bib
 *  - a link pauses when its linker loses access
 *  - a desktop push writes the file; the capabilities say OAuth is off
 * Plus the pure helpers: the field filter and the cite scanner.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-library-link-')));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_PUBLIC_URL', 'REMOTE_PROVIDERS', 'MENDELEY_CLIENT_ID', 'MENDELEY_CLIENT_SECRET', 'ZOTERO_OAUTH_CLIENT_KEY', 'ZOTERO_OAUTH_CLIENT_SECRET']) delete process.env[k];

let turingKey = 'turing1950';
let version = 10;
let slowMs = 0;
const item = (key, bibKey, title, extra = '') => ({ key, version, biblatex: `\n@article{${bibKey},\n\ttitle = {${title}},\n\tauthor = {Someone, A.},\n\tabstract = {A private {summary}, with a comma},\n\tkeywords = {secret-tag},\n\tdate = {1950},${extra}\n}\n` });
const zot = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['zotero-api-key'];
  const json = (v, h = {}) => { res.writeHead(200, { 'content-type': 'application/json', 'Last-Modified-Version': String(version), 'Total-Results': String(Array.isArray(v) ? v.length : 0), ...h }); res.end(JSON.stringify(v)); };
  if (key !== 'owner-key' && key !== 'member-key') { res.writeHead(403); return res.end('Forbidden'); }
  if (url.pathname === '/keys/current') return json(key === 'owner-key' ? { userID: 7, username: 'ada' } : { userID: 8, username: 'bob' });
  if (/^\/users\/\d+\/groups$/.test(url.pathname)) return json([]);
  if (url.pathname === '/users/7/collections') return json([
    { key: 'COLL1', data: { name: 'Thesis', parentCollection: false } },
    { key: 'COLL2', data: { name: 'Chapter 2', parentCollection: 'COLL1' } },
    { key: 'COLL3', data: { name: 'Other', parentCollection: false } },
  ]);
  if (req.headers['if-modified-since-version'] && Number(req.headers['if-modified-since-version']) >= version) { res.writeHead(304); return res.end(); }
  if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
  if (url.pathname.endsWith('/items/top') && url.searchParams.get('format') === 'versions') return json({});
  if (url.pathname === '/users/7/collections/COLL1/items/top') return json([item('ITEM1', turingKey, 'Computing Machinery')]);
  if (url.pathname === '/users/7/collections/COLL2/items/top') return json([item('ITEM2', 'shannon1948', 'Communication {Theory}'), item('ITEM1', turingKey, 'Computing Machinery')]);
  if (url.pathname === '/users/7/collections/COLL3/items/top') return json([item('ITEM3', 'other2000', 'Elsewhere')]);
  if (url.pathname === '/users/8/items/top') return json([item('ITEM9', 'bobpaper2001', 'Bob Paper')]);
  res.writeHead(404); res.end();
});
await new Promise((r) => zot.listen(0, '127.0.0.1', r));
process.env.ZOTERO_API_BASE = `http://127.0.0.1:${zot.address().port}`;

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const link = await import('../src/refs/link.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { registerFeatures } = await import('../src/features/host.ts');
const Fastify = (await import('fastify')).default;

// ---- pure helpers ----
const STRIP_IN = '@article{a,\n  title = {Keep, {this}},\n  abstract = {Drop {nested, } text},\n  keywords = "x, y",\n  year = 2020,\n  note = {kept}\n}\n@string{abstract = "macro"}\n';
eq(link.stripFields(STRIP_IN, link.omitFieldNames(['abstract', 'tags'])),
  '@article{a,\n  title = {Keep, {this}},\n  year = 2020,\n  note = {kept}\n}\n@string{abstract = "macro"}\n', 'the filter drops whole fields, nested braces and quotes included, and leaves @string alone');
eq(link.stripFields('@misc{b, abstract={x}}', link.omitFieldNames(['abstract'])), '@misc{b,}', 'a last field without a trailing comma goes too');
eq([...link.citedKeys('\\cite{a, b}\\parencite[p.~2]{c}% \\cite{hidden}\n\\textcite{d}\\cites{e}{f}')].sort(), ['a', 'b', 'c', 'd', 'e', 'f'], 'cites are found, comments skipped');
const text = 'See \\cite{old,keep} and \\citep[see][2]{ old }.';
const edits = link.renameEdits(text, new Map([['old', 'new']]));
let renamed = text;
for (const e of [...edits].sort((a, b) => b.from - a.from)) renamed = renamed.slice(0, e.from) + e.insert + renamed.slice(e.to);
eq(renamed, 'See \\cite{new,keep} and \\citep[see][2]{ new }.', 'renames touch only the key, spacing kept');
// Sign in with Zotero signs with OAuth 1.0a HMAC-SHA1: the published example request (RFC 5849 style, Twitter's documentation vector).
const { oauthHeader } = await import('../src/refs/providers/zotero.ts');
const signed = oauthHeader('POST', 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true&status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21',
  { key: 'xvz1evFS4wEEPTGEFPHBog', secret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw' },
  { key: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', secret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' }, {},
  'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', '1318622958');
eq(decodeURIComponent(/oauth_signature="([^"]+)"/.exec(signed)[1]), 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=', 'the OAuth 1.0a signature matches the published example');
eq(link.detectRenames({ I1: 'old', I2: 'same', I3: 'uncited' }, [{ itemId: 'I1', key: 'new' }, { itemId: 'I2', key: 'same' }, { itemId: 'I3', key: 'x' }], new Set(['old', 'same'])), [{ from: 'old', to: 'new' }], 'only a cited key that disappeared counts as renamed');

// ---- the server ----
const owner = await auth.register('owner@example.com', 'password123', 'Ada Owner');
const member = await auth.register('member@example.com', 'password123', 'Bob Member');
await db().setEmailPending(member.id, null);
const visitor = await auth.register('visitor@example.com', 'password123', 'Visitor');
const session = async (u) => `${auth.COOKIE}=${await auth.createSession(u.id)}`;

const MAIN = '\\documentclass{article}\\begin{document}\\cite{turing1950} and \\cite{shannon1948}\\end{document}\n';
const created = await store.createProject('Libraries', { 'main.tex': MAIN }, owner.id);
const id = created.id;
await store.writeMeta({ ...(await store.readMeta(id)), share: { mode: 'link', collaborators: ['member@example.com'] }, zotero: { apiKey: 'owner-key', userId: 7, libraryPrefix: 'users/7', bibFile: 'legacy.bib', lastSyncedAt: '2026-01-01T00:00:00.000Z' } });

const app = Fastify({ logger: false });
await registerRoutes(app);
await registerFeatures(app);
await app.ready();
const call = async (u, method, url, payload) => app.inject({ method, url, headers: { cookie: await session(u) }, ...(payload !== undefined ? { payload } : {}) });
const proj = (u, method, tail, payload) => call(u, method, `/api/projects/${id}${tail}`, payload);
const dir = store.branchDir(id, 'main');
const disk = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const settle = async (jobId) => (await link.settled(jobId), (await proj(owner, 'GET', `/libraries/jobs/${jobId}`)).json());

const caps = (await call(owner, 'GET', '/api/capabilities')).json();
eq(caps.libraries, { zotero: { key: true, oauth: false }, mendeley: false, desktopFile: true, maxLinks: 5 }, 'the OAuth capabilities stay false until configured');
eq((await call(owner, 'GET', '/api/libraries/mendeley/connection')).json().enabled, false, 'Mendeley is off without an app');

// ---- legacy link ----
let list = (await proj(owner, 'GET', '/libraries')).json();
eq(list.map((l) => [l.id, l.provider, l.bibFile, l.legacy, l.linkedBy]), [['zotero', 'zotero', 'legacy.bib', true, owner.id]], 'a legacy meta.zotero appears as the link zotero');
check(!JSON.stringify(list).includes('owner-key'), 'the key never leaves the server');

// ---- connections ----
eq((await call(owner, 'PUT', '/api/libraries/zotero/connection', { apiKey: 'owner-key' })).json().connected, true, 'the owner connects Zotero with a key');
eq((await call(member, 'PUT', '/api/libraries/zotero/connection', { apiKey: 'member-key' })).json().name, 'bob', 'the member connects their own');
eq((await call(owner, 'GET', '/api/libraries/zotero/libraries')).json().libraries[0], { id: 'users/7', name: 'My Library', kind: 'user' }, 'libraries list');
eq((await call(owner, 'GET', '/api/libraries/zotero/collections?library=users/7')).json().collections.find((c) => c.id === 'COLL2').path, 'Thesis / Chapter 2', 'collections carry their paths');

// ---- the owner links a collection: subcollections included ----
let res = await proj(owner, 'POST', '/libraries', { provider: 'zotero', library: 'users/7', collection: 'COLL1' });
eq(res.statusCode, 200, `the owner links a collection (${res.body.slice(0, 300)})`);
const ownerLink = res.json().link;
eq([ownerLink.bibFile, ownerLink.recursive, ownerLink.collectionName, ownerLink.omitFields], ['zotero.bib', true, 'Thesis', ['abstract', 'files', 'tags']], 'zotero.bib, subcollections on, private fields left out');
let job = await settle(res.json().jobId);
eq([job.state, job.result?.itemCount], ['done', 2], `the job syncs both items once (${JSON.stringify(job)})`);
let bib = disk('zotero.bib');
check(bib.includes('@article{turing1950,') && bib.includes('@article{shannon1948,'), 'the subcollection item is in the file');
eq((bib.match(/@article\{turing1950,/g) || []).length, 1, 'an item in both collections appears once');
check(!/abstract|keywords|secret-tag/.test(bib), 'abstracts and tags are left out');
check(bib.startsWith('% Synced from Zotero (Ada Owner\'s My Library > Thesis) by Laytekz.'), `the header names the source (${bib.split('\n')[0]})`);
const last = execFileSync('git', ['-C', dir, 'log', '-1', '--name-only', '--format=%s'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
eq(last, ['laytekz: sync Zotero library into zotero.bib', 'zotero.bib'], 'the sync commit holds only the .bib');

// ---- a second member links their own library ----
eq((await proj(visitor, 'POST', '/libraries', { provider: 'zotero', library: 'users/7' })).statusCode, 403, 'a link visitor cannot link');
res = await proj(member, 'POST', '/libraries', { provider: 'zotero', library: 'users/8' });
eq(res.statusCode, 200, `the member links (${res.body.slice(0, 200)})`);
const memberLink = res.json().link;
eq(memberLink.bibFile, 'zotero-bob.bib', 'into zotero-<first name>.bib because zotero.bib is taken');
await settle(res.json().jobId);
check(disk('zotero-bob.bib').includes('@article{bobpaper2001,'), 'the member\'s library is in their file');
list = (await proj(owner, 'GET', '/libraries')).json();
eq(list.map((l) => [l.id === 'zotero' ? 'legacy' : l.bibFile, l.mine, l.canChange]), [['legacy', true, true], ['zotero.bib', true, true], ['zotero-bob.bib', false, true]], 'the owner sees every link and may change each');
list = (await proj(member, 'GET', '/libraries')).json();
eq(list.map((l) => l.canChange), [false, false, true], 'the member may change only their own');
eq((await proj(member, 'DELETE', `/libraries/${ownerLink.id}`)).statusCode, 403, 'a member cannot unlink another\'s link');
eq((await proj(member, 'POST', '/libraries', { provider: 'zotero', library: 'users/8', bibFile: 'zotero.bib' })).statusCode, 409, 'nor write a file another link writes');

// ---- a sync answers a job at once ----
slowMs = 400;
version = 11;
turingKey = 'turingComputing1950';
const t0 = Date.now();
res = await proj(member, 'POST', `/libraries/${ownerLink.id}/sync`, { branch: 'main', force: true });
eq(res.statusCode, 200, `any member may sync (${res.body})`);
check(Date.now() - t0 < 300, 'the request returns before the export finishes');
eq((await proj(member, 'POST', `/libraries/${ownerLink.id}/sync`, { branch: 'main' })).json().jobId, res.json().jobId, 'a second press joins the running sync');
job = await settle(res.json().jobId);
slowMs = 0;
eq(job.renamedKeys, [{ from: 'turing1950', to: 'turingComputing1950' }], `the renamed key is reported (${JSON.stringify(job)})`);
check(disk('zotero.bib').includes('@article{turingComputing1950,'), 'the file has the new key');

// ---- update citations ----
res = await proj(member, 'POST', '/libraries/update-citations', { branch: 'main', renames: job.renamedKeys });
eq([res.statusCode, res.json().replaced, res.json().files], [200, 1, ['main.tex']], `update citations rewrites the paper (${res.body})`);
eq(disk('main.tex'), MAIN.replace('turing1950', 'turingComputing1950'), 'only the key changed');

// ---- an unchanged library ----
res = await proj(owner, 'POST', `/libraries/${ownerLink.id}/sync`, { branch: 'main' });
job = await settle(res.json().jobId);
eq(job.result, { synced: false, unchanged: true, bibFile: 'zotero.bib', format: 'biblatex' }, 'an unchanged library is left alone');
res = await proj(owner, 'POST', `/libraries/${ownerLink.id}/sync`, { branch: 'main', olderThan: 3600 });
eq((await settle(res.json().jobId)).result.fresh, true, 'a sync on open skips a link synced within the hour');

// ---- change and pause ----
res = await proj(owner, 'PATCH', `/libraries/${ownerLink.id}`, { recursive: false, omitFields: [] });
eq(res.statusCode, 200, `the owner changes the link (${res.body.slice(0, 200)})`);
job = await settle(res.json().jobId);
bib = disk('zotero.bib');
check(!bib.includes('shannon1948') && bib.includes('abstract'), 'without subcollections and with abstracts kept');

await store.writeMeta({ ...(await store.readMeta(id)), share: { mode: 'link', collaborators: [] } });
list = (await proj(owner, 'GET', '/libraries')).json();
eq(list.find((l) => l.id === memberLink.id).pausedReason, 'Paused: Bob Member no longer has access. Link your own library or unlink.', 'a link pauses when its linker loses access');
res = await proj(owner, 'POST', `/libraries/${memberLink.id}/sync`, { branch: 'main' });
eq([res.statusCode, res.json().code], [409, 'paused'], 'and a paused link does not sync');
eq((await proj(owner, 'DELETE', `/libraries/${memberLink.id}`)).statusCode, 200, 'the owner may unlink it');
check(fs.existsSync(path.join(dir, 'zotero-bob.bib')), 'the file stays');

// ---- desktop push ----
res = await proj(owner, 'POST', '/libraries', { provider: 'desktop-file', bibFile: 'local/mine.bib' });
eq([res.statusCode, res.json().jobId], [200, undefined], `a desktop link is made without a sync (${res.body.slice(0, 200)})`);
const desk = res.json().link;
res = await proj(owner, 'PUT', `/libraries/${desk.id}/content`, { content: '@book{local1,\r\n  title = {Local},\r\n}\r\n' });
eq([res.statusCode, res.json().itemCount, res.json().synced], [200, 1, true], `the desktop app pushes the file (${res.body.slice(0, 200)})`);
check(disk('local/mine.bib').includes('@book{local1,\n  title = {Local},\n}'), 'the file is written with LF line endings');
eq((await proj(owner, 'POST', `/libraries/${desk.id}/sync`, {})).statusCode, 400, 'a desktop file is not synced by the server');
eq((await proj(owner, 'PUT', `/libraries/${ownerLink.id}/content`, { content: 'x' })).statusCode, 400, 'only a desktop link takes pushed content');

// ---- the limit ----
eq((await proj(owner, 'POST', '/libraries', { provider: 'desktop-file' })).json().link.bibFile, 'library.bib', 'a desktop link defaults to library.bib');
eq((await proj(owner, 'POST', '/libraries', { provider: 'desktop-file' })).json().link.bibFile, 'library-ada.bib', 'then library-<first name>.bib');
res = await proj(owner, 'POST', '/libraries', { provider: 'desktop-file' });
eq(res.statusCode, 409, `a sixth link is refused (${res.body.slice(0, 120)})`);

// ---- legacy unlink, and the transfer helper ----
eq((await proj(owner, 'DELETE', '/libraries/zotero')).statusCode, 200, 'the legacy link unlinks');
eq((await store.readMeta(id)).zotero, undefined, 'meta.zotero is gone');
const m = await store.readMeta(id);
m.ext['libraries.links'].push({ ...m.ext['libraries.links'][0], id: 'lother', linkedBy: 'someone-else', bibFile: 'x.bib' });
link.withoutLinksBy(m, owner.id);
eq(m.ext['libraries.links'].map((l) => l.id), ['lother'], 'a transfer drops the previous owner\'s links');

await app.close();
zot.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('library-link: ok');
process.exit(0);
