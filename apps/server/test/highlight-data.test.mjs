/**
 * The highlighter's server side (WP32): a doc's highlights are tidied when it
 * loads (junk and collapsed entries go, newer versions stay, the newest 5,000
 * are kept), never touching the text; GET /api/projects/:id/highlights lists
 * them from a loaded doc or from the snapshot of a closed one, brought up to
 * the file's text when the snapshot lags it; the file on disk never holds a
 * highlight.
 *
 * Real hooks and routes on a throwaway datastore, auth off; env is set
 * before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-highlights-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN', 'ALDINE_TEST_HOOKS', 'ALDINE_BASE_PATH']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const { buildApp } = await import('../src/app.ts');
const { resolveMany } = await import('../src/features/highlighter/highlights.ts');
const app = await buildApp();

const meta = await store.createProject('Highlights', {
  'main.tex': 'Hello world.\nSecond line here.\n',
  'many.tex': 'x'.repeat(200) + '\n',
  'sub/b.tex': 'Chapter B text.\n',
}, null);
const id = meta.id;
const name = (f) => collab.docName(id, 'main', f);
const open = (f) => collab.hocuspocus.openDirectConnection(name(f), {});
const loaded = (f) => collab.hocuspocus.documents.get(name(f));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function close(conn, f) {
  await conn.disconnect();
  for (let i = 0; i < 100 && loaded(f); i++) await sleep(20);
  check(!loaded(f), `setup: ${f} unloads`);
}
const disk = (f) => fs.readFileSync(path.join(store.branchDir(id, 'main'), f), 'utf8');
const rel = (doc, index, assoc) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(doc.getText('content'), index, assoc));
const entry = (doc, from, to, extra = {}) => ({ v: 1, a: rel(doc, from, 0), b: rel(doc, to, -1), c: 'yellow', u: 'acct:u1', n: 'Ada', t: 1000, ...extra });
const list = async (branch = 'main') => {
  const res = await app.inject({ method: 'GET', url: `/api/projects/${id}/highlights?branch=${branch}` });
  return { status: res.statusCode, body: res.statusCode === 200 ? res.json() : null };
};

// ---- a closed doc: the list reads its snapshot; the next load tidies it ----
{
  const c = await open('main.tex');
  const d = loaded('main.tex');
  const text = d.getText('content');
  d.transact(() => text.insert(13, 'XYZ '), 'server-test'); // "Hello world.\nXYZ Second line here.\n"
  const hl = d.getMap('highlights');
  d.transact(() => {
    hl.set('ok', entry(d, 6, 11, { t: 2000 })); // "world"
    hl.set('gone', entry(d, 13, 16)); // "XYZ", deleted below
    hl.set('junk', 1);
    hl.set('bad', { v: 1, a: 'nope', b: {}, t: 1 });
    hl.set('later', { v: 2, whatever: true, t: 3000 });
  }, 'server-test');
  d.transact(() => text.delete(13, 4), 'server-test');
  eq(text.toString(), 'Hello world.\nSecond line here.\n', 'setup: the text is back to the file');
  await close(c, 'main.tex');
  check(!disk('main.tex').includes('highlight') && disk('main.tex') === 'Hello world.\nSecond line here.\n', 'the file on disk holds no highlight');

  const r = await list();
  eq(r.status, 200, 'GET highlights answers');
  eq(r.body.truncated, false, 'not truncated');
  eq(r.body.files.map((f) => f.path), ['main.tex'], 'only files with highlights are listed');
  eq(r.body.files[0].highlights.map((h) => [h.id, h.colour, h.author, h.authorId, h.line, h.excerpt, h.from, h.to]),
    [['ok', 'yellow', 'Ada', 'acct:u1', 1, 'world', 6, 11]], 'a closed doc lists its live highlights from the snapshot, collapsed and junk ones left out');

  const c2 = await open('main.tex');
  const keys = [...loaded('main.tex').getMap('highlights').keys()].sort();
  eq(keys, ['later', 'ok'], 'the load tidied junk, malformed and collapsed entries, and kept a newer version');
  eq(loaded('main.tex').getText('content').toString(), 'Hello world.\nSecond line here.\n', 'the tidy never touched the text');
  // A live doc is listed from memory.
  const d2 = loaded('main.tex');
  d2.transact(() => d2.getMap('highlights').set('live', entry(d2, 13, 19, { c: '#3366ff', t: 5000 })), 'server-test');
  const r2 = await list();
  eq(r2.body.files[0].highlights.map((h) => [h.id, h.colour, h.line, h.excerpt]),
    [['live', '#3366ff', 2, 'Second'], ['ok', 'yellow', 1, 'world']], 'a loaded doc is listed live, newest first');
  await close(c2, 'main.tex');
}

// ---- a snapshot that lags the file is brought up to it first ----
{
  fs.writeFileSync(path.join(store.branchDir(id, 'main'), 'main.tex'), 'Intro.\nHello world.\nSecond line here.\n');
  const r = await list();
  const ok = r.body.files[0].highlights.find((h) => h.id === 'ok');
  eq([ok.line, ok.excerpt], [2, 'world'], 'a file changed while closed: the highlight is still on its text');
}

// ---- the cap: the newest 5,000 stay ----
{
  const c = await open('many.tex');
  const d = loaded('many.tex');
  d.transact(() => {
    const hl = d.getMap('highlights');
    for (let i = 0; i < 5003; i++) hl.set(`k${String(i).padStart(5, '0')}`, entry(d, i % 199, (i % 199) + 1, { t: 10_000 + i }));
  }, 'server-test');
  await close(c, 'many.tex');
  const c2 = await open('many.tex');
  const keys = [...loaded('many.tex').getMap('highlights').keys()];
  eq(keys.length, 5000, 'the load keeps 5,000');
  check(!keys.includes('k00000') && !keys.includes('k00002') && keys.includes('k00003') && keys.includes('k05002'), 'the oldest go first');
  await close(c2, 'many.tex');
}

// ---- resolveMany agrees with Yjs, one position at a time ----
{
  const a = new Y.Doc();
  const b = new Y.Doc();
  const sync = () => { Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); };
  a.getText('content').insert(0, 'The quick brown fox jumps over the lazy dog.');
  sync();
  const ta = a.getText('content');
  const positions = [];
  for (let i = 0; i <= ta.length; i++) positions.push(rel(a, i, 0), rel(a, i, -1));
  b.getText('content').insert(10, 'very ');
  ta.delete(4, 6);
  ta.insert(0, '>> ');
  sync();
  const one = positions.map((p) => {
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(p), a);
    return abs ? abs.index : null;
  });
  eq(resolveMany(a, ta, positions), one, 'every position resolves where Yjs puts it');
  eq(resolveMany(a, ta, [null, 'x', { item: { client: 'x', clock: 1 } }, { item: { client: 999, clock: 5 } }]), [null, null, null, null], 'junk resolves to null');
}

// ---- unknown branch ----
eq((await list('no-such-branch')).status, 404, 'an unknown branch is a 404');

console.log('highlight-data: all assertions passed');
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
