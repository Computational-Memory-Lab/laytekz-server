/**
 * The compile service's access and input checks (apps/compiler/guard.js),
 * without a running service:
 * - the token check accepts exactly the configured value, and anything when
 *   none is configured;
 * - the startup rule refuses a loopback or all-interfaces HOST without a
 *   token, keeps upstream's container layout (HOST unset) working, and
 *   honours the explicit opt-out;
 * - a project directory must lie strictly inside DATA_DIR: a sibling that
 *   shares its prefix, or DATA_DIR itself, is refused;
 * - request bodies and captured output are bounded.
 */
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { check, eq, throws } from './assert.mjs';

const guard = createRequire(import.meta.url)('../../compiler/guard.js');
const { authorized, tokenDigest, startupProblem, loopbackOrWildcard, projectRootIn, insideDir, readBody, OutputBuffer } = guard;

// ---- the token
const token = 'x'.repeat(20) + 'A1b2C3d4E5f6G7h8I9j0';
const expected = tokenDigest(token);
check(authorized(token, expected), 'the configured token passes');
check(!authorized(token + 'x', expected), 'a longer value fails');
check(!authorized(token.slice(0, -1), expected), 'a shorter value fails');
check(!authorized(token.slice(0, -1) + 'Z', expected), 'one character off fails');
check(!authorized('', expected), 'an empty header fails');
check(!authorized(undefined, expected), 'a missing header fails');
check(!authorized([token, token], expected), 'a repeated header (an array) fails');
check(authorized(undefined, null), 'without a configured token every request passes (upstream behaviour)');
eq(tokenDigest(''), null, 'an empty COMPILER_TOKEN counts as none');
eq(tokenDigest(undefined), null, 'an unset COMPILER_TOKEN counts as none');
eq(guard.TOKEN_HEADER, 'x-compiler-token', 'the header name the app sends');

