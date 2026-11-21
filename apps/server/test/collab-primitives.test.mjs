/**
 * The V2 collab primitives (WP03), before any route uses them:
 * flushBranchDocsHashed hashes each doc's own text in the flush itself;
 * branchChangeEvents reports every change of a branch's files; applySpansToDoc
 * edits an open doc by its changed spans; moveDocState and copyDocState carry
 * a doc's snapshot (its side maps, its history) to a new path, branch or
 * project and never reseed a doc from plain text; signalBranch reaches the
 * branch's open editors; doc-load hooks see the snapshot before any client;
 * an update that touches only a side map is not an edit.
 *
 * Real hooks on a throwaway datastore, auth off; env is set before any src
 * import. The autosave debounce is pushed past the test's lifetime.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as Y from 'yjs';
import { check, eq, throws } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-collab-prims-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN', 'ALDINE_TEST_HOOKS']) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');
const gitops = await import('../src/gitops.ts');
const activity = await import('../src/activity.ts');

const LINES = Array.from({ length: 30 }, (_, i) => `Sentence ${i} of the draft.\n`).join('');
const meta = await store.createProject('Primitives', {
  'main.tex': 'Hello world.\nSecond line.\n',
  'crlf.tex': 'One\r\nTwo\r\n',
  'e.tex': 'é\n',
  'spans.tex': LINES,
  'move.tex': 'A file about to move.\nIts second line.\n',
  'late.tex': 'Flushed text.\n',
  'closed.tex': 'Closed text.\n',
  'never.tex': 'Never opened.\n',
  'src.tex': 'Source.\n',
  'chapters/a.tex': 'Chapter A.\n',
  'chapters/b.tex': 'Chapter B.\n',
  'hooked.tex': 'Hooked.\n',
}, null);
const id = meta.id;
const dir = store.branchDir(id, 'main');
const yjsDir = path.join(process.env.META_DIR, 'yjs');
const name = (f, branch = 'main', pid = id) => collab.docName(pid, branch, f);
const snapFile = (n) => path.join(yjsDir, crypto.createHash('sha1').update(n).digest('hex') + '.ybin');
const open = (f, branch = 'main', pid = id) => collab.hocuspocus.openDirectConnection(name(f, branch, pid), {});
const loaded = (f, branch = 'main', pid = id) => collab.hocuspocus.documents.get(name(f, branch, pid));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function close(conn, f, branch = 'main', pid = id) {
  await conn.disconnect();
  for (let i = 0; i < 100 && loaded(f, branch, pid); i++) await sleep(20);
  check(!loaded(f, branch, pid), `setup: ${f} unloads`);
}
const disk = (f, pid = id, branch = 'main') => fs.readFileSync(path.join(store.branchDir(pid, branch), f), 'utf8');
const sha16 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const rel = (doc, index, assoc) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(doc.getText('content'), index, assoc));
const at = (doc, json) => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc)?.index;
/** Applying `state` (a copy of the doc's earlier history, as a reconnecting client holds it) changes nothing: the doc was not reseeded. */
function sameHistory(doc, state, what) {
  const before = doc.getText('content').toString();
  Y.applyUpdate(doc, state);
  eq(doc.getText('content').toString(), before, `${what}: a copy of the earlier history merges without duplicating anything`);
}
async function errorsOf(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  try { return { value: await fn(), lines }; } finally { console.error = orig; }
}

