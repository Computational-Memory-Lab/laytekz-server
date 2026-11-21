/**
 * The app server's side of the compiler hardening (Galley):
 * - with COMPILER_TOKEN set, every call to the compile service carries it in
 *   x-compiler-token: typeset, stop, SyncTeX, format, /health, the venue
 *   catalog and template previews;
 * - a compiler that refuses the token is a 503 with a sentence that names the
 *   setting, never the token;
 * - a stored main document whose name a shell could read as a command is not
 *   typeset: the answer says what to rename, and the compiler is not asked;
 * - with COMPILE_DEADLINE_MS, a typeset answers within the deadline: the
 *   compiler gets the time left as timeoutMs, a compiler that does not answer
 *   in time is told to stop and the typeset reports timedOut, and a typeset
 *   whose time went on waiting behind the branch's earlier ones is not sent.
 *
 * Real routes on a throwaway datastore, auth off; the compiler is a mock
 * that records what it receives.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { check, eq } from './assert.mjs';

const TOKEN = 'tok_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-compiler-token-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.ALDINE_AUTOCOMMIT_MS = '600000';
process.env.ALDINE_TEMPLATE_PREVIEWS = '0';
process.env.TEMPLATE_PREVIEW_WAIT_MS = '200';
process.env.COMPILER_TOKEN = TOKEN;
for (const k of ['AUTH_ENABLED', 'DATABASE_URL', 'REDIS_URL', 'ALDINE_PROTECTED_PROJECTS', 'ALDINE_MCP_TOKEN', 'COMPILE_DEADLINE_MS']) delete process.env[k];

const seen = [];
let mode = 'ok';
const held = [];
const send = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length });
  res.end(buf);
};
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ url: req.url, method: req.method, token: req.headers['x-compiler-token'], body });
    if (mode === 'refuse' && req.url !== '/health') return send(res, 401, { ok: false, error: 'missing or wrong compiler token (x-compiler-token header)' });
    if (req.url === '/health') return send(res, 200, { ok: true, texlive: { release: '2026', scheme: 'full' }, thumbnails: 'none' });
    if (req.url.startsWith('/catalog')) return send(res, 200, { ok: true, classes: [] });
    if (req.url === '/format') return send(res, 200, { ok: true, text: body.text });
    if (req.url === '/synctex') return send(res, 200, { ok: true, records: [] });
    if (req.url === '/stop') {
      for (const h of held.splice(0)) send(h, 200, { ok: false, stopped: true, log: '', errors: [], durationMs: 1 });
      return send(res, 200, { ok: true, stopped: 1 });
    }
    if (req.url === '/compile' && mode === 'hold') { held.push(res); return; }
    if (req.url === '/compile' && mode === 'timeout') return send(res, 200, { ok: false, timedOut: true, exitCode: -1, pdf: null, log: '', durationMs: 2000, errors: [{ type: 'error', line: null, message: 'Typesetting was stopped after 2 s, the time limit for one typeset on this server.' }] });
    return send(res, 200, { ok: true, pdf: '.aldine-out/main.pdf', pdfFresh: true, synctex: null, log: 'ok', errors: [], durationMs: 3 });
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
process.env.COMPILER_URL = `http://127.0.0.1:${mock.address().port}`;

const { default: Fastify } = await import('fastify');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const { registerRoutes } = await import('../src/routes.ts');
const store = await import('../src/store.ts');
const { compileProject, stopTypeset, synctexLookup, formatText, compilerInfo, CompilerUnavailableError, CompilerAuthError } = await import('../src/compile.ts');
const { venueClasses } = await import('../src/catalog.ts');
const { typesetPage1 } = await import('../src/templatepreviews.ts');

const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();

const doc = '\\documentclass{article}\\begin{document}Hi\\end{document}\n';
const p = await store.createProject('Token', { 'main.tex': doc });
const projectDir = path.relative(process.env.DATA_DIR, store.branchDir(p.id, 'main'));
const warnings = [];
const warn = console.warn;
console.warn = (...args) => { warnings.push(args.join(' ')); };

try {
  // ---- the token on every call
  eq((await compileProject(p.id, 'main')).ok, true, 'a typeset runs');
  await stopTypeset(p.id, 'main');
  await synctexLookup(p.id, 'main', { direction: 'forward', file: 'main.tex', line: 1, column: 0 });
  eq((await formatText('\\begin{itemize}\n\\item a\n\\end{itemize}\n', '\t', 'tex')).ok, true, 'format runs');
  eq((await compilerInfo()).ok, true, 'the compiler answers /health');
  await venueClasses();
  await typesetPage1({ 'main.tex': Buffer.from(doc) }, 'a template');
  const routes = new Set(seen.map((s) => s.url.split('?')[0]));
  for (const r of ['/compile', '/stop', '/synctex', '/format', '/health', '/catalog']) check(routes.has(r), `the app called ${r}`);
  for (const s of seen) eq(s.token, TOKEN, `${s.method} ${s.url} carries the token`);
  const firstCompile = seen.find((s) => s.url === '/compile');
  check(!('timeoutMs' in firstCompile.body), 'without COMPILE_DEADLINE_MS no budget is sent');

  // ---- a compiler that refuses the token
  mode = 'refuse';
  let thrown = null;
  try { await compileProject(p.id, 'main'); } catch (err) { thrown = err; }
  check(thrown instanceof CompilerAuthError && thrown instanceof CompilerUnavailableError, `a refused token is the compiler being unavailable (got ${thrown})`);
  const refused = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/compile`, payload: { branch: 'main' } });
  eq(refused.statusCode, 503, 'the compile route answers 503');
  check(/COMPILER_TOKEN/.test(refused.json().error) && !refused.body.includes(TOKEN), `naming the setting, not the value (got ${refused.json().error})`);
  check(warnings.some((w) => /refused the request \(HTTP 401\)/.test(w)) && !warnings.some((w) => w.includes(TOKEN)), 'the log says the token was refused, without it');
  const fmt = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/format`, payload: { path: 'main.tex', text: 'x\n', indent: '\t' } });
  eq(fmt.statusCode, 503, 'format answers 503 too');
  mode = 'ok';

  // ---- a main document whose name a shell would run
  const evil = await store.createProject('Evil', { 'p`cd .aldine-out;touch PWNED`.tex': doc });
  eq(evil.rootFile, 'p`cd .aldine-out;touch PWNED`.tex', 'a project made from such a file has it as its main document');
  const before = seen.length;
  thrown = null;
  try { await compileProject(evil.id, 'main'); } catch (err) { thrown = err; }
  check(thrown && /^Can’t typeset “p`cd \.aldine-out;touch PWNED`\.tex”\. Main document name cannot contain a backtick \(`\): rename the file/.test(thrown.message), `the typeset is refused with what to rename (got ${thrown?.message})`);
  const viaRoute = await app.inject({ method: 'POST', url: `/api/projects/${evil.id}/compile`, payload: { branch: 'main' } });
  eq(viaRoute.statusCode, 400, 'the compile route answers 400');
  check(/rename the file/.test(viaRoute.json().error), 'with the same sentence');
  eq(seen.slice(before).filter((s) => s.url === '/compile').length, 0, 'the compiler was never asked');
  const patch = await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { rootFile: 'a$(id).tex' } });
  eq(patch.statusCode, 400, 'such a name cannot be chosen as the main document');
  check(/cannot contain “\$”/.test(patch.json().error), `and the refusal names the character (got ${patch.json().error})`);
  eq((await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { rootFile: 'Thèse (v2).tex' } })).statusCode, 200, 'an ordinary name with accents, spaces and parentheses is accepted');
  await app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: { rootFile: 'main.tex' } });
  const preview = await typesetPage1({ 'a`id`.tex': Buffer.from(doc) }, 'a template');
  check('error' in preview && /cannot be typeset/.test(preview.error), `a template whose root has such a name is not sent (got ${JSON.stringify(preview)})`);

  // ---- the deadline
  process.env.COMPILE_DEADLINE_MS = '3600';
  seen.length = 0;
  eq((await compileProject(p.id, 'main')).ok, true, 'a quick typeset under a deadline');
  const budget = seen.find((s) => s.url === '/compile').body.timeoutMs;
  check(typeof budget === 'number' && budget > 0 && budget <= 3600, `the compiler gets the time left (timeoutMs ${budget})`);

  mode = 'timeout';
  const reworded = await compileProject(p.id, 'main');
  eq(reworded.timedOut, true, 'a typeset the compiler stopped for time reports timedOut');
  check(/^Typesetting was stopped: this server answers a typeset within 4 s\./.test(reworded.errors[0]?.message || ''), `in the deadline's words, not the compiler's budget (${JSON.stringify(reworded.errors[0])})`);

  mode = 'hold';
  seen.length = 0;
  const t0 = Date.now();
  const first = compileProject(p.id, 'main');
  const second = compileProject(p.id, 'main');
  const late = await first;
  const took = Date.now() - t0;
  check(took < 3600 + 4000, `a typeset the compiler does not answer ends near the deadline (took ${took} ms)`);
  eq(late.timedOut, true, 'it reports timedOut');
  eq(late.ok, false, 'and no success');
  check(/^Typesetting was stopped: this server answers a typeset within 4 s/.test(late.errors[0]?.message || ''), `its first error row names the limit (${JSON.stringify(late.errors[0])})`);
  // The stop is sent without waiting for its answer.
  for (const end = Date.now() + 3000; !seen.some((s) => s.url === '/stop') && Date.now() < end;) await new Promise((r) => setTimeout(r, 20));
  const stopSent = seen.find((s) => s.url === '/stop');
  check(stopSent && stopSent.body.projectDir === projectDir && stopSent.token === TOKEN, 'the compiler is told to stop that directory');
  const waited = await second;
  eq(waited.timedOut, true, 'the typeset queued behind it times out too');
  check(/waited \d+ s for this branch’s earlier typesets and was not started/.test(waited.errors[0]?.message || ''), `saying it never started (${JSON.stringify(waited.errors[0])})`);
  eq(seen.filter((s) => s.url === '/compile').length, 1, 'and it was never sent to the compiler');
  const viaRouteLate = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/compile`, payload: { branch: 'main' } });
  eq(viaRouteLate.statusCode, 200, 'through the route a timed-out typeset is an answer, not a gateway error');
  eq(viaRouteLate.json().timedOut, true, 'that says it timed out');
  mode = 'ok';
  delete process.env.COMPILE_DEADLINE_MS;
  console.log('compiler-token-app: ok');
} finally {
  console.warn = warn;
  await app.close();
  mock.closeAllConnections?.();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
