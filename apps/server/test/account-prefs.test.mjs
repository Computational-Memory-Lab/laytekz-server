/**
 * Account preferences (features/prefs.ts, WP03): GET/PATCH/PUT
 * /api/account/preferences through buildApp, so the V2 feature host is wired
 * the way a deployment runs it. Signed out 401, bearer tokens and foreign
 * origins 403; an ETag per revision and 304; merge, keepExisting (the first
 * browser seeds the account), unset and replace; every validation limit as a
 * 400 naming the key; 20 parallel PATCHes all land; 429 past the limit;
 * GET /api/capabilities says whether this caller can sync.
 *
 * Accounts on, a throwaway datastore; env is set before any src import.
 * account-prefs-off.test.mjs covers a server without accounts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-account-prefs-')));
const ORIGIN = 'https://laytekz.test';
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_PUBLIC_URL = ORIGIN;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
for (const k of ['ALDINE_BASE_PATH', 'DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_MCP', 'ALDINE_OAUTH_REGISTRATION', 'ALDINE_TEST_HOOKS', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { buildApp } = await import('../src/app.ts');
const { PREFS_PROVIDER, PREF_LIMITS } = await import('../src/features/types.ts');
const prefs = await import('../src/features/prefs.ts');
const app = await buildApp();

const people = {};
for (const who of ['ada', 'bob', 'cara', 'dan']) {
  const u = await auth.register(`${who}@example.com`, 'password123', who);
  people[who] = { user: u, cookie: `aldine_session=${await auth.createSession(u.id)}` };
}
const URL_ = '/api/account/preferences';
const call = (method, who, payload, headers = {}) => app.inject({
  method, url: URL_,
  headers: { ...(who ? { cookie: people[who].cookie } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  ...(payload !== undefined ? { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) } : {}),
});
const ok = async (method, who, payload, what, headers) => {
  const r = await call(method, who, payload, headers);
  eq(r.statusCode, 200, `${what}: ${r.body.slice(0, 300)}`);
  return r;
};
const refused = async (payload, key, what, method = 'PATCH', who = 'ada') => {
  const r = await call(method, who, payload);
  eq(r.statusCode, 400, `${what}: ${r.body.slice(0, 300)}`);
  const body = r.json();
  check(typeof body.error === 'string' && body.error.length > 0, `${what}: a sentence says why`);
  eq(body.key, key, `${what}: names the key`);
};

// ---- who may call ----
for (const m of ['GET', 'PATCH', 'PUT']) eq((await call(m, null, m === 'GET' ? undefined : {})).statusCode, 401, `${m} signed out: 401`);
const { token } = await auth.createAccessToken(people.ada.user.id, 'agent', null, null);
for (const m of ['GET', 'PATCH', 'PUT']) {
  const r = await call(m, null, m === 'GET' ? undefined : { set: {} }, { authorization: `Bearer ${token}` });
  eq(r.statusCode, 403, `${m} with a bearer token: 403 (${r.body})`);
}
for (const m of ['PATCH', 'PUT']) eq((await call(m, 'ada', { set: {} }, { origin: 'https://evil.laytekz.test' })).statusCode, 403, `${m} from another origin: 403`);
await ok('PATCH', 'ada', { set: {} }, 'the public origin may PATCH', { origin: ORIGIN });

// ---- read, ETag, 304 ----
{
  const r = await ok('GET', 'ada', undefined, 'an empty account');
  eq(r.json(), { prefs: {}, rev: 0, updatedAt: null }, 'an account with none has rev 0');
  eq(r.headers.etag, '"p0"', 'ETag "p<rev>"');
  eq(r.headers['cache-control'], 'no-store', 'never cached');
  const n = await call('GET', 'ada', undefined, { 'if-none-match': '"p0"' });
  eq(n.statusCode, 304, 'a matching If-None-Match: 304');
  eq(n.body, '', 'with no body');
}

// ---- merge, unset, unchanged, keepExisting, replace ----
{
  let r = await ok('PATCH', 'ada', { set: { 'appearance.theme': 'light', 'editor.fontSize': 15, 'keys.shortcuts': { comment: ['Mod', 'Shift', 'C'] } } }, 'a first PATCH');
  let b = r.json();
  eq([b.prefs, b.rev], [{ 'appearance.theme': 'light', 'editor.fontSize': 15, 'keys.shortcuts': { comment: ['Mod', 'Shift', 'C'] } }, 1], 'the keys are stored, rev 1');
  check(typeof b.updatedAt === 'string' && !Number.isNaN(Date.parse(b.updatedAt)), 'updatedAt is a time');
  eq(r.headers.etag, '"p1"', 'the reply carries the new ETag');
  eq((await call('GET', 'ada', undefined, { 'if-none-match': '"p0"' })).statusCode, 200, 'the old ETag no longer matches');
  eq((await ok('GET', 'ada', undefined, 'read back')).json().prefs['editor.fontSize'], 15, 'GET reads what PATCH stored');

  r = await ok('PATCH', 'ada', { set: { 'editor.fontSize': 15 } }, 'the same value again');
  eq(r.json().rev, 1, 'a PATCH that changes nothing keeps the revision');
  r = await ok('PATCH', 'ada', { set: { 'keys.shortcuts': { comment: ['Mod', 'Shift', 'C'] } } }, 'the same object again');
  eq(r.json().rev, 1, 'object values compare by content');

  r = await ok('PATCH', 'ada', { set: { 'editor.lineHeight': 1.6 }, unset: ['editor.fontSize', 'never.set'] }, 'set and unset');
  b = r.json();
  eq([Object.keys(b.prefs).sort(), b.rev], [['appearance.theme', 'editor.lineHeight', 'keys.shortcuts'], 2], 'unset removes, absent keys are ignored, one revision');

  r = await ok('PATCH', 'ada', { set: { 'appearance.theme': 'dark', 'typing.explain': false }, keepExisting: true }, 'a first sync from another browser');
  b = r.json();
  eq([b.prefs['appearance.theme'], b.prefs['typing.explain'], b.rev], ['light', false, 3], 'keepExisting fills only the keys the account lacks');

  r = await ok('PUT', 'ada', { prefs: { 'appearance.theme': 'system' } }, 'replace all');
  eq([r.json().prefs, r.json().rev], [{ 'appearance.theme': 'system' }, 4], 'PUT replaces everything');
  eq((await ok('PUT', 'ada', { prefs: { 'appearance.theme': 'system' } }, 'the same set again')).json().rev, 4, 'an identical PUT keeps the revision');
  eq((await ok('GET', 'bob', undefined, 'another account')).json(), { prefs: {}, rev: 0, updatedAt: null }, 'accounts are separate');
  const row = await db().getConnection(people.ada.user.id, PREFS_PROVIDER);
  eq([row.prefs, row.rev], [{ 'appearance.theme': 'system' }, 4], `stored in the connections row "${PREFS_PROVIDER}"`);
}

// ---- validation ----
{
  await refused({ set: { Theme: 'x' } }, 'Theme', 'a capitalised name');
  await refused({ set: { theme: 'x' } }, 'theme', 'a name without a dot');
  await refused({ set: { 'a.b.c.d.e': 1 } }, 'a.b.c.d.e', 'a name with five parts');
  await refused({ unset: ['bad name'] }, 'bad name', 'an unset name is checked too');
  await refused({ set: { 'a.b': null } }, 'a.b', 'null');
  await refused('{"set":{"a.b":1e999}}', 'a.b', 'a number that is not finite');
  await refused({ set: { 'a.b': 'x'.repeat(501) } }, 'a.b', 'text over 500 characters');
  await refused({ set: { 'a.b': [[[[1]]]] } }, 'a.b', 'nesting four deep');
  await ok('PATCH', 'cara', { set: { 'a.deep': [[[1]]], 'a.obj': { x: { y: [true, 'z'] } } } }, 'nesting three deep is fine');
  await refused({ set: { 'a.b': Array.from({ length: 300 }, () => 'abcdefgh') } }, 'a.b', 'a value over 2 KB');
  await refused({ set: { 'a.b': 1 }, unset: ['a.b'] }, 'a.b', 'set and unset at once');
  const many = Object.fromEntries(Array.from({ length: PREF_LIMITS.keysPerRequest + 1 }, (_, i) => [`k.n${i}`, i]));
  await refused({ set: many }, undefined, 'more than 64 keys in one request');
  await refused({ set: [] }, undefined, '"set" that is not an object');
  await refused({ unset: 'a.b' }, undefined, '"unset" that is not a list');
  await refused({ keepExisting: 'yes' }, undefined, '"keepExisting" that is not true or false');
  await refused('[1]', undefined, 'a body that is not an object');
  await refused({ nope: 1 }, undefined, 'PUT without prefs', 'PUT');

  const full = Object.fromEntries(Array.from({ length: PREF_LIMITS.keysStored }, (_, i) => [`k.n${i}`, i]));
  await ok('PUT', 'dan', { prefs: full }, `PUT may store ${PREF_LIMITS.keysStored} keys at once`);
  await refused({ set: { 'k.extra': 1 } }, undefined, 'a PATCH past the stored maximum', 'PATCH', 'dan');
  await refused({ prefs: { ...full, 'k.extra': 1 } }, undefined, 'a PUT past the stored maximum', 'PUT', 'dan');
  // 25 values of about 1.5 KB each: every one under the value limit, together over the total.
  const big = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`big.n${i}`, ['x'.repeat(490), 'y'.repeat(490), 'z'.repeat(490)]]));
  await refused({ prefs: big }, undefined, 'a PUT over 32 KB in total', 'PUT', 'dan');
  eq((await ok('GET', 'dan', undefined, 'after the refusals')).json().rev, 1, 'a refused change stores nothing');
}

// ---- the pure checks the routes use ----
{
  eq(prefs.prefValueProblem(true), null, 'booleans are values');
  eq(prefs.prefValueProblem({ a: [1, 'x', false] }), null, 'lists and objects of values are values');
  check(prefs.prefValueProblem(undefined) !== null, 'undefined is not');
  check(prefs.prefValueProblem(new Date()) !== null, 'a class instance is not');
}

// ---- 20 parallel PATCHes on distinct keys ----
{
  const u = await auth.register('par@example.com', 'password123', 'Par');
  people.par = { user: u, cookie: `aldine_session=${await auth.createSession(u.id)}` };
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => call('PATCH', 'par', { set: { [`par.k${i}`]: i } })));
  eq(rs.map((r) => r.statusCode), Array(20).fill(200), 'all 20 are accepted');
  const b = (await ok('GET', 'par', undefined, 'after the parallel PATCHes')).json();
  eq([Object.keys(b.prefs).length, b.rev], [20, 20], 'every key landed, one revision each');
  eq(rs.map((r) => r.json().rev).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1), 'each reply saw its own revision');
}

// ---- rate limit ----
{
  let status = 0;
  for (let i = 0; i < 120 && status !== 429; i++) status = (await call('PATCH', 'par', { set: { 'par.tick': i } })).statusCode;
  eq(status, 429, 'a flood of PATCHes is refused with 429');
  eq((await call('GET', 'par')).statusCode, 200, 'reads are not limited');
}

// ---- capabilities ----
{
  const signedIn = (await app.inject({ method: 'GET', url: '/api/capabilities', headers: { cookie: people.ada.cookie } }));
  eq(signedIn.statusCode, 200, 'GET /api/capabilities answers');
  const c = signedIn.json();
  eq([c.accounts, c.prefs, c.mcp, c.oauthRegistration, c.rev], [true, true, false, false, ''], 'signed in: accounts and preference sync; no MCP; no web build in the test');
  eq(signedIn.headers['cache-control'], 'no-store', 'never cached: it depends on the caller');
  const anon = (await app.inject({ method: 'GET', url: '/api/capabilities' })).json();
  eq([anon.accounts, anon.prefs], [true, false], 'signed out: no preference sync');
  const bearer = await app.inject({ method: 'GET', url: '/api/capabilities', headers: { authorization: `Bearer ${token}` } });
  eq(bearer.statusCode, 403, 'a bearer token is refused, like every account route');
}

console.log('account-prefs: all assertions passed');
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