// ---- branchChangeEvents ----
{
  const seen = [];
  const listener = (c) => seen.push(c);
  collab.branchChangeEvents.on('change', listener);
  const v = collab.markPathsChanged(id, 'main', ['./x.tex', 'sub/y.tex']);
  eq(seen.at(-1), { projectId: id, branch: 'main', paths: ['x.tex', 'sub/y.tex'], version: v }, 'a path change is reported with normalised paths and the new version');
  check(Object.isFrozen(seen.at(-1)) && Object.isFrozen(seen.at(-1).paths), 'the event is frozen: one listener cannot change what the next sees');
  const t = collab.markTreeChanged(id, 'main');
  eq(seen.at(-1), { projectId: id, branch: 'main', paths: null, version: t }, 'a tree-wide change is reported with paths null');

  const boom = () => { throw new Error('listener bug'); };
  const after = [];
  const second = (c) => after.push(c.version);
  collab.branchChangeEvents.on('change', boom);
  collab.branchChangeEvents.on('change', second);
  const { value: v2, lines } = await errorsOf(() => collab.markPathsChanged(id, 'main', ['z.tex']));
  eq(collab.contentVersion(id, 'main'), v2, 'a throwing listener does not stop the version change');
  eq(after, [v2], 'and the listeners after it still run');
  check(lines.some((l) => l.includes('listener bug')), 'the throw is logged');
  collab.branchChangeEvents.off('change', boom);
  collab.branchChangeEvents.off('change', second);

  // a doc store that changes the file is a change of that path
  const c = await open('main.tex');
  loaded('main.tex').getText('content').insert(0, 'Edited. ');
  const n = seen.length;
  collab.flushBranchDocs(id, 'main');
  eq(seen.slice(n).map((e) => e.paths), [['main.tex']], 'a flushed edit reports its one path');
  collab.flushBranchDocs(id, 'main');
  eq(seen.length, n + 1, 'a flush that writes nothing reports nothing');
  collab.branchChangeEvents.off('change', listener);
  collab.markPathsChanged(id, 'main', ['w.tex']);
  eq(seen.length, n + 1, 'off() stops the reports');
  await close(c, 'main.tex');
}

// ---- flushBranchDocsHashed ----
{
  const conns = [await open('main.tex'), await open('crlf.tex'), await open('e.tex'), await open(collab.FILES_SIGNAL)];
  const main = loaded('main.tex').getText('content');
  main.insert(main.length, 'Ünïcode línе.\n');
  const hashes = collab.flushBranchDocsHashed(id, 'main');
  eq(Object.keys(hashes).sort(), ['crlf.tex', 'e.tex', 'main.tex'], 'every open project file of the branch, and not the signal doc');
  eq(hashes['main.tex'], sha16(main.toString()), 'the hash is of the doc\'s text');
  eq(disk('main.tex'), main.toString(), 'and the flush wrote that text');
  eq(disk('crlf.tex'), 'One\r\nTwo\r\n', 'a CRLF file keeps its line endings on disk');
  eq(hashes['crlf.tex'], sha16('One\nTwo\n'), 'but its hash is of the LF text the editor holds');
  eq(hashes['e.tex'], 'edd3a863872a0423', 'UTF-8, the first 16 hex digits of SHA-256 (pinned: what the browser computes for "é\\n")');
  check(Object.getPrototypeOf(hashes) === null, 'the map has no prototype (a file may be called __proto__)');
  eq(collab.flushBranchDocsHashed(id, 'other'), {}, 'another branch has no open docs');
  for (const [c, f] of conns.map((c, i) => [c, ['main.tex', 'crlf.tex', 'e.tex', collab.FILES_SIGNAL][i]])) await close(c, f);
}

