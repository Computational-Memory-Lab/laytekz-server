/**
 * Project settings in ProjectMeta.ext (WP03): GET/PATCH
 * /api/projects/:id/settings and the client view of `ext` in every project
 * reply. Only keys a server feature defines are stored; an unknown or
 * invalid key gets a 400 naming it; a clientVisible:false key never leaves
 * the server (GET /api/projects/:id, the list, /settings); only
 * clientWritable keys may be PATCHed, and only by members who may edit
 * (never viewers, link visitors, showcases or bearer tokens); a change bumps
 * the revision and signals every open branch; "Make a copy" carries only the
 * copyWithProject keys.
 *
 * Through buildApp with accounts on and ALDINE_TEST_HOOKS=1, so the server
 * probe feature (features/_probe/server.ts) defines the settings: _probe.note
 * (visible, writable), _probe.serverOnly (server only), _probe.copied
 * (copied with the project). Env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-project-settings-')));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_TEST_HOOKS = '1';
// Installs the showcase guard; the test adds its showcase project at run time.
process.env.ALDINE_PROTECTED_PROJECTS = 'zzzz0000';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['ALDINE_PUBLIC_URL', 'ALDINE_BASE_PATH', 'DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_MCP']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const { buildApp } = await import('../src/app.ts');
const { EXT_REV_KEY } = await import('../src/features/types.ts');
const ps = await import('../src/features/projectSettings.ts');
const app = await buildApp();

const people = {};
for (const who of ['ada', 'bob', 'cara', 'dan', 'eve']) {
  const u = await auth.register(`${who}@example.com`, 'password123', who[0].toUpperCase() + who.slice(1));
  await db().setEmailPending(u.id, null); // share entries count once an address is confirmed
  people[who] = { user: u, cookie: `aldine_session=${await auth.createSession(u.id)}` };
}
const own = async (name, share) => {
  const m = await store.createProject(name, { 'main.tex': 'Text.\n' }, people.ada.user.id);
  m.share = share;
  await store.writeMeta(m);
  return m;
};
// bob edits, cara can view; eve opens the link project only
const p = await own('Settings', { mode: 'private', collaborators: ['bob@example.com', 'cara@example.com'], viewers: ['cara@example.com'] });
const linked = await own('Linked', { mode: 'link', collaborators: [] });
const showcase = await own('Showcase', { mode: 'private', collaborators: [] });
collab.protectedProjects.add(showcase.id);
const { token } = await auth.createAccessToken(people.ada.user.id, 'agent', null, null);

const send = (method, url, who, payload, headers = {}) => app.inject({
  method, url,
  headers: { ...(who === 'token' ? { authorization: `Bearer ${token}` } : who ? { cookie: people[who].cookie } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  ...(payload !== undefined ? { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) } : {}),
});
const settings = (id = p.id) => `/api/projects/${id}/settings`;
const ok = async (method, url, who, payload, what) => {
  const r = await send(method, url, who, payload);
  eq(r.statusCode, 200, `${what}: ${r.body.slice(0, 300)}`);
  return r.json();
};
const status = async (method, url, who, payload) => (await send(method, url, who, payload)).statusCode;
const refused = async (payload, key, what) => {
  const r = await send('PATCH', settings(), 'ada', payload);
  eq(r.statusCode, 400, `${what}: ${r.body.slice(0, 300)}`);
  eq(r.json().key, key, `${what}: the reply names the key`);
};

// ---- read and write ----
eq(await ok('GET', settings(), 'ada', undefined, 'a project with none'), { values: {}, rev: 0 }, 'no settings yet: rev 0');
const sig = await collab.hocuspocus.openDirectConnection(collab.docName(p.id, 'main', collab.FILES_SIGNAL), {});
const signal = () => collab.hocuspocus.documents.get(collab.docName(p.id, 'main', collab.FILES_SIGNAL)).getMap('signal').get('settings');
let r = await ok('PATCH', settings(), 'ada', { set: { '_probe.note': 'hello' } }, 'the owner sets a value');
eq(r, { values: { '_probe.note': 'hello' }, rev: 1 }, 'the reply is the new values and revision');
eq(signal(), 1, "the branch's open editors are signalled with the revision");
eq(await ok('GET', settings(), 'bob', undefined, 'a collaborator reads'), r, 'every member reads the same');
let detail = await ok('GET', `/api/projects/${p.id}`, 'ada', undefined, 'the project');
eq(detail.ext, { '_probe.note': 'hello' }, 'GET /api/projects/:id carries the visible values, without the revision');
r = await ok('PATCH', settings(), 'bob', { set: { '_probe.note': 'hello' } }, 'the same value again');
eq(r.rev, 1, 'a change that changes nothing keeps the revision');
r = await ok('PATCH', settings(), 'bob', { set: { '_probe.copied': true }, unset: ['_probe.note'] }, 'a collaborator sets and unsets');
eq(r, { values: { '_probe.copied': true }, rev: 2 }, 'one revision for the whole change');
eq(signal(), 2, 'signalled again');

// ---- refusals ----
await refused({ set: { 'nobody.knows': 1 } }, 'nobody.knows', 'an unknown key');
await refused({ set: { [EXT_REV_KEY]: 9 } }, EXT_REV_KEY, 'the revision itself');
await refused({ set: { '_probe.serverOnly': 'x' } }, '_probe.serverOnly', 'a key clients may not write');
await refused({ unset: ['_probe.serverOnly'] }, '_probe.serverOnly', 'nor unset');
await refused({ set: { '_probe.note': 42 } }, '_probe.note', 'an invalid value');
await refused({ set: { '_probe.note': 'x'.repeat(201) } }, '_probe.note', 'a value its definition refuses');
await refused({ set: { '_probe.note': 'a' }, unset: ['_probe.note'] }, '_probe.note', 'set and unset at once');
eq(await status('PATCH', settings(), 'ada', '[1]'), 400, 'a body that is not an object');
eq(await status('PATCH', settings(), 'ada', { set: [] }), 400, '"set" that is not an object');
eq((await ok('GET', settings(), 'ada', undefined, 'after the refusals')).rev, 2, 'a refused change stores nothing');

// ---- who may ----
eq(await status('GET', settings(), null), 401, 'signed out: 401');
eq(await status('PATCH', settings(), null, { set: {} }), 401, 'signed out PATCH: 401');
eq(await status('GET', settings(), 'dan'), 403, 'a stranger cannot read');
eq(await status('PATCH', settings(), 'dan', { set: { '_probe.note': 'x' } }), 403, 'nor write');
eq(await status('GET', settings(), 'cara'), 200, 'a viewer reads');
eq(await status('PATCH', settings(), 'cara', { set: { '_probe.note': 'x' } }), 403, 'a viewer cannot write');
eq(await status('GET', settings(), 'token'), 200, 'a bearer token reads');
eq(await status('PATCH', settings(), 'token', { set: { '_probe.note': 'x' } }), 403, 'a bearer token cannot write');
eq(await status('GET', settings(linked.id), 'eve'), 200, 'a link visitor reads');
const linkPatch = await send('PATCH', settings(linked.id), 'eve', { set: { '_probe.note': 'x' } });
eq(linkPatch.statusCode, 403, 'a link visitor is not a member and cannot write');
check(/owner and collaborators/.test(linkPatch.json().error), `and is told who can (${linkPatch.body})`);
eq(await status('PATCH', settings(showcase.id), 'ada', { set: { '_probe.note': 'x' } }), 403, 'a showcase is never changed');
eq(await status('GET', settings('nosuchproject'), 'ada'), 404, 'an unknown project: 404');
eq((await ok('GET', settings(), 'ada', undefined, 'after the refused callers')).rev, 2, 'none of them changed anything');

// ---- server-only values ----
r = await ok('POST', `/api/projects/${p.id}/_probe/write`, 'ada', { set: { '_probe.serverOnly': 'kept here', '_probe.note': 'visible' } }, 'a feature writes through kit.writeExt');
eq([r.note, r.serverOnly], ['visible', 'kept here'], 'server code writes keys clients may not');
eq(signal(), 3, 'a server write signals too');
const raw = await store.readMeta(p.id);
eq([raw.ext['_probe.serverOnly'], raw.ext[EXT_REV_KEY]], ['kept here', 3], 'the value and the revision are stored in ext');
detail = await ok('GET', `/api/projects/${p.id}`, 'ada', undefined, 'the project');
eq(detail.ext, { '_probe.note': 'visible', '_probe.copied': true }, 'GET /api/projects/:id leaves the server-only key out');
eq((await ok('GET', settings(), 'ada', undefined, 'settings')).values, { '_probe.note': 'visible', '_probe.copied': true }, 'and so does /settings');
const row = (await ok('GET', '/api/projects', 'ada', undefined, 'the list')).find((x) => x.id === p.id);
eq(row.ext, { '_probe.note': 'visible', '_probe.copied': true }, 'and the project list');
eq((await ok('GET', `/api/projects/${p.id}/_probe`, 'ada', undefined, 'the probe reads')).serverOnly, 'kept here', 'server code reads it back (kit.readExt)');
check(!JSON.stringify(await ok('GET', `/api/projects/${p.id}`, 'cara', undefined, 'a viewer')).includes('kept here'), 'no reply to anyone contains it');

// a key no definition claims (a feature removed): stored, never shown, never writable
raw.ext['gone.feature'] = 'left behind';
await store.writeMeta(raw);
detail = await ok('GET', `/api/projects/${p.id}`, 'ada', undefined, 'the project');
check(!('gone.feature' in detail.ext), 'an unknown key never reaches a client');
await refused({ unset: ['gone.feature'] }, 'gone.feature', 'nor can a client remove it');
eq((await store.readMeta(p.id)).ext['gone.feature'], 'left behind', 'it stays stored');

// a project with no visible settings answers exactly as before V2
const plain = await own('Plain', { mode: 'private', collaborators: [] });
check(!('ext' in (await ok('GET', `/api/projects/${plain.id}`, 'ada', undefined, 'a plain project'))), 'no ext field when nothing is visible');

// ---- Make a copy ----
const copy = await store.copyProject(await store.readMeta(p.id), 'Settings (copy)', people.ada.user.id);
eq(copy.ext, { '_probe.copied': true }, 'a copy keeps only the copyWithProject keys, and starts at revision 0');
eq(await ok('GET', settings(copy.id), 'ada', undefined, 'the copy'), { values: { '_probe.copied': true }, rev: 0 }, 'its settings read back');

// ---- the pure layer ----
{
  const m = { ext: { '_probe.note': 'n' } };
  eq(ps.applyExtChange(m, { '_probe.note': 'n' }, [], { client: true }), { changed: false, rev: 0 }, 'no change: no revision');
  eq(ps.applyExtChange(m, { '_probe.serverOnly': 's' }, [], { client: false }), { changed: true, rev: 1 }, 'server writes are not limited to clientWritable');
  let threw = null;
  try { ps.applyExtChange(m, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`_probe.note${i}`, 'x'])), [], { client: true }); } catch (err) { threw = err; }
  check(threw instanceof ps.ProjectSettingError && !threw.key, 'more than 64 keys in one change is refused');
  eq(ps.extRev({ ext: { [EXT_REV_KEY]: 'junk' } }), 0, 'a damaged revision reads as 0');
  eq(ps.publicExt({}), undefined, 'no ext: undefined');
  check(ps.registerProjectSettings('stats', [{ id: '_probe.note', validate: () => true, clientWritable: true }]).length === 1, "another feature's prefix is refused");
}

await sig.disconnect();
console.log('project-settings: all assertions passed');
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
