/**
 * Galley: V2 (WP42). Edits made by Codex are labelled Codex, not Claude; the
 * commits the server writes for itself carry the product's name.
 *
 * - X-Laytekz-Agent is read against an allowlist, defaulting to Claude;
 * - an MCP write sent as Codex commits under "Codex", lists in the review
 *   answer with `agent: "Codex"`, records the project's last edit as Codex's,
 *   and Revert undoes it (and counts as an agent revert in the log line once
 *   routes.ts uses isAgentAuthor, request R1);
 * - the same write with no header is still Claude's;
 * - new server commits are "Laytekz <laytekz@localhost>" with "laytekz:"
 *   subjects, and a caller's "aldine:" subject is written as "laytekz:";
 *   the autosave check knows both prefixes.
 *
 * Env must be set before any src import (AUTH_ENABLED and the data roots are
 * read at module load).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-agent-label-'));
process.env.AUTH_ENABLED = '1';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.RL_MCP_BURST = '200';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.ALDINE_MCP_TOKEN;
delete process.env.ALDINE_PROTECTED_PROJECTS;
delete process.env.ALDINE_PUBLIC_URL;

const { initDb } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const store = await import('../src/store.ts');
const gitops = await import('../src/gitops.ts');
const activity = await import('../src/activity.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { registerMcp, agentFromHeader } = await import('../src/mcp/server.ts');
const Fastify = (await import('fastify')).default;

// ---- the allowlist ----
eq(agentFromHeader(undefined), 'Claude', 'no header is Claude');
eq(agentFromHeader('codex'), 'Codex', 'codex is Codex');
eq(agentFromHeader(' CODEX '), 'Codex', 'any case, trimmed');
eq(agentFromHeader(['codex', 'claude']), 'Codex', 'the first of repeated headers');
eq(agentFromHeader('claude'), 'Claude', 'claude is Claude');
eq(agentFromHeader('Ada Lovelace'), 'Claude', 'a name off the allowlist is Claude');
eq(agentFromHeader(''), 'Claude', 'an empty header is Claude');
check(gitops.isAgentAuthor('Codex') && gitops.isAgentAuthor('Claude') && !gitops.isAgentAuthor('Ada') && !gitops.isAgentAuthor('Laytekz'), 'isAgentAuthor knows both agents and nobody else');
eq(gitops.currentAgentAuthor(), 'Claude', 'outside a request the agent is Claude');
eq(gitops.runAsAgent('Codex', () => gitops.currentAgentAuthor()), 'Codex', 'inside runAsAgent the agent is the one given');
eq(await gitops.runAsAgent('Codex', async () => { await new Promise((r) => setTimeout(r, 5)); return gitops.currentAgentAuthor(); }), 'Codex', 'the scope survives an await');

// ---- the subject prefix helpers ----
eq(gitops.serverSubject('aldine: autosave'), 'laytekz: autosave', 'an upstream subject is written under the product prefix');
eq(gitops.serverSubject('laytekz: autosave'), 'laytekz: autosave', 'the product prefix is kept');
eq(gitops.serverSubject('Tighten the abstract'), 'Tighten the abstract', 'any other subject is left alone');
eq(gitops.serverSubjectRest('aldine: import assets'), 'import assets', 'the rest after the old prefix');
eq(gitops.serverSubjectRest('laytekz: import assets'), 'import assets', 'the rest after the new prefix');
eq(gitops.serverSubjectRest('Merge a into b'), null, 'no prefix, no rest');
check(gitops.isServerCommitName('Laytekz') && gitops.isServerCommitName('Aldine') && !gitops.isServerCommitName('Ada'), 'both server names are no person');

const app = Fastify();
await registerRoutes(app);
await registerMcp(app);
await app.listen({ port: 0, host: '127.0.0.1' });
const port = app.server.address().port;

const ada = await auth.register('ada@example.com', 'password123', 'Ada');
const { token } = await auth.createAccessToken(ada.id, 'Agent', null, null);

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const connect = async (extra = {}) => {
  const c = new Client({ name: 'laytekz-agent-label-test', version: '0.0.0' });
  await c.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}`, ...extra } } },
  ));
  return c;
};
const callWith = (client) => async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, body: res.isError ? res.content[0].text : JSON.parse(res.content[0].text) };
};
const captureLog = async (fn) => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
};
const gitIn = (id, ...args) => execFileSync('git', args, { cwd: store.repoDir(id), encoding: 'utf8' }).trim();

// ---- an MCP write sent as Codex ----
const p = await store.createProject('Codex paper', { 'main.tex': 'The opening line.\n' }, ada.id);
const codex = callWith(await connect({ 'x-laytekz-agent': 'codex' }));
let { body, isError } = await codex('write_file', { project: p.id, path: 'main.tex', content: 'The opening line, by Codex.\n', message: 'Rewrite the opening' });
check(!isError && body.ok === true, `write_file as Codex succeeds (got ${JSON.stringify(body)})`);
let log = await gitops.log(p.id, 'main', 10);
const codexCommit = log.find((c) => c.message === 'Rewrite the opening');
check(codexCommit && codexCommit.author === 'Codex', `the write commits under Codex (got ${JSON.stringify(log.map((c) => `${c.author}: ${c.message}`))})`);
eq(codexCommit.onBehalfOf, 'Ada', 'History reads whom the Codex commit was made for');
eq(gitIn(p.id, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', codexCommit.hash), 'Codex <codex@laytekz.local>|Laytekz <laytekz@localhost>', 'Codex is the author, the server the committer, under the product domain');

const act = await gitops.agentActivitySince(p.id, 'main', null);
check(act.commitCount === 1 && act.commits[0].agent === 'Codex' && act.commits[0].onBehalfOf === 'Ada', `the review answer names Codex (got ${JSON.stringify(act.commits)})`);
const res = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/agent-activity?branch=main&all=1`, headers: { authorization: `Bearer ${token}` } });
check(res.statusCode === 200 && res.json().commits[0]?.agent === 'Codex', `GET /agent-activity carries agent: Codex (got ${res.statusCode} ${res.body})`);
const last = (await activity.activitySnapshot()).get(p.id)?.lastEdit;
eq(last?.byName, 'Codex', 'the project list says Codex edited it');

// Revert undoes the Codex commit as one commit by the person.
let rres;
const revertLog = await captureLog(async () => {
  rres = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/revert`, headers: { authorization: `Bearer ${token}` }, payload: { branch: 'main', hashes: [codexCommit.hash], message: 'Revert Codex’s edits' } });
});
check(rres.statusCode === 200 && rres.json().ok === true, `Revert of the Codex commit succeeds (got ${rres.statusCode} ${rres.body})`);
eq(store.readFile(p.id, 'main', 'main.tex').toString('utf8'), 'The opening line.\n', 'Revert brought the text back');
const counted = revertLog.some((l) => /\[metric\] agent_revert .* commits=1/.test(l));
console.log(`agent-label: the revert metric ${counted ? 'counts' : 'does not count yet (request R1)'} the Codex commit`);

// ---- the same write with no header is Claude's ----
const p2 = await store.createProject('Claude paper', { 'main.tex': 'Another line.\n' }, ada.id);
const claude = callWith(await connect());
({ body, isError } = await claude('write_file', { project: p2.id, path: 'main.tex', content: 'Another line, by Claude.\n', message: 'Rewrite as Claude' }));
check(!isError && body.ok === true, 'write_file without the header succeeds');
log = await gitops.log(p2.id, 'main', 10);
eq(log.find((c) => c.message === 'Rewrite as Claude')?.author, 'Claude', 'no header commits under Claude');
const unknown = callWith(await connect({ 'x-laytekz-agent': 'mallory' }));
({ body } = await unknown('write_file', { project: p2.id, path: 'main.tex', content: 'Another line, by someone.\n', message: 'Rewrite as an unknown agent' }));
eq((await gitops.log(p2.id, 'main', 10)).find((c) => c.message === 'Rewrite as an unknown agent')?.author, 'Claude', 'a header off the allowlist commits under Claude');

// ---- the server's own commits carry the product's name ----
const p3 = await store.createProject('Identity paper', { 'main.tex': 'Start.\n' }, ada.id);
fs.writeFileSync(path.join(store.branchDir(p3.id, 'main'), 'main.tex'), 'Start, typed.\n');
await gitops.autosave(p3.id, 'main');
eq(gitIn(p3.id, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s'), 'Laytekz <laytekz@localhost>|Laytekz <laytekz@localhost>|laytekz: autosave', 'an autosave is by Laytekz, under laytekz:');
fs.writeFileSync(path.join(store.branchDir(p3.id, 'main'), 'main.tex'), 'Start, typed again.\n');
await gitops.autoCommit(p3.id, 'main', 'aldine: autosave on shutdown');
eq(gitIn(p3.id, 'log', '-1', '--format=%an|%s'), 'Laytekz|laytekz: autosave on shutdown', 'a caller’s aldine: subject is written as laytekz:');
fs.writeFileSync(path.join(store.branchDir(p3.id, 'main'), 'main.tex'), 'Start, checkpointed.\n');
await gitops.checkpoint(p3.id, 'main', 'Submitted draft', { name: 'Ada', email: 'ada@example.com' });
eq(gitIn(p3.id, 'log', '-1', '--format=%an <%ae>|%cn|%s'), 'Ada <ada@example.com>|Laytekz|Submitted draft', 'a person’s checkpoint is theirs, committed by Laytekz');
fs.writeFileSync(path.join(store.branchDir(p3.id, 'main'), 'main.tex'), 'Start, by name only.\n');
await gitops.commitAll(p3.id, 'main', 'A named change', 'Grace Hopper');
eq(gitIn(p3.id, 'log', '-1', '--format=%an <%ae>'), 'Grace Hopper <grace.hopper@laytekz.local>', 'a name without an email gets the product domain');
// The diff baseline skips autosaves under either prefix.
fs.writeFileSync(path.join(store.branchDir(p3.id, 'main'), 'main.tex'), 'Start, old prefix.\n');
await gitops.commitAll(p3.id, 'main', 'laytekz: autosave');
const named = gitIn(p3.id, 'log', '-1', '--format=%H', '--grep=^A named change$');
eq(await gitops.diffBaselineCommit(p3.id, 'main', false), named, 'a laytekz: autosave is never the diff baseline');

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('agent-label: ok');
process.exit(0);