// ---- applySpansToDoc ----
{
  eq(collab.applySpansToDoc(id, 'main', 'spans.tex', 'whatever'), null, 'no open doc: null, the caller writes the file');
  eq(collab.applySpansToDoc(id, 'main', collab.FILES_SIGNAL, 'x'), null, 'a signal doc is not a text doc');
  const c = await open('spans.tex');
  const doc = loaded('spans.tex');
  const text = doc.getText('content');
  const cursor = rel(doc, LINES.indexOf('Sentence 15'));
  const deltas = [];
  text.observe((e) => deltas.push(e.delta));
  const after = LINES.replace('Sentence 2 of', 'Sentence two of').replace('Sentence 28 of the draft.\n', '');
  const spans = collab.applySpansToDoc(id, 'main', 'spans.tex', after.replace(/\n/g, '\r\n'), 'rename-test');
  eq(text.toString(), after, 'the doc holds the new text, in LF');
  eq(disk('spans.tex'), after, 'and the file was written');
  eq(text.toString().slice(at(doc, cursor), at(doc, cursor) + 11), 'Sentence 15', "a co-author's cursor stays on its character");
  check(deltas.length === 1, 'one transaction');
  eq([spans.length, after.slice(spans[0].from, spans[0].to), spans[1].to - spans[1].from], [2, 'two', 0], `the changed spans in the new text's offsets, a deletion as an empty one: ${JSON.stringify(spans)}`);
  eq([...doc.getMap(collab.AGENT_EDITS_KEY).keys()], [], 'a non-agent origin marks nothing');
  eq(collab.applySpansToDoc(id, 'main', 'spans.tex', after), [], 'unchanged text: no spans');
  collab.applySpansToDoc(id, 'main', 'spans.tex', after.replace('Sentence 9 of', 'Sentence nine of'), collab.AGENT_ORIGIN);
  eq(doc.getMap(collab.AGENT_EDITS_KEY).size, 1, "AGENT_ORIGIN marks the change as Claude's");
  await close(c, 'spans.tex');
}

// ---- moveDocState: a loaded file ----
{
  const sig = await open(collab.FILES_SIGNAL);
  const c = await open('move.tex');
  const doc = loaded('move.tex');
  const text = doc.getText('content');
  doc.transact(() => doc.getMap('highlights').set('h1', { a: rel(doc, 2), b: rel(doc, 6, -1), c: 'yellow' }), 'server-test');
  text.insert(text.length, 'Typed before the rename.\n');
  const history = Y.encodeStateAsUpdate(doc);
  collab.flushBranchDocs(id, 'main'); // the rename route flushes first
  const contentBefore = text.toString();
  const signalBefore = loaded(collab.FILES_SIGNAL).getMap('signal').get('v');
  fs.renameSync(path.join(dir, 'move.tex'), path.join(dir, 'moved.tex'));
  collab.moveDocState(id, 'main', 'move.tex', 'moved.tex');
  check(!loaded('move.tex'), 'the old doc is evicted');
  check(!fs.existsSync(snapFile(name('move.tex'))), 'no snapshot stays under the old name');
  check(fs.existsSync(snapFile(name('moved.tex'))), 'it is under the new name');
  check(loaded(collab.FILES_SIGNAL).getMap('signal').get('v') !== signalBefore, "the branch's file list signal moved");
  await throws(() => open('move.tex'), 'file was deleted', 'a client of the old name is refused, as after evictDoc');
  await c.disconnect().catch(() => {});
  const c2 = await open('moved.tex');
  const moved = loaded('moved.tex');
  eq(moved.getText('content').toString(), contentBefore, 'the new doc holds the file');
  const h = moved.getMap('highlights').get('h1');
  check(h && h.c === 'yellow', 'the side map came along');
  eq([at(moved, h.a), at(moved, h.b)], [2, 6], 'its anchors resolve to the same characters');
  sameHistory(moved, history, 'a renamed file');
  await close(c2, 'moved.tex');
  await close(sig, collab.FILES_SIGNAL);
}

