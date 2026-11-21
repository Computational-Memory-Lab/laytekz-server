/**
 * Origin checks (origin-check.ts): a state-changing /api request or a collab
 * WebSocket handshake whose Origin header names another origin than
 * ALDINE_PUBLIC_URL's is refused, sibling subdomains included; a request
 * without Origin (bearer-token API and MCP clients) and the OAuth protocol
 * endpoints outside /api are untouched, and nothing is checked when
 * ALDINE_PUBLIC_URL is unset.
 *
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-origin-check-'));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_PUBLIC_URL = 'https://aldine.test/x';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
delete process.env.ALDINE_BASE_PATH;
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.SENTRY_DSN;
delete process.env.ALDINE_OAUTH_REGISTRATION;
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];

const { initDb } = await import('../src/db/index.ts');
await initDb();
const { buildApp } = await import('../src/app.ts');
const o = await import('../src/origin-check.ts');
const app = await buildApp();

const ORIGIN = 'https://aldine.test';

// ---- the helper ----
{
  eq(o.publicOrigin(), ORIGIN, 'the public origin drops the base path');
  eq(o.publicOrigin(''), null, 'unset: no origin');
  eq(o.foreignOrigin(undefined, ORIGIN), false, 'no Origin header is not foreign');
  eq(o.foreignOrigin(ORIGIN, ORIGIN), false, 'the public origin is not foreign');
  for (const other of ['https://evil.aldine.test', 'http://aldine.test', 'https://aldine.test:8443', 'https://ALDINE.test', 'https://aldine.test/', 'null', ''])
    eq(o.foreignOrigin(other, ORIGIN), true, `${JSON.stringify(other)} is foreign`);
  eq(o.foreignOrigin('https://evil.example', null), false, 'nothing is foreign without a public origin');
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) eq(o.refusesRequest(m, '/api/auth/logout', 'https://evil.example', ORIGIN), true, `${m} from another site is refused`);
  for (const m of ['GET', 'HEAD', 'OPTIONS']) eq(o.refusesRequest(m, '/api/auth/me', 'https://evil.example', ORIGIN), false, `${m} is not state-changing`);
  for (const route of ['/oauth/token', '/oauth/register', '/oauth/revoke', '/mcp']) eq(o.refusesRequest('POST', route, 'https://evil.example', ORIGIN), false, `${route} is a cookie-less protocol endpoint`);
  eq(o.refusesRequest('POST', '/apix', 'https://evil.example', ORIGIN), true, 'every other route is checked, inside /api or not');
  eq(o.refusesRequest('POST', undefined, 'https://evil.example', ORIGIN), true, 'and so is a request no route matched');
  eq(o.refusesRequest('POST', '/oauth/token/x', 'https://evil.example', ORIGIN), true, 'the exemption is by exact route');
  eq(o.refusesRequest('POST', '/api/auth/logout', undefined, ORIGIN), false, 'no Origin: allowed');
  eq(o.refusesRequest('POST', '/api/auth/logout', 'https://evil.example', null), false, 'no public URL: allowed');
}

// ---- through buildApp, under the base path ALDINE_PUBLIC_URL implies ----
{
  const req = (method, url, origin, extra = {}) => app.inject({ method, url, headers: { ...(origin !== undefined ? { origin } : {}), ...(extra.headers || {}) }, ...(extra.payload !== undefined ? { payload: extra.payload } : {}) });
  let r = await req('POST', '/x/api/auth/logout', 'https://evil.aldine.test');
  eq(r.statusCode, 403, 'a sibling subdomain cannot POST');
  eq(r.json().error, o.CROSS_ORIGIN_REFUSED, 'and is told why');
  r = await req('POST', '/x/api/auth/logout', 'null');
  eq(r.statusCode, 403, 'an opaque origin cannot POST');
  r = await req('POST', '/x/api/auth/logout', ORIGIN);
  eq(r.statusCode, 200, `the public origin can (${r.body})`);
  r = await req('POST', '/x/api/auth/logout');
  eq(r.statusCode, 200, 'so can a client that sends no Origin');
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    r = await req(method, '/x/api/auth/me', 'https://evil.example', { headers: { 'content-type': 'application/json' }, payload: '{}' });
    eq(r.statusCode, 403, `${method} from another site is refused before the route runs`);
  }
  r = await req('PATCH', '/x/api/auth/me', ORIGIN, { headers: { 'content-type': 'application/json' }, payload: '{}' });
  eq(r.statusCode, 401, 'the same PATCH from the public origin reaches the route');
  r = await req('GET', '/x/api/auth/me', 'https://evil.example');
  eq(r.statusCode, 200, 'reads are not refused');
  r = await req('POST', '/x/oauth/token', 'https://evil.example', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=authorization_code' });
  check(r.statusCode !== 403 && r.json().error === 'invalid_request', `the MCP token endpoint answers as before (${r.statusCode} ${r.body})`);
  r = await req('POST', '/x/oauth/register', 'https://claude.ai', { headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ client_name: 'Test', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) });
  eq(r.statusCode, 201, `dynamic client registration from a browser origin still works (${r.body})`);
  r = await req('POST', '/x/api/auth/desktop/exchange', 'https://evil.aldine.test', { headers: { 'content-type': 'application/json' }, payload: '{}' });
  eq(r.statusCode, 403, 'the desktop exchange is refused from another origin');
  r = await req('POST', '/x/api/auth/desktop/exchange', undefined, { headers: { 'content-type': 'application/json' }, payload: '{}' });
  eq(r.statusCode, 400, 'and answers a client that sends no Origin');

  // The router decodes %XX before matching, so the check follows the matched
  // route, never the raw URL.
  for (const url of ['/x/%61pi/auth/logout', '/x/ap%69/auth/logout', '/x/%61%70%69/auth/logout', '/x/api/auth/%6cogout']) {
    r = await req('POST', url, 'https://evil.aldine.test');
    eq(r.statusCode, 403, `${url} from a sibling subdomain is refused (${r.body})`);
  }
  r = await req('POST', '/x/%61pi/auth/logout', ORIGIN);
  eq(r.statusCode, 200, `the same encoded path from the public origin reaches the route (${r.body})`);
  const boundary = 'b0undary';
  const zipPart = `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nPlanted\r\n--${boundary}--\r\n`;
  r = await req('POST', '/x/%61pi/projects/import', 'https://evil.aldine.test', { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: zipPart });
  eq(r.statusCode, 403, 'a multipart import through an encoded path is refused');
  r = await req('POST', '/x/no-such-route', 'https://evil.aldine.test');
  eq(r.statusCode, 403, 'a state-changing request to an unknown path from another site is refused too');
  r = await req('POST', '/x/oauth/revoke', 'https://claude.ai', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'token=x' });
  eq(r.statusCode, 200, `token revocation from a browser client still works (${r.body})`);
}

// ---- ALDINE_PUBLIC_URL unset: nothing is checked ----
{
  const bare = Fastify();
  o.registerOriginCheck(bare, null);
  bare.post('/api/thing', async () => ({ ok: true }));
  const r = await bare.inject({ method: 'POST', url: '/api/thing', headers: { origin: 'https://evil.example' } });
  eq(r.statusCode, 200, 'no public URL: a foreign Origin passes');
  await bare.close();
}

// ---- the collab WebSocket handshake ----
{
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  let expected = ORIGIN;
  server.on('upgrade', (request, socket, head) => {
    if (o.refuseForeignUpgrade(request.headers, socket, expected)) return;
    wss.handleUpgrade(request, socket, head, (ws) => ws.close());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/x/collab/p1`;
  const handshake = (origin) => new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.on('open', () => { resolve('open'); ws.terminate(); });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });
  eq(await handshake('https://evil.aldine.test'), 403, 'a sibling subdomain cannot open the collab socket');
  eq(await handshake('https://other.example'), 403, 'nor can another site');
  eq(await handshake(ORIGIN), 'open', 'the public origin can');
  eq(await handshake(undefined), 'open', 'a client that sends no Origin can');
  expected = null;
  eq(await handshake('https://other.example'), 'open', 'no public URL: not checked');
  await new Promise((resolve) => server.close(resolve));
  wss.close();
}

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('origin checks: ALL PASSED');
