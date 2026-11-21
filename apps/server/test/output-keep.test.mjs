/**
 * Galley: V2 build outputs (WP30). POST /api/projects/:id/output/keep copies
 * one generated file (.bbl, .ind, .gls, .acr, .sls, .nls) from the main
 * document's .aldine-out into the project beside it, negates a .gitignore
 * rule that would ignore it, and makes one commit of both ("Add main.bbl from
 * the last typeset"; "Update …" later). Members only: viewers and bearer
 * tokens are refused; other generated files and odd names are refused; the
 * same bytes again change nothing.
 *
 * Real app, accounts on, throwaway JSON datastore.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-output-keep-')));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_PUBLIC_URL = 'https://laytekz.test';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['ALDINE_BASE_PATH', 'DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_MCP', 'ALDINE_PROTECTED_PROJECTS']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();

const people = {};
for (const who of ['ada', 'bob', 'cara']) {
  const u = await auth.register(`${who}@example.com`, 'password123', who[0].toUpperCase() + who.slice(1));
  await db().setEmailPending(u.id, null);
  people[who] = { user: u, cookie: `aldine_session=${await auth.createSession(u.id)}` };
}
const { token } = await auth.createAccessToken(people.ada.user.id, 'agent', null, null);

// An imported project whose own .gitignore ignores *.bbl (as many do).
const DOC = '\\documentclass{article}\n\\begin{document}\nA\\cite{k}\n\\bibliographystyle{plain}\\bibliography{refs}\n\\end{document}\n';
const p = await store.createProject('Keep', { 'main.tex': DOC, 'refs.bib': '@book{k, title={T}}\n', '.gitignore': '*.bbl\n*.log\n' }, people.ada.user.id);
p.share = { mode: 'private', collaborators: ['bob@example.com', 'cara@example.com'], viewers: ['cara@example.com'] };
await store.writeMeta(p);
const dir = store.branchDir(p.id, 'main');
const out = path.join(dir, '.aldine-out');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, '.aldine-run'), '');
fs.writeFileSync(path.join(out, 'main.bbl'), 'BBL one\n');
fs.writeFileSync(path.join(out, 'main.log'), 'log\n');

const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const keep = (who, name, branch = 'main') => app.inject({
  method: 'POST', url: `/api/projects/${p.id}/output/keep`,
  headers: { 'content-type': 'application/json', ...(who === 'token' ? { authorization: `Bearer ${token}` } : who ? { cookie: people[who].cookie } : {}) },
  payload: JSON.stringify({ branch, name }),
});

try {
  check(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8') === '*.bbl\n*.log\n', 'the project kept its own .gitignore');

  // ---- refusals ----
  eq((await keep('cara', 'main.bbl')).statusCode, 403, 'a viewer may not add files');
  eq((await keep('token', 'main.bbl')).statusCode, 403, 'nor a bearer token');
  eq((await keep(null, 'main.bbl')).statusCode, 401, 'nor someone signed out');
  eq((await keep('bob', 'main.log')).statusCode, 400, 'only the files TeX reads back (not the log)');
  eq((await keep('bob', '../main.bbl')).statusCode, 400, 'no paths');
  eq((await keep('bob', '.main.bbl')).statusCode, 400, 'no dotfiles');
  eq((await keep('bob', 'other.bbl')).statusCode, 404, 'a file the typeset did not make');
  check(!fs.existsSync(path.join(dir, 'main.bbl')), 'nothing written by a refusal');

  // ---- add ----
  const headBefore = git('rev-parse', 'HEAD');
  let res = await keep('bob', 'main.bbl');
  eq(res.statusCode, 200, `a collaborator adds main.bbl (${res.body})`);
  const added = res.json();
  eq({ ok: added.ok, path: added.path, created: added.created, unchanged: added.unchanged, gitignore: added.gitignore }, { ok: true, path: 'main.bbl', created: true, unchanged: false, gitignore: '.gitignore' }, 'the answer');
  check(/^[0-9a-f]{7}$/.test(added.commit), `a commit (${added.commit})`);
  eq(fs.readFileSync(path.join(dir, 'main.bbl'), 'utf8'), 'BBL one\n', 'the file is in the project beside main.tex');
  eq(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*.bbl\n*.log\n!/main.bbl\n', 'the .gitignore negates it');
  eq(git('rev-list', '--count', `${headBefore}..HEAD`), '1', 'one commit');
  eq(git('log', '-1', '--format=%s'), 'Add main.bbl from the last typeset', 'its message');
  eq(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['.gitignore', 'main.bbl'], 'with both files');
  eq(git('log', '-1', '--format=%an'), 'Bob', 'under the person who added it');
  eq(git('ls-files', 'main.bbl'), 'main.bbl', 'tracked');
  eq(git('status', '--porcelain', '--', 'main.bbl', '.gitignore'), '', 'and clean');

  // ---- the same bytes again ----
  res = await keep('bob', 'main.bbl');
  eq(res.json().unchanged, true, 'nothing to update');
  eq(git('log', '-1', '--format=%s'), 'Add main.bbl from the last typeset', 'no new commit');

  // ---- update after a new typeset ----
  fs.writeFileSync(path.join(out, 'main.bbl'), 'BBL two\n');
  const listed = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/output/list`, headers: { cookie: people.cara.cookie } })).json();
  eq(listed.files.find((f) => f.name === 'main.bbl').tracked, 'differs', 'the list (viewers may read it) says the project copy differs');
  res = await keep('ada', 'main.bbl');
  eq(res.statusCode, 200, `the owner updates it (${res.body})`);
  eq({ created: res.json().created, gitignore: res.json().gitignore }, { created: false, gitignore: null }, 'an update; the rule is already negated');
  eq(git('log', '-1', '--format=%s'), 'Update main.bbl from the last typeset', 'its message');
  eq(fs.readFileSync(path.join(dir, 'main.bbl'), 'utf8'), 'BBL two\n', 'the new bytes');
  eq(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*.bbl\n*.log\n!/main.bbl\n', 'the .gitignore is not touched twice');

  // ---- the commit reverts like any other ----
  res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/revert`, headers: { 'content-type': 'application/json', cookie: people.ada.cookie }, payload: JSON.stringify({ branch: 'main', hashes: [git('rev-parse', 'HEAD')], message: 'Undo update main.bbl' }) });
  eq(res.statusCode, 200, `the update reverts (${res.body.slice(0, 200)})`);
  eq(fs.readFileSync(path.join(dir, 'main.bbl'), 'utf8'), 'BBL one\n', 'reverting the update brings back the previous copy');

  console.log('output keep: ALL PASSED');
} finally {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