// ---- which HOST values reach every local account
for (const h of ['127.0.0.1', '127.0.1.1', '0.0.0.0', '::', '::1', '[::1]', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', '::ffff:127.0.0.1', '::ffff:0.0.0.0', 'localhost', 'LocalHost', 'app.localhost']) {
  check(loopbackOrWildcard(h), `${h} is loopback or every interface`);
}
for (const h of ['10.0.0.5', '192.168.1.20', '172.18.0.2', '::ffff:10.0.0.1', 'fe80::1', '2001:db8::7', 'compiler', 'myhost']) {
  check(!loopbackOrWildcard(h), `${h} is a specific interface or a name`);
}

// ---- the startup rule
const ok = (env, msg) => eq(startupProblem(env), null, msg);
const refuses = (env, part, msg) => { const p = startupProblem(env); check(typeof p === 'string' && p.includes(part), `${msg} (got ${p})`); };
ok({}, 'upstream compose: no HOST, no token');
ok({ HOST: '' }, 'an empty HOST is unset');
refuses({ HOST: '127.0.0.1' }, 'COMPILER_TOKEN is not set', 'loopback without a token');
refuses({ HOST: '0.0.0.0' }, 'COMPILER_TOKEN is not set', 'every interface without a token');
refuses({ HOST: '::' }, 'COMPILER_TOKEN is not set', 'every IPv6 interface without a token');
refuses({ HOST: 'localhost', COMPILER_TOKEN: '' }, 'COMPILER_TOKEN is not set', 'an empty token is no token');
ok({ HOST: '127.0.0.1', COMPILER_ALLOW_UNAUTHENTICATED: '1' }, 'the explicit opt-out');
refuses({ HOST: '127.0.0.1', COMPILER_ALLOW_UNAUTHENTICATED: 'yes' }, 'COMPILER_TOKEN is not set', 'only "1" opts out');
ok({ HOST: '172.18.0.2' }, 'a specific interface address is the operator\'s isolated network');
ok({ HOST: '127.0.0.1', COMPILER_TOKEN: token }, 'loopback with a token');
refuses({ HOST: '127.0.0.1', COMPILER_TOKEN: 'short' }, 'at least 32', 'a short token');
refuses({ COMPILER_TOKEN: 'short' }, 'at least 32', 'a short token is refused wherever it is set');
refuses({ HOST: '127.0.0.1', COMPILER_TOKEN: `${token} ${token}` }, 'visible ASCII', 'a token with a space');
refuses({ HOST: '127.0.0.1', COMPILER_TOKEN: `${token}é` }, 'visible ASCII', 'a token outside ASCII');
check(!startupProblem({ HOST: '127.0.0.1' }).includes(token), 'the refusal never carries a token');
check(!(startupProblem({ HOST: '127.0.0.1', COMPILER_TOKEN: 'short-secret' }) || '').includes('short-secret'), 'nor a refused token');

// ---- project directories strictly inside DATA_DIR
const data = path.resolve('/srv/galley/data');
eq(projectRootIn(data, 'projects/abcd'), path.join(data, 'projects/abcd'), 'a project directory');
eq(projectRootIn(`${data}/`, 'worktrees/abcd/feature__x'), path.join(data, 'worktrees/abcd/feature__x'), 'a trailing slash on DATA_DIR changes nothing');
await throws(() => projectRootIn(data, '../data2/projects/abcd'), 'invalid projectDir', '".." is refused');
await throws(() => projectRootIn(data, '/srv/galley/data2/projects/abcd'), 'escapes DATA_DIR', 'a sibling sharing the prefix is refused');
await throws(() => projectRootIn(data, '/srv/galley/data-old'), 'escapes DATA_DIR', 'a sibling directory itself is refused');
await throws(() => projectRootIn(data, '.'), 'escapes DATA_DIR', 'DATA_DIR itself is no project');
await throws(() => projectRootIn(data, data), 'escapes DATA_DIR', 'DATA_DIR by absolute path is no project');
await throws(() => projectRootIn(data, '/etc'), 'escapes DATA_DIR', 'an absolute path elsewhere');
await throws(() => projectRootIn(data, ''), 'invalid projectDir', 'an empty projectDir');
await throws(() => projectRootIn(data, 42), 'invalid projectDir', 'a non-string projectDir');
await throws(() => projectRootIn(data, 'projects/a\0b'), 'invalid projectDir', 'a NUL in projectDir');
check(insideDir('/a/b', '/a/b/c'), 'a child is inside');
check(!insideDir('/a/b', '/a/bc'), 'a prefix sibling is not');
check(!insideDir('/a/b', '/a/b'), 'the directory itself is not');

// ---- bounded request bodies
const fakeReq = (chunks) => {
  const req = new EventEmitter();
  setImmediate(() => { for (const c of chunks) req.emit('data', Buffer.from(c)); req.emit('end'); });
  return req;
};
eq(await readBody(fakeReq(['{"a":', '1}']), 64), { over: false, text: '{"a":1}' }, 'a body under the limit is read whole');
eq(await readBody(fakeReq(['x'.repeat(40), 'y'.repeat(40)]), 64), { over: true, text: '' }, 'a body over the limit is dropped and flagged');
eq(await readBody(fakeReq(['x'.repeat(64)]), 64), { over: false, text: 'x'.repeat(64) }, 'exactly the limit is still read');

// ---- bounded captured output
const buf = new OutputBuffer(10, 20);
buf.push('HEAD-0123456789');
for (let i = 0; i < 1000; i++) buf.push(`line ${i}\n`);
buf.push('THE END');
const text = buf.toString();
check(text.startsWith('HEAD-01234'), 'the head is kept');
check(text.endsWith('THE END'), 'the tail is kept');
check(text.includes('KB of output left out'), 'the cut is marked');
check(text.length < 200, `memory stays bounded (kept ${text.length} characters)`);
const small = new OutputBuffer(10, 20);
small.push('abc'); small.push('def');
eq(small.toString(), 'abcdef', 'short output passes unchanged');
const exact = new OutputBuffer(4, 4);
exact.push('12345678');
eq(exact.toString(), '12345678', 'output that fits head and tail exactly is not cut');

console.log('compiler-guard: ok');
