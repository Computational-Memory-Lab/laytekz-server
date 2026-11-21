/**
 * The feature host (features/host.ts, WP03) with features that are wrong:
 * an unknown or repeated id, a write allowance that is not
 * 'METHOD /api/projects/:id/…', project settings outside the feature's
 * prefix or claimed twice, a register that throws (or takes a core route),
 * capabilities that throw or are not an object. Each is skipped or dropped
 * with an error in the log, the server and the other features start, and a
 * hook a feature adds stays inside its own routes.
 *
 * A bare Fastify app with registerRoutes, accounts off; env before imports.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-feature-host-errors-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_TEST_HOOKS', 'ALDINE_MCP']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { registerFeatures } = await import('../src/features/host.ts');
const ps = await import('../src/features/projectSettings.ts');

const logs = [];
const app = Fastify({ logger: { level: 'error', stream: { write: (line) => logs.push(JSON.parse(line).msg) } } });
await registerRoutes(app);

const ok = (route) => async () => ({ ok: route });
const features = [
  { id: 'nope', register(a) { a.get('/api/nope', ok('nope')); } },
  { id: 'escape', register(a) { a.get('/api/escape-first', ok('first')); } },
  { id: 'escape', register(a) { a.get('/api/escape-second', ok('second')); } },
  { id: 'automath', tokenWrites: ['GET /api/projects/:id/automath'], register(a) { a.get('/api/automath', ok('automath')); } },
  { id: 'pairs', viewerWrites: ['POST /api/elsewhere'], register(a) { a.get('/api/pairs', ok('pairs')); } },
  {
    id: 'tables',
    projectSettings: [
      { id: 'tables.style', validate: (v) => v === 'booktabs' || v === 'plain', clientWritable: true },
      { id: 'wrong.prefix', validate: () => true, clientWritable: true },
      { id: 'tables.novalidate', clientWritable: true },
      { id: 'tables.style', validate: () => true, clientWritable: true },
    ],
    register(a) { a.get('/api/tables', ok('tables')); },
  },
  { id: 'citations', projectSettings: [{ id: 'tables.style', validate: () => true, clientWritable: true }] },
  {
    id: 'crossrefs',
    register(a) {
      a.get('/api/crossrefs-before', ok('before'));
      throw new Error('crossrefs broke while registering');
    },
  },
  { id: 'links', register(a) { a.get('/api/capabilities', ok('stolen')); } },
  {
    id: 'references',
    register(a) {
      a.addHook('onRequest', async (_req, reply) => { reply.header('x-references', 'yes'); });
      a.get('/api/references-own', ok('own'));
    },
  },
  { id: 'libraries', capabilities() { throw new Error('libraries capability broke'); } },
  { id: 'rename', capabilities: () => 'not an object' },
  { id: 'outputs', capabilities: async () => ({ outputs: { zip: true } }) },
  { id: 'wordcount', capabilities: 'yes' },
];
await registerFeatures(app, features);

const get = (url) => app.inject({ method: 'GET', url });
const answer = async (url) => { const r = await get(url); return r.statusCode === 200 ? r.json().ok : r.statusCode; };

eq(await answer('/api/nope'), 404, 'an unknown feature id is not registered');
eq([await answer('/api/escape-first'), await answer('/api/escape-second')], ['first', 404], 'a repeated id: the first is registered, the second not');
eq(await answer('/api/automath'), 404, 'a GET allowance is refused, with the whole feature');
eq(await answer('/api/pairs'), 404, 'an allowance outside /api/projects/:id is refused, with the whole feature');
eq(await answer('/api/tables'), 'tables', 'a feature with some bad settings still registers');
check(ps.projectSettingDef('tables.style') !== undefined, 'its good setting is registered');
check(ps.projectSettingDef('wrong.prefix') === undefined && ps.projectSettingDef('tables.novalidate') === undefined, 'its bad ones are dropped');
eq(ps.projectSettingDef('tables.style').validate('fancy'), false, 'a setting defined twice keeps its first definition');
eq(await answer('/api/crossrefs-before'), 'before', 'a register that throws keeps the routes it added');
eq(await answer('/api/references-own'), 'own', 'the features after it are registered');

const caps = await get('/api/capabilities');
eq(caps.statusCode, 200, 'a feature cannot take a core route');
const c = caps.json();
eq([c.accounts, c.outputs, 'libraries' in c], [false, { zip: true }, false], 'capabilities: a good feature merged, a throwing one left out');
check(!('0' in c), 'a non-object answer is left out');

eq((await get('/api/references-own')).headers['x-references'], 'yes', "a feature's hook applies to its own routes");
eq((await get('/api/tables')).headers['x-references'], undefined, 'and to no one else\'s');
eq((await get('/api/health')).headers['x-references'], undefined, 'nor to the core routes');

const expect = [
  'nope has an unknown id',
  'escape is listed twice',
  'automath tokenWrites entry "GET /api/projects/:id/automath"',
  'pairs viewerWrites entry "POST /api/elsewhere"',
  "project setting id \"wrong.prefix\" is not 'tables.<name>'",
  'tables.novalidate: has no validate function',
  'tables.style: already defined by tables',
  "citations: project setting id \"tables.style\" is not 'citations.<name>'",
  'crossrefs failed to register its routes: crossrefs broke while registering',
  'links failed to register its routes',
  'wordcount capabilities is not a function',
];
for (const e of expect) check(logs.some((l) => l.includes(e)), `the log says: ${e} (log: ${JSON.stringify(logs)})`);

// The project settings routes work with these definitions (accounts off: everyone may).
const p = await store.createProject('Errors', { 'main.tex': 'x\n' }, null);
let r = await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}/settings`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ set: { 'tables.style': 'booktabs' } }) });
eq([r.statusCode, r.json()], [200, { values: { 'tables.style': 'booktabs' }, rev: 1 }], 'a registered setting is writable through the core route');
r = await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}/settings`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ set: { 'tables.style': 'fancy' } }) });
eq([r.statusCode, r.json().key], [400, 'tables.style'], 'and its validator decides');

console.log('feature-host-errors: all assertions passed');
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