// ---- moveDocState: an edit after the flush, a closed doc, no snapshot, a busy target ----
{
  const c = await open('late.tex');
  const doc = loaded('late.tex');
  collab.flushBranchDocs(id, 'main');
  doc.getText('content').insert(0, 'Typed during the rename. ');
  const history = Y.encodeStateAsUpdate(doc);
  fs.renameSync(path.join(dir, 'late.tex'), path.join(dir, 'later.tex'));
  collab.moveDocState(id, 'main', 'late.tex', 'later.tex');
  await c.disconnect().catch(() => {});
  const c2 = await open('later.tex');
  eq(loaded('later.tex').getText('content').toString(), 'Flushed text.\n', 'the file on disk wins over an edit it never got');
  sameHistory(loaded('later.tex'), history, 'a doc moved with an unflushed edit');
  await close(c2, 'later.tex');

  const c3 = await open('closed.tex');
  const cd = loaded('closed.tex');
  cd.transact(() => cd.getMap('highlights').set('k', { c: 'green' }), 'server-test');
  const closedHistory = Y.encodeStateAsUpdate(cd);
  await close(c3, 'closed.tex');
  fs.renameSync(path.join(dir, 'closed.tex'), path.join(dir, 'reopened.tex'));
  collab.moveDocState(id, 'main', 'closed.tex', 'reopened.tex');
  const c4 = await open('reopened.tex');
  eq(loaded('reopened.tex').getMap('highlights').get('k'), { c: 'green' }, 'a closed doc moves with its snapshot');
  sameHistory(loaded('reopened.tex'), closedHistory, 'a closed doc moved');
  await close(c4, 'reopened.tex');

  // a stale snapshot at the target, of some earlier file there
  const stale = new Y.Doc();
  stale.getText('content').insert(0, 'Stale.\n');
  stale.getMap('highlights').set('old', { c: 'pink' });
  fs.writeFileSync(snapFile(name('fresh.tex')), Y.encodeStateAsUpdate(stale));
  fs.renameSync(path.join(dir, 'never.tex'), path.join(dir, 'fresh.tex'));
  collab.moveDocState(id, 'main', 'never.tex', 'fresh.tex');
  check(!fs.existsSync(snapFile(name('fresh.tex'))), 'a file never opened leaves no snapshot at the target, not even a stale one');
  const c5 = await open('fresh.tex');
  eq(loaded('fresh.tex').getText('content').toString(), 'Never opened.\n', 'it loads from its file');
  eq(loaded('fresh.tex').getMap('highlights').size, 0, 'with no stale side map');
  await close(c5, 'fresh.tex');

  // a doc already loaded at the target keeps its own identity
  const cs = await open('src.tex');
  await close(cs, 'src.tex');
  const busy = await open('busy.tex');
  collab.moveDocState(id, 'main', 'src.tex', 'busy.tex');
  check(!fs.existsSync(snapFile(name('src.tex'))), 'the source snapshot goes, as with evictDoc');
  eq(loaded('busy.tex').getText('content').toString(), '', 'the loaded target is left as it was');
  await close(busy, 'busy.tex');
}

// ---- moveDocState: a folder ----
{
  const files = store.listFiles(id, 'main').filter((e) => e.type === 'file').map((e) => e.path);
  const ca = await open('chapters/a.tex');
  const da = loaded('chapters/a.tex');
  da.transact(() => da.getMap('highlights').set('a', { c: 'blue' }), 'server-test');
  const historyA = Y.encodeStateAsUpdate(da);
  const cb = await open('chapters/b.tex');
  const db = loaded('chapters/b.tex');
  db.transact(() => db.getMap('highlights').set('b', { c: 'blue' }), 'server-test');
  const historyB = Y.encodeStateAsUpdate(db);
  await close(cb, 'chapters/b.tex');
  collab.flushBranchDocs(id, 'main');
  fs.renameSync(path.join(dir, 'chapters'), path.join(dir, 'parts'));
  collab.moveDocState(id, 'main', 'chapters/', 'parts', { folder: true, files });
  check(!loaded('chapters/a.tex'), 'the loaded child is evicted');
  await ca.disconnect().catch(() => {});
  for (const [f, key, history] of [['parts/a.tex', 'a', historyA], ['parts/b.tex', 'b', historyB]]) {
    const c = await open(f);
    eq(loaded(f).getMap('highlights').get(key), { c: 'blue' }, `${f}: its side map moved with the folder`);
    sameHistory(loaded(f), history, f);
    await close(c, f);
  }
}

