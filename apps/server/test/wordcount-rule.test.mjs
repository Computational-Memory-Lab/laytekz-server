/**
 * The word-count rule (WP24): GET /api/projects/:id/wordcount/breakdown
 * resolves the rule from the project setting `wordcount.rule`, then the
 * asking account's preference of the same name, then the built-in "Main
 * text" rule; the cached count misses when the rule changes; members set the
 * project rule, viewers only read; invalid rules are refused. Plus the
 * validator's refusals and the MCP summary's `total === Σ files`.
 *
 * Accounts on; env is set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-wordcount-rule-')));
const ORIGIN = 'https://laytekz.test';
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_PUBLIC_URL = ORIGIN;
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
for (const k of ['ALDINE_BASE_PATH', 'DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_MCP', 'ALDINE_OAUTH_REGISTRATION', 'ALDINE_TEST_HOOKS']) delete process.env[k];
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const { buildApp } = await import('../src/app.ts');
const { ruleProblem } = await import('../src/wordcount/validate.ts');
const { mcpWordCount, documentWordCount } = await import('../src/wordcount/count.ts');
const app = await buildApp();

const people = {};
for (const who of ['ada', 'bob', 'cara']) {
  const u = await auth.register(`${who}@example.com`, 'password123', who[0].toUpperCase() + who.slice(1));
  await db().setEmailPending(u.id, null);
  people[who] = { user: u, cookie: `aldine_session=${await auth.createSession(u.id)}` };
}
const MAIN = [
  '\\documentclass{apa7}',
  '\\abstract{Three abstract words.}',
  '\\begin{document}',
  '\\section{Introduction}',
  'Main text has five words \\cite{lone}.',
  '\\section{Supplementary Materials}',
  'Two more.',
  '\\end{document}',
  '',
].join('\n');
const meta = await store.createProject('Count', { 'main.tex': MAIN, 'refs.bib': '@article{lone, author = {Solo, Han}, title = {T}, year = {2020}}\n', 'other.tex': '\\documentclass{article}\n\\begin{document}\nSeparate document words.\n\\end{document}\n', 'orphan.tex': 'Never reached.\n' }, people.ada.user.id);
meta.share = { mode: 'private', collaborators: ['bob@example.com', 'cara@example.com'], viewers: ['cara@example.com'] };
meta.rootFile = 'main.tex';
await store.writeMeta(meta);

const send = (method, url, who, payload) => app.inject({
  method, url,
  headers: { cookie: people[who].cookie, origin: ORIGIN, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
});
const breakdown = async (who) => {
  const r = await send('GET', `/api/projects/${meta.id}/wordcount/breakdown`, who);
  eq(r.statusCode, 200, `breakdown for ${who}`);
  return r.json();
};

// ---- the built-in rule ----
let b = await breakdown('ada');
eq(b.ruleSource, 'default', 'no project or account rule: the default');
eq(b.ruleName, 'Main text', 'rule name');
eq(b.total, 1 + 5 + 2, 'main text only: heading, five words, the one-author citation estimate');
eq(b.parts.abstract, 3, 'the abstract is counted apart');
eq(b.parts.supplementary, 2 + 2, 'the supplement is counted apart');
eq(b.citeWords, { lone: 2 }, 'citation estimate from the .bib');
eq(b.otherDocuments, [{ file: 'other.tex', total: 3 }], 'another document with its own \\documentclass');
eq(b.unreachable, ['orphan.tex'], 'a .tex file the root never reaches');
eq(b.total, Object.values(b.files).reduce((x, y) => x + y, 0), 'total === sum of files');
eq((await send('GET', `/api/projects/${meta.id}/wordcount/breakdown`, 'cara')).statusCode, 200, 'a viewer may read the breakdown');
eq((await send('GET', `/api/projects/${meta.id}/wordcount/breakdown?branch=../x`, 'ada')).statusCode, 400, 'a bad branch name is refused');

// ---- the account default ----
eq((await send('PATCH', '/api/account/preferences', 'ada', { set: { 'wordcount.rule': { preset: 'main-abstract' } } })).statusCode, 200, 'account default saved');
b = await breakdown('ada');
eq(b.ruleSource, 'account', 'the account default applies to its owner');
eq(b.total, 8 + 3, 'main text and abstract');
eq((await breakdown('bob')).ruleSource, 'default', 'another account still gets the default');

// ---- the project rule, set by a member ----
eq((await send('PATCH', `/api/projects/${meta.id}/settings`, 'bob', { set: { 'wordcount.rule': { preset: 'custom', parts: ['main', 'supplementary'], kinds: ['text', 'headings'] } } })).statusCode, 200, 'a collaborator sets the project rule');
b = await breakdown('ada');
eq(b.ruleSource, 'project', 'the project rule beats the account default');
eq(b.total, 6 + 4, 'custom: main and supplementary text and headings, no citations');
eq((await breakdown('bob')).total, 10, 'every member sees the project rule');
eq((await send('PATCH', `/api/projects/${meta.id}/settings`, 'cara', { set: { 'wordcount.rule': { preset: 'everything' } } })).statusCode, 403, 'a viewer cannot change the rule');
eq((await send('PATCH', `/api/projects/${meta.id}/settings`, 'bob', { set: { 'wordcount.rule': { preset: 'nonsense' } } })).statusCode, 400, 'an invalid rule is refused');
eq((await send('PATCH', `/api/projects/${meta.id}/settings`, 'bob', { unset: ['wordcount.rule'] })).statusCode, 200, 'the project rule removed');
eq((await breakdown('ada')).ruleSource, 'account', 'back to the account default');

// ---- the MCP summary ----
const full = await documentWordCount(meta.id, 'main', null);
const mcp = mcpWordCount(full);
eq(mcp.total, Object.values(mcp.files).reduce((x, y) => x + y, 0), 'MCP: total === sum of files');
eq(mcp.rule.source, 'default', 'MCP: the rule and its source');
check(mcp.parts.supplementary && mcp.parts.supplementary.counted === false, 'MCP: parts say whether they count');

// ---- validation ----
eq(ruleProblem({}), null, 'an empty rule is valid (all defaults)');
eq(ruleProblem({ preset: 'custom', parts: ['main'], kinds: ['text'], target: 4000, abstractLimit: null, sections: { methods: 'excluded' } }), null, 'a full custom rule');
check(ruleProblem({ parts: ['main', 'main'] }), 'a part listed twice');
check(ruleProblem({ kinds: ['prose'] }), 'an unknown kind');
check(ruleProblem({ target: 0 }), 'a target below 1');
check(ruleProblem({ target: 1_000_001 }), 'a target above 1,000,000');
check(ruleProblem({ patterns: { supplementaryHeadings: Array(51).fill('x') } }), 'more than 50 patterns');
check(ruleProblem({ patterns: { supplementaryHeadings: ['x'.repeat(101)] } }), 'a pattern over 100 characters');
check(ruleProblem({ patterns: { other: [] } }), 'an unknown pattern list');
check(ruleProblem({ sections: { a: 'nowhere' } }), 'a section counted as an unknown part');
check(ruleProblem({ extra: 1 }), 'an unknown field');
check(ruleProblem('main'), 'not an object');

console.log('wordcount-rule: all checks passed');
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
