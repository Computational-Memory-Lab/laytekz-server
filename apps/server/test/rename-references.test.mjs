/**
 * The reference-aware rename (V2 feature 10, WP28) through its real routes:
 * the preview, the apply as one commit with trailers, an open document
 * edited in place, highlights carried with the file and onto a new branch,
 * /revert putting names, text and the main document back, the manual-commits
 * undo, the title pair, and the plain /file/rename unchanged.
 *
 * Real routes and collab on a throwaway JSON datastore, auth off; env is set
 * before any src import. The autosave debounce is pushed past the test.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-rename-refs-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN']) delete process.env[k];

const { default: Fastify } = await import('fastify');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const { registerFeatures } = await import('../src/features/host.ts');
const { default: renameFeature } = await import('../src/features/rename/server.ts');
const store = await import('../src/store.ts');
const collab = await import('../src/collab.ts');

const app = Fastify({ logger: false });
await registerRoutes(app);
await registerFeatures(app, [renameFeature]);
await app.ready();

const PAPER = [
  '\\documentclass{article}',
  '\\addbibresource{paper.bib}',
  '\\title{Rename Test}',
  '\\begin{document}',
  '\\input{chapters/intro}',
  '% \\input{chapters/intro}',
  '\\end{document}',
  '',
].join('\n');
const p = await store.createProject('Rename Test', {
  'paper.tex': PAPER, 'paper.bib': '@misc{a, title={A}}\n', 'chapters/intro.tex': 'Intro.\n',
});
const id = p.id;
{
  const meta = await store.readMeta(id);
  meta.rootFile = 'paper.tex';
  await store.writeMeta(meta);
}

const B = (b = 'main') => store.branchDir(id, b);
const disk = (rel, b) => fs.readFileSync(path.join(B(b), rel), 'utf8');
const exists = (rel, b) => fs.existsSync(path.join(B(b), rel));
const git = (...args) => execFileSync('git', args, { cwd: B(), encoding: 'utf8' });
const name = (rel, b = 'main') => collab.docName(id, b, rel);
const inject = (method, url, payload) => app.inject({ method, url, ...(payload !== undefined ? { payload } : {}) });
const planOf = async (from, to) => inject('GET', `/api/projects/${id}/file/rename-plan?branch=main&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
const settle = () => new Promise((r) => setTimeout(r, 50));

// A highlight in the included file's doc, and the root open with typing in it.
const introConn = await collab.hocuspocus.openDirectConnection(name('chapters/intro.tex'), {});
await introConn.transact((doc) => doc.getMap('highlights').set('h1', JSON.stringify({ colour: 'yellow' })));
git('add', '-A');
git('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'base', '--allow-empty');
const paperConn = await collab.hocuspocus.openDirectConnection(name('paper.tex'), {});
await paperConn.transact((doc) => doc.getText('content').insert(0, '% typed\n'));

// ---- preview: an included file
let res = await planOf('chapters/intro.tex', 'chapters/introduction.tex');
check(res.statusCode === 200, `plan answers (${res.statusCode} ${res.body})`);
let plan = res.json();
eq(plan.renames, [{ from: 'chapters/intro.tex', to: 'chapters/introduction.tex', kind: 'requested', checked: true }], 'only the requested rename');
eq(plan.edits.map((e) => [e.file, e.line, e.kind, e.checked, e.after]), [
  ['paper.tex', 6, 'code', true, '\\input{chapters/introduction}'],
  ['paper.tex', 7, 'comment', false, '% \\input{chapters/introduction}'],
], 'the live text (with the typed line) is what was scanned; the comment starts unchecked');
eq(plan.settings, [], 'no setting names the file');
check(!exists('chapters/introduction.tex'), 'the preview changes nothing');

// ---- apply the checked edits
const checkedIds = plan.edits.filter((e) => e.checked).map((e) => e.id);
res = await inject('POST', `/api/projects/${id}/file/rename-apply`, { branch: 'main', from: 'chapters/intro.tex', to: 'chapters/introduction.tex', renames: [], edits: checkedIds });
check(res.statusCode === 200, `apply answers (${res.statusCode} ${res.body})`);
let out = res.json();
eq([out.renamed, out.edited, out.skipped, out.files], [1, 1, 0, 1], 'one file renamed, one reference updated');
check(typeof out.commit === 'string', 'a commit was made');
check(exists('chapters/introduction.tex') && !exists('chapters/intro.tex'), 'the file moved');
const paperText = paperConn.document.getText('content').toString();
check(paperText.startsWith('% typed\n'), 'typing in the open referencing file survives');
check(paperText.includes('\\input{chapters/introduction}\n% \\input{chapters/intro}\n'), `the open doc got the argument only (${paperText})`);
eq(disk('paper.tex'), paperText, 'and is on disk');
const firstCommit = git('rev-parse', 'HEAD').trim();
const status = git('show', '--name-status', '--format=%B', 'HEAD');
check(/^R\d*\tchapters\/intro\.tex\tchapters\/introduction\.tex$/m.test(status), `git records a rename (${status})`);
check(/^M\tpaper\.tex$/m.test(status), 'and the reference edit, in the same commit');
check(status.includes('Aldine-Moves: [["chapters/intro.tex","chapters/introduction.tex"]]'), 'with the moves trailer');
check(!git('show', '--format=', 'HEAD', '--', 'paper.tex').includes('+% typed'), 'the earlier typing went into its own autosave, not the rename');
check(git('log', '--format=%s', '-4').includes('laytekz: autosave'), `that autosave comes before it (${git('log', '--format=%s', '-4')})`);
eq(git('status', '--porcelain'), '', 'the tree is clean');

// ---- the highlight came along
await settle();
let moved = await collab.hocuspocus.openDirectConnection(name('chapters/introduction.tex'), {});
eq(moved.document.getMap('highlights').get('h1'), JSON.stringify({ colour: 'yellow' }), 'the highlight survives the rename');
eq(moved.document.getText('content').toString(), 'Intro.\n', 'the text is the file');
await moved.disconnect();

// ---- a new branch starts with the highlights
res = await inject('POST', `/api/projects/${id}/branches`, { name: 'b2', from: 'main' });
check(res.statusCode === 200, `branch created (${res.body})`);
const onB2 = await collab.hocuspocus.openDirectConnection(name('chapters/introduction.tex', 'b2'), {});
eq(onB2.document.getMap('highlights').get('h1'), JSON.stringify({ colour: 'yellow' }), 'the new branch has the highlight');
await onB2.disconnect();

// ---- revert puts the name, the text and the highlight back
res = await inject('POST', `/api/projects/${id}/revert`, { branch: 'main', hashes: [firstCommit], message: 'Undo rename' });
check(res.statusCode === 200 && res.json().ok, `revert answers (${res.statusCode} ${res.body})`);
check(exists('chapters/intro.tex') && !exists('chapters/introduction.tex'), 'the old name is back');
check(paperConn.document.getText('content').toString().includes('\\input{chapters/intro}\n'), 'the open referencing doc reads the old name again');
await settle();
moved = await collab.hocuspocus.openDirectConnection(name('chapters/intro.tex'), {});
eq(moved.document.getMap('highlights').get('h1'), JSON.stringify({ colour: 'yellow' }), 'the highlight went back with it');
await moved.disconnect();

// ---- the main document with its sibling .bib
res = await planOf('paper.tex', 'thesis.tex');
plan = res.json();
eq(plan.renames.map((r) => [r.from, r.to, r.kind, r.checked]), [['paper.tex', 'thesis.tex', 'requested', true], ['paper.bib', 'thesis.bib', 'sibling', true]], 'the .bib is offered, checked');
eq(plan.settings, [{ label: 'Main document', from: 'paper.tex', to: 'thesis.tex' }], 'the main document setting follows');
const bibEdit = plan.edits.find((e) => e.after.includes('thesis.bib'));
check(bibEdit && bibEdit.checked && bibEdit.follows === 'paper.bib', 'its reference follows the sibling');
res = await inject('POST', `/api/projects/${id}/file/rename-apply`, { branch: 'main', from: 'paper.tex', to: 'thesis.tex', renames: [{ from: 'paper.tex', to: 'thesis.tex' }, { from: 'paper.bib', to: 'thesis.bib' }], edits: plan.edits.filter((e) => e.checked).map((e) => e.id) });
check(res.statusCode === 200, `root rename applies (${res.body})`);
out = res.json();
eq(out.newRoot, 'thesis.tex', 'the new main document is reported');
eq((await store.readMeta(id)).rootFile, 'thesis.tex', 'and stored');
check(exists('thesis.bib') && !exists('paper.bib'), 'the sibling moved');
check(disk('thesis.tex').includes('\\addbibresource{thesis.bib}'), 'its reference was updated');
const rootCommit = git('rev-parse', 'HEAD').trim();
check(git('show', '-s', '--format=%B', 'HEAD').includes('Aldine-Meta: {"rootFile":["paper.tex","thesis.tex"]}'), 'the meta trailer records the main document');
res = await inject('POST', `/api/projects/${id}/revert`, { branch: 'main', hashes: [rootCommit], message: 'Undo' });
check(res.statusCode === 200 && res.json().newRoot === 'paper.tex', `revert reports the main document it put back (${res.body})`);
eq((await store.readMeta(id)).rootFile, 'paper.tex', 'the main document is paper.tex again');
check(exists('paper.bib') && disk('paper.tex').includes('\\addbibresource{paper.bib}'), 'names and text restored');

// ---- refusals change nothing
res = await inject('POST', `/api/projects/${id}/file/rename-apply`, { branch: 'main', from: 'paper.tex', to: 'paper.bib' });
eq(res.statusCode, 409, 'a taken name is refused');
res = await inject('POST', `/api/projects/${id}/file/rename-apply`, { branch: 'main', from: 'paper.tex', to: 'bad;name.tex' });
eq(res.statusCode, 409, 'a main document name the compiler refuses blocks the rename');
check(exists('paper.tex'), 'nothing moved');
res = await inject('POST', `/api/projects/${id}/file/rename`, { branch: 'main', from: 'paper.tex', to: 'bad;name.tex' });
eq(res.statusCode, 400, 'the plain rename checks the main document name too');
res = await inject('POST', `/api/projects/${id}/file/rename-apply`, { branch: 'main', from: 'chapters/intro.tex', to: 'chapters/x.tex', edits: ['000000000000'] });
check(res.statusCode === 200 && res.json().skipped === 1 && res.json().edited === 0, 'an unknown edit id is skipped, the rename made');
check(disk('paper.tex').includes('\\input{chapters/intro}\n'), 'and no reference was touched');

// ---- the plain rename keeps its reply and now carries the document state
// (to a name nobody left a moment ago: a just-vacated name keeps its own identity)
res = await inject('POST', `/api/projects/${id}/file/rename`, { branch: 'main', from: 'chapters/x.tex', to: 'chapters/y.tex' });
eq(res.json(), { ok: true }, 'old-format reply unchanged');
await settle();
moved = await collab.hocuspocus.openDirectConnection(name('chapters/y.tex'), {});
eq(moved.document.getMap('highlights').get('h1'), JSON.stringify({ colour: 'yellow' }), 'the plain rename keeps the highlight too');
await moved.disconnect();

// ---- the title pair
res = await inject('GET', `/api/projects/${id}/title-plan?branch=main&from=${encodeURIComponent('Rename Test')}&to=${encodeURIComponent('New & Name')}`);
let tp = res.json();
check(tp.offer === true && tp.edits.length === 1 && tp.edits[0].after === '\\title{New \\& Name}', `the title is offered (${res.body})`);
res = await inject('GET', `/api/projects/${id}/title-plan?branch=main&from=Other&to=New`);
eq(res.json().offer, false, 'a title that does not carry the old name is not offered');
res = await inject('POST', `/api/projects/${id}/title-apply`, { branch: 'main', from: 'Rename Test', to: 'New & Name' });
check(res.statusCode === 200 && res.json().edited === 1 && res.json().commit, `title applied (${res.body})`);
check(disk('paper.tex').includes('\\title{New \\& Name}'), 'the file carries the new title');
eq(git('show', '-s', '--format=%s', 'HEAD').trim(), 'Change the document title to New & Name', 'as its own commit');

// ---- manual commits: an undo image instead of a commit
{
  const meta = await store.readMeta(id);
  meta.manualCommits = true;
  await store.writeMeta(meta);
}
const head = git('rev-parse', 'HEAD').trim();
plan = (await planOf('paper.tex', 'thesis.tex')).json();
res = await inject('POST', `/api/projects/${id}/file/rename-apply`, { branch: 'main', from: 'paper.tex', to: 'thesis.tex', renames: [{ from: 'paper.bib', to: 'thesis.bib' }], edits: plan.edits.filter((e) => e.checked).map((e) => e.id) });
out = res.json();
check(res.statusCode === 200 && typeof out.undo === 'string' && !out.commit, `manual: an undo token, no commit (${res.body})`);
eq(git('rev-parse', 'HEAD').trim(), head, 'no commit was made');
res = await inject('POST', `/api/projects/${id}/undo`, { branch: 'main', token: out.undo });
check(res.statusCode === 200 && res.json().newRoot === 'paper.tex', `undo answers with the main document (${res.body})`);
check(exists('paper.tex') && exists('paper.bib') && !exists('thesis.tex') && !exists('thesis.bib'), 'undo puts the names back');
check(disk('paper.tex').includes('\\addbibresource{paper.bib}'), 'and the text');
eq((await store.readMeta(id)).rootFile, 'paper.tex', 'and the main document');

await introConn.disconnect().catch(() => {});
await paperConn.disconnect().catch(() => {});
await app.close();
console.log('rename-references: ok');
process.exit(0);
