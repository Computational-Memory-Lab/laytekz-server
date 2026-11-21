/**
 * The compile service with COMPILER_TOKEN (Galley):
 * - it refuses to start on a loopback HOST without a token, unless told to
 *   with COMPILER_ALLOW_UNAUTHENTICATED=1;
 * - with a token, GET /health answers anyone and every other route answers
 *   401 without the right x-compiler-token header, before reading the body;
 * - the token reaches no tool it starts and none of its output;
 * - bodies over 64 KB get 413, a root file name with a backtick is refused
 *   before latexmk runs, a project directory beside DATA_DIR is refused;
 * - `timeoutMs` bounds a whole typeset, a wait for a slot included, and a
 *   timed-out typeset says so in its first error row.
 *
 * The real compiler script, with a latexmk on PATH that writes a PDF, or
 * waits when its project is called "slow".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, eq } from './assert.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const compilerJs = path.resolve(here, '../../compiler/server.js');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-compiler-auth-')));
const dataDir = path.join(tmp, 'data');
const runs = path.join(tmp, 'runs');
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'latexmk'), `#!/bin/sh
if env | grep -q '^COMPILER_TOKEN='; then echo leaked >> "$ALDINE_TEST_RUNS"; else echo clean >> "$ALDINE_TEST_RUNS"; fi
case "$PWD" in */slow) exec sleep 60 ;; esac
for a in "$@"; do root="$a"; done
dir=$(dirname "$root"); base=$(basename "$root" .tex)
mkdir -p "$dir/.aldine-out"
echo '%PDF-1.5' > "$dir/.aldine-out/$base.pdf"
echo 'Output written on x.pdf (1 page, 9 bytes).' > "$dir/.aldine-out/$base.log"
`, { mode: 0o755 });

const doc = '\\documentclass{article}\\begin{document}x\\end{document}\n';
for (const [dir, file] of [['data/projects/a', 'main.tex'], ['data/projects/slow', 'main.tex'], ['data/projects/a', 'a`touch PWNED`.tex'], ['data2/projects/a', 'main.tex']]) {
  fs.mkdirSync(path.join(tmp, dir), { recursive: true });
  fs.writeFileSync(path.join(tmp, dir, file), doc);
}
const runCount = () => { try { return fs.readFileSync(runs, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

const TOKEN = 'tok_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/** Starts the compiler; resolves once it listens, or with its exit code. */
async function start(extraEnv) {
  const port = await freePort();
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PORT: String(port), DATA_DIR: dataDir, ALDINE_PREAMBLE_CACHE: '0', ALDINE_THUMBNAILS: '0', ALDINE_TEST_RUNS: runs, MAX_CONCURRENT_COMPILES: '1', ...extraEnv };
  for (const k of ['HOST', 'COMPILER_TOKEN', 'COMPILER_ALLOW_UNAUTHENTICATED']) if (!(k in extraEnv)) delete env[k];
  const child = spawn(process.execPath, [compilerJs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  let timer;
  const outcome = await new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (output.includes('listening')) resolve('listening'); });
    child.on('exit', (code) => resolve(`exit ${code}`));
    timer = setTimeout(() => reject(new Error('compiler neither started nor exited')), 30_000);
  }).finally(() => clearTimeout(timer));
  return { child, port, outcome, output: () => output };
}

// ---- refuses to start open on loopback
const open = await start({ HOST: '127.0.0.1' });
eq(open.outcome, 'exit 78', 'a loopback HOST without COMPILER_TOKEN does not start');
check(/not starting: .*COMPILER_TOKEN/.test(open.output()), `it says why (${open.output().trim()})`);

const optOut = await start({ HOST: '127.0.0.1', COMPILER_ALLOW_UNAUTHENTICATED: '1' });
eq(optOut.outcome, 'listening', 'COMPILER_ALLOW_UNAUTHENTICATED=1 starts it anyway');
check(optOut.output().includes('auth=none'), 'and its startup line says there is no token');
optOut.child.kill('SIGKILL');

const short = await start({ HOST: '127.0.0.1', COMPILER_TOKEN: 'too-short' });
eq(short.outcome, 'exit 78', 'a short token does not start');
check(!short.output().includes('too-short'), 'the refusal does not print the token');

// ---- with a token
const svc = await start({ HOST: '127.0.0.1', COMPILER_TOKEN: TOKEN });
eq(svc.outcome, 'listening', 'loopback with a token starts');
check(svc.output().includes('auth=token'), 'its startup line says a token is required');
const base = `http://127.0.0.1:${svc.port}`;
const call = async (method, route, { body, token, raw } = {}) => {
  const headers = { 'content-type': 'application/json', ...(token !== undefined ? { 'x-compiler-token': token } : {}) };
  const res = await fetch(`${base}${route}`, { method, headers, ...(method === 'POST' ? { body: raw ?? JSON.stringify(body ?? {}) } : {}) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
};

try {
  eq((await call('GET', '/health')).status, 200, 'GET /health needs no token');
  const compileBody = { projectDir: 'projects/a', rootFile: 'main.tex' };
  for (const [method, route] of [['POST', '/compile'], ['POST', '/stop'], ['POST', '/synctex'], ['POST', '/format'], ['GET', '/catalog'], ['GET', '/health?x=1'], ['GET', '/nowhere']]) {
    const none = await call(method, route, { body: compileBody });
    eq(none.status, 401, `${method} ${route} without the token is refused`);
    check(!none.text.includes(TOKEN), 'the refusal does not carry the token');
    eq((await call(method, route, { body: compileBody, token: TOKEN.slice(0, -1) + 'x' })).status, 401, `${method} ${route} with a wrong token is refused`);
    eq((await call(method, route, { body: compileBody, token: '' })).status, 401, `${method} ${route} with an empty token is refused`);
  }
  eq(runCount().length, 0, 'no refused request ran latexmk');

  const good = await call('POST', '/compile', { body: compileBody, token: TOKEN });
  eq(good.status, 200, 'with the token a typeset runs');
  eq(good.json.ok, true, 'and succeeds');
  eq(runCount(), ['clean'], 'latexmk ran once, without COMPILER_TOKEN in its environment');
  eq((await call('GET', '/catalog', { token: TOKEN })).status, 200, 'GET /catalog with the token answers');
  eq((await call('POST', '/stop', { body: { projectDir: 'projects/a' }, token: TOKEN })).json, { ok: true, stopped: 0 }, 'POST /stop with the token answers');

  // ---- request bodies
  const big = await call('POST', '/compile', { raw: JSON.stringify({ ...compileBody, pad: 'x'.repeat(100 * 1024) }), token: TOKEN });
  eq(big.status, 413, 'a body over 64 KB is refused');
  eq(runCount().length, 1, 'and ran nothing');
  eq((await call('POST', '/compile', { raw: 'null', token: TOKEN })).status, 400, 'a body that is not an object is refused');

  // ---- root file names and project directories
  const evil = await call('POST', '/compile', { body: { projectDir: 'projects/a', rootFile: 'a`touch PWNED`.tex' }, token: TOKEN });
  eq(evil.status, 400, 'a root file name with a backtick is refused');
  check(/invalid rootFile: .*backtick/.test(evil.json.error), `it says why (${evil.json.error})`);
  eq(runCount().length, 1, 'latexmk never saw it');
  check(!fs.existsSync(path.join(dataDir, 'projects/a/PWNED')) && !fs.existsSync(path.join(dataDir, 'projects/a/.aldine-out/PWNED')), 'nothing ran');
  const sibling = await call('POST', '/compile', { body: { projectDir: path.join(tmp, 'data2/projects/a'), rootFile: 'main.tex' }, token: TOKEN });
  eq(sibling.status, 400, 'a directory beside DATA_DIR that shares its prefix is refused');
  check(sibling.json.error.includes('escapes DATA_DIR'), `it says why (${sibling.json.error})`);
  eq((await call('POST', '/compile', { body: { projectDir: '.', rootFile: 'main.tex' }, token: TOKEN })).status, 400, 'DATA_DIR itself is refused');
  eq((await call('POST', '/synctex', { body: { projectDir: 'projects/a', direction: 'forward', line: '1;id', column: 0 }, token: TOKEN })).status, 400, 'a SyncTeX line that is not a number is refused');
  eq((await call('POST', '/synctex', { body: { projectDir: 'projects/a', direction: 'inverse', page: 1, x: 'a', y: 2 }, token: TOKEN })).status, 400, 'a SyncTeX position that is not a number is refused');
  eq((await call('POST', '/compile', { body: { ...compileBody, timeoutMs: -5 }, token: TOKEN })).status, 400, 'a negative timeoutMs is refused');

  // ---- the time budget of one request
  let t0 = Date.now();
  const slow = await call('POST', '/compile', { body: { projectDir: 'projects/slow', rootFile: 'main.tex', timeoutMs: 1500 }, token: TOKEN });
  const took = Date.now() - t0;
  check(took < 6000, `a typeset with timeoutMs 1500 answers in time (took ${took} ms)`);
  eq(slow.json.timedOut, true, 'it reports timedOut');
  eq(slow.json.ok, false, 'and is no success');
  check(/^Typesetting was stopped after 2 s/.test(slow.json.errors[0]?.message || ''), `its first error row names the limit (${JSON.stringify(slow.json.errors[0])})`);

  // One slot: a typeset without a budget holds it, the next waits and runs out of time in the queue.
  const holder = call('POST', '/compile', { body: { projectDir: 'projects/slow', rootFile: 'main.tex' }, token: TOKEN });
  const until = Date.now() + 5000;
  while (runCount().length < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  t0 = Date.now();
  const queued = await call('POST', '/compile', { body: { ...compileBody, timeoutMs: 1000 }, token: TOKEN });
  check(Date.now() - t0 < 4000, 'a typeset whose budget ends while it waits for a slot answers in time');
  eq(queued.json.timedOut, true, 'it reports timedOut');
  eq(queued.json.durationMs, 0, 'it never ran');
  check(/stopped after 1 s/.test(queued.json.errors[0]?.message || ''), `and says so (${JSON.stringify(queued.json.errors[0])})`);
  eq(runCount().length, 3, 'latexmk did not run for it');
  eq((await call('POST', '/stop', { body: { projectDir: 'projects/slow' }, token: TOKEN })).json.stopped, 1, 'the holder is stopped');
  eq((await holder).json.stopped, true, 'and answers stopped');

  check(!runCount().includes('leaked'), 'no latexmk run ever saw COMPILER_TOKEN');
  check(!svc.output().includes(TOKEN), 'the token never appeared in the compiler\'s output');
} finally {
  svc.child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('compiler-auth: ok');