// ---- copyDocState: a new branch and a project copy ----
{
  const p = await store.createProject('Copies', { 'one.tex': 'One.\n', 'two.tex': 'Two.\n' }, null);
  const c1 = await open('one.tex', 'main', p.id);
  const one = loaded('one.tex', 'main', p.id);
  one.transact(() => one.getMap('highlights').set('h', { a: rel(one, 1), c: 'yellow' }), 'server-test');
  const c2 = await open('two.tex', 'main', p.id);
  const two = loaded('two.tex', 'main', p.id);
  two.transact(() => two.getMap('highlights').set('t', { c: 'green' }), 'server-test');
  await close(c2, 'two.tex', 'main', p.id);
  await gitops.createBranch(p.id, 'feat', 'main');
  eq(collab.copyDocState({ projectId: p.id, branch: 'main' }, { projectId: p.id, branch: 'feat' }, ['one.tex', './two.tex', 'missing.tex', '.git/config']), 2,
    'a live doc and a snapshot are copied; a file with no state and a hidden path are not');
  const f1 = await open('one.tex', 'feat', p.id);
  const feat = loaded('one.tex', 'feat', p.id);
  eq(feat.getText('content').toString(), 'One.\n', 'the branch doc holds its file');
  eq(at(feat, feat.getMap('highlights').get('h').a), 1, 'with the side map, anchored where it was');
  sameHistory(feat, Y.encodeStateAsUpdate(one), 'a doc copied to a new branch');
  feat.getText('content').insert(0, 'Branch only. ');
  eq(one.getText('content').toString(), 'One.\n', 'the branch is independent afterwards');
  const f2 = await open('two.tex', 'feat', p.id);
  eq(loaded('two.tex', 'feat', p.id).getMap('highlights').get('t'), { c: 'green' }, 'the closed doc\'s side map too');
  eq(collab.copyDocState({ projectId: p.id, branch: 'main' }, { projectId: p.id, branch: 'feat' }, ['one.tex', 'two.tex']), 0, 'a loaded target is never overwritten');
  eq(collab.copyDocState({ projectId: p.id, branch: 'main' }, { projectId: p.id, branch: 'main' }, ['one.tex']), 0, 'a copy onto itself does nothing');
  await close(f1, 'one.tex', 'feat', p.id);
  await close(f2, 'two.tex', 'feat', p.id);

  const copy = await store.copyProject(await store.readMeta(p.id), 'Copies (copy)');
  eq(collab.copyDocState({ projectId: p.id, branch: 'main' }, { projectId: copy.id, branch: 'main' }, ['one.tex']), 1, 'a project copy gets the snapshot');
  const k = await open('one.tex', 'main', copy.id);
  eq(loaded('one.tex', 'main', copy.id).getMap('highlights').get('h').c, 'yellow', 'with the side map');
  await close(k, 'one.tex', 'main', copy.id);
  await close(c1, 'one.tex', 'main', p.id);

  // ---- signalBranch ----
  await gitops.createBranch(p.id, 'side', 'main');
  const sm = await open(collab.FILES_SIGNAL, 'main', p.id);
  const sf = await open(collab.FILES_SIGNAL, 'feat', p.id);
  const other = await open(collab.FILES_SIGNAL, 'main', id);
  const map = (b, pid = p.id) => loaded(collab.FILES_SIGNAL, b, pid).getMap('signal');
  collab.signalBranch(p.id, 'main', 'settings', 3);
  eq([map('main').get('settings'), map('feat').get('settings')], [3, undefined], 'one branch gets the value');
  const moves = { moves: [['a.tex', 'b.tex']], by: 'Ada', at: 1 };
  collab.signalBranch(p.id, '*', 'moves', moves);
  eq([map('main').get('moves'), map('feat').get('moves')], [moves, moves], "'*' reaches every open branch of the project");
  eq(map('main', id).get('moves'), undefined, 'and no other project');
  collab.signalBranch(p.id, 'side', 'settings', 4); // nobody has it open
  for (const k2 of ['v', 'a', 'ts', 'td', 'c', 'r', '']) await throws(() => collab.signalBranch(p.id, 'main', k2, 1), 'not a key features may signal', `the built-in key ${JSON.stringify(k2)} is refused`);
  eq(map('main').get('v'), undefined, 'and left alone');
  await close(sm, collab.FILES_SIGNAL, 'main', p.id);
  await close(sf, collab.FILES_SIGNAL, 'feat', p.id);
  await close(other, collab.FILES_SIGNAL, 'main', id);
}

