/**
 * The server feature host (features/host.ts, WP03) as a deployment runs it:
 * buildApp registers SERVER_FEATURES after registerRoutes, so every global
 * guard covers feature routes. Exercised through the server probe feature
 * (features/_probe/server.ts, active under ALDINE_TEST_HOOKS=1): the origin
 * check, sign-in, project access, token scope, the trash and showcases;
 * feature writes closed to bearer tokens and viewers unless listed in
 * tokenWrites / viewerWrites; the kit's member and owner guards, author,
 * readExt/writeExt, signal and limiter; capabilities merged (a throwing
 * feature left out); doc-load hooks. feature-host-errors.test.mjs covers
 * malformed and throwing features.
 *
 * Accounts on; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-feature-host-')));
const ORIGIN = 'https://laytekz.test';
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_TEST_HOOKS = '1';
process.env.ALDINE_PUBLIC_URL = ORIGIN;
process.env.ALDINE_PROTECTED_PROJECTS = 'zzzz0000';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['ALDINE_BASE_PATH', 'DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_MCP', 'ALDINE_OAUTH_REGISTRATION']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const { trashProject } = await import('../src/trash.ts');
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();

const people = {};
for (const who of ['ada', 'bob', 'cara', 'dan']) {
  const u = await auth.register(`${who}@example.com`, 'password123', who[0].toUpperCase() + who.slice(1));
  await db().setEmailPending(u.id, null);
  people[who] = { user: u, cookie: `aldine_session=${await auth.createSession(u.id)}` };
}
const own = async (name, share = { mode: 'private', collaborators: ['bob@example.com', 'cara@example.com'], viewers: ['cara@example.com'] }) => {
  const m = await store.createProject(name, { 'main.tex': 'Text.\n' }, people.ada.user.id);
  m.share = share;
  await store.writeMeta(m);
  return m;
};
const p = await own('Probe');
const other = await own('Other');
const showcase = await own('Showcase');
collab.protectedProjects.add(showcase.id);
const trashed = await own('Trashed');
await trashProject(trashed);
const { token } = await auth.createAccessToken(people.ada.user.id, 'agent', null, null);
const scoped = await auth.createAccessToken(people.ada.user.id, 'scoped', [other.id], null);

const send = (method, url, who, payload, headers = {}) => app.inject({
  method, url,
  headers: {
    ...(who === 'token' ? { authorization: `Bearer ${token}` } : who === 'scoped' ? { authorization: `Bearer ${scoped.token}` } : who ? { cookie: people[who].cookie } : {}),
    ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    ...headers,
  },
  ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
});
const status = async (method, url, who, payload, headers) => (await send(method, url, who, payload, headers)).statusCode;
const at = (route, id = p.id) => `/api/projects/${id}/_probe${route}`;

// ---- the global guards cover feature routes ----
eq(await status('GET', at(''), null), 401, 'signed out: 401');
eq(await status('GET', at(''), 'dan'), 403, 'no access: 403');
eq(await status('GET', at(''), 'cara'), 200, 'a viewer may read');
eq(await status('GET', at(''), 'token'), 200, 'a bearer token may read');
eq(await status('GET', at(''), 'scoped'), 403, 'a token scoped to another project may not');
eq(await status('GET', at('', trashed.id), 'ada'), 404, 'a trashed project is gone');
eq(await status('POST', at('/write', showcase.id), 'ada', { set: {} }), 403, 'a showcase refuses feature writes');
eq(await status('POST', at('/write'), 'ada', { set: {} }, { origin: 'https://evil.laytekz.test' }), 403, 'a write from another origin is refused');
eq(await status('POST', at('/write'), 'ada', { set: {} }, { origin: ORIGIN }), 200, 'from the public origin it goes through');

// ---- feature writes: closed to tokens and viewers unless listed ----
eq(await status('POST', at('/write'), 'token', { set: {} }), 403, 'an unlisted write refuses bearer tokens');
eq(await status('POST', at('/write'), 'cara', { set: {} }), 403, 'and viewers');
eq(await status('POST', at('/write'), 'bob', { set: {} }), 200, 'a collaborator may');
eq(await status('POST', at('/token'), 'token'), 200, 'a write in tokenWrites admits a member\'s token');
eq(await status('POST', at('/token'), 'cara'), 403, 'but not a viewer (it is not in viewerWrites)');
eq(await status('POST', at('/viewer'), 'cara'), 200, 'a write in viewerWrites admits a viewer');
eq(await status('POST', at('/viewer'), 'token'), 403, 'but not a token');
eq(await status('POST', at('/token'), 'scoped'), 403, 'token scope still applies to a listed write');

// ---- the kit's guards ----
const owner = await send('POST', at('/owner'), 'bob');
eq(owner.statusCode, 403, 'requireOwner refuses a collaborator');
eq(owner.json().error, 'Only the owner can use the owner probe', 'with the action named');
eq(await status('POST', at('/owner'), 'ada'), 200, 'and admits the owner');
const linked = await own('Linked', { mode: 'link', collaborators: [] });
const link = await send('POST', at('/write', linked.id), 'dan', { set: {} });
eq(link.statusCode, 403, 'requireMember refuses a link visitor who may edit the document');
eq(link.json().error, 'Only the owner and collaborators can write probe settings', 'with the action named');
const self = await send('GET', at(''), 'ada');
eq([self.json().user, self.json().author], [people.ada.user.id, 'Ada'], 'kit.user and kit.author name the caller');

// ---- readExt / writeExt ----
let r = await send('POST', at('/write'), 'bob', { set: { '_probe.note': 'from a feature' } });
eq(r.json().note, 'from a feature', 'kit.writeExt stores and kit.readExt reads');
r = await send('POST', at('/write'), 'bob', { set: { 'other.key': 1 } });
eq([r.statusCode, r.json().key], [400, 'other.key'], 'kit.writeExt throws on an unknown key, which the feature turns into a 400');
const m = await store.readMeta(p.id);
m.ext['_probe.note'] = 42; // invalid for its definition (a hand edit, an older format)
await store.writeMeta(m);
eq((await send('GET', at(''), 'ada')).json().note, null, 'readExt gives undefined for a value its definition refuses');

// ---- signal ----
const sig = await collab.hocuspocus.openDirectConnection(collab.docName(p.id, 'main', collab.FILES_SIGNAL), {});
eq(await status('POST', at('/signal'), 'bob', { branch: 'main', value: 7 }), 200, 'a feature signals');
eq(collab.hocuspocus.documents.get(collab.docName(p.id, 'main', collab.FILES_SIGNAL)).getMap('signal').get('_probe'), 7, 'kit.signal sets the key on the branch');
await sig.disconnect();

// ---- doc-load hooks ----
const before = (await send('GET', at(''), 'ada')).json().docLoads;
const doc = await collab.hocuspocus.openDirectConnection(collab.docName(p.id, 'main', 'main.tex'), {});
eq((await send('GET', at(''), 'ada')).json().docLoads, before + 1, "the feature's onDocLoad ran for the loaded doc");
await doc.disconnect();

// ---- limiter ----
const limited = [];
for (let i = 0; i < 4; i++) limited.push(await status('GET', '/api/_probe/limited', 'ada'));
eq(limited, [200, 200, 200, 429], 'kit.limiter: a burst of three, then refused');
eq(await status('GET', '/api/_probe/limited', 'bob'), 200, 'per caller');

// ---- capabilities ----
const caps = (await send('GET', '/api/capabilities', 'ada')).json();
eq([caps.probe, caps.accounts, caps.prefs], [true, true, true], 'feature capabilities are merged with the base keys');
const anon = (await send('GET', '/api/capabilities', null)).json();
eq([anon.probe, anon.prefs], [true, false], 'a feature decides its public keys; prefs is false signed out');
const thrown = await send('GET', '/api/capabilities', 'ada', undefined, { 'x-probe-throw': '1' });
eq(thrown.statusCode, 200, 'a feature that throws does not fail the reply');
eq([thrown.json().probe, thrown.json().accounts], [undefined, true], 'its keys are left out, the rest answer');

// ---- the core routes exist beside the features ----
eq(await status('GET', `/api/projects/${p.id}/settings`, 'ada'), 200, 'project settings are registered');
eq(await status('GET', '/api/account/preferences', 'ada'), 200, 'account preferences are registered');
check((await status('GET', '/api/references/search?q=graph', null)) === 401, '/api/references/search needs a sign-in');

console.log('feature-host: all assertions passed');
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