// ---- registerDocLoadHook ----
{
  const c = await open('hooked.tex');
  const d = loaded('hooked.tex');
  d.transact(() => { d.getMap('highlights').set('keep', 1); d.getMap('highlights').set('tidy', 1); }, 'server-test');
  await close(c, 'hooked.tex');
  const calls = [];
  const remove = collab.registerDocLoadHook((doc, docName) => {
    const hl = doc.getMap('highlights');
    calls.push({ docName, text: doc.getText('content').toString(), keys: [...hl.keys()].sort() });
    if (hl.has('tidy')) doc.transact(() => hl.delete('tidy'), 'server-tidy');
  });
  const throwing = collab.registerDocLoadHook(() => { throw new Error('hook bug'); });
  const { value: c2, lines } = await errorsOf(() => open('hooked.tex'));
  eq(calls, [{ docName: name('hooked.tex'), text: 'Hooked.\n', keys: ['keep', 'tidy'] }], 'the hook ran once, after the snapshot and the file text were in');
  check(lines.some((l) => l.includes('hook bug')), 'a throwing hook is logged');
  eq([...loaded('hooked.tex').getMap('highlights').keys()], ['keep'], 'the hook\'s tidy is in the doc a client gets');
  const snap = new Y.Doc();
  Y.applyUpdate(snap, fs.readFileSync(snapFile(name('hooked.tex'))));
  eq([...snap.getMap('highlights').keys()], ['keep'], 'and in its snapshot at once, before any store');
  await close(c2, 'hooked.tex');
  const sig = await open(collab.FILES_SIGNAL);
  eq(calls.length, 1, 'a signal doc runs no hooks');
  await close(sig, collab.FILES_SIGNAL);
  remove();
  remove();
  throwing();
  const c3 = await open('hooked.tex');
  eq(calls.length, 1, 'a removed hook no longer runs');
  eq([...loaded('hooked.tex').getMap('highlights').keys()], ['keep'], "the tidy was written to the snapshot");
  await close(c3, 'hooked.tex');
}

// ---- side-map-only updates are not edits ----
{
  const p = await store.createProject('Activity', { 'a.tex': 'Some text.\n' }, null);
  const lastEdit = async () => (await activity.activitySnapshot()).get(p.id)?.lastEdit ?? null;
  const c = await open('a.tex', 'main', p.id);
  const doc = loaded('a.tex', 'main', p.id);
  // A client's update reaches the doc with its connection as the origin.
  const client = { context: { userId: 'u-ada', userName: 'Ada' } };
  eq(await lastEdit(), null, 'setup: no edit yet');
  doc.transact(() => doc.getMap('highlights').set('x', { c: 'yellow' }), client);
  doc.transact(() => doc.getMap('highlights').delete('x'), client);
  await sleep(30);
  eq(await lastEdit(), null, 'a highlight-only update leaves "last edited" alone');
  collab.flushBranchDocs(p.id, 'main');
  eq(disk('a.tex', p.id), 'Some text.\n', 'and writes no text');
  doc.transact(() => doc.getText('content').insert(0, 'More. '), client);
  await sleep(30);
  const e = await lastEdit();
  eq([e?.byId, e?.byName], ['u-ada', 'Ada'], 'a text update is an edit, by its sender');
  const first = e.at;
  await sleep(5);
  doc.transact(() => { doc.getMap('highlights').set('y', 1); doc.getText('content').delete(0, 1); }, client);
  await sleep(30);
  check((await lastEdit()).at > first, 'an update touching text and a side map is an edit');
  await close(c, 'a.tex', 'main', p.id);
}

console.log('collab-primitives: all assertions passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
