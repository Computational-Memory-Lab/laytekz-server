/**
 * The desktop sign-in handoff (desktop-handoff.ts and its routes in
 * routes.ts) through buildApp() under a URL prefix, SSO-only, with the mock
 * OIDC provider standing in for every provider (Google cannot be mocked):
 * validation, the whole start → provider → callback → continue → loopback
 * chain, the exchange that puts the session cookie in the app's own browser
 * session, and each way a code or a confirmation must be refused.
 *
 * Env must be set before any src import.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';
import { createMockOidc } from '../../../e2e/auth-tests/mock-oidc.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-desktop-handoff-'));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_SSO_ONLY = '1';
process.env.ALDINE_BASE_PATH = '/x';
process.env.ALDINE_PUBLIC_URL = 'https://aldine.test';
// An operator named like the product is no operator: titles say Laytekz once.
process.env.ALDINE_INSTANCE_NAME = 'Laytekz';
process.env.RL_OAUTH_TOKEN_BURST = '5';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.SENTRY_DSN;
delete process.env.ALDINE_SIGNUP;
delete process.env.ALDINE_ADMIN_EMAILS;
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<!doctype html><title>Aldine</title>\n');

const mock = await createMockOidc().listen();
Object.assign(process.env, { OIDC_ISSUER: mock.issuer, OIDC_CLIENT_ID: 'aldine-e2e', OIDC_CLIENT_SECRET: 'aldine-e2e-secret', OIDC_LABEL: 'Keycloak' });

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const { buildApp } = await import('../src/app.ts');
const auth = await import('../src/auth.ts');
const h = await import('../src/desktop-handoff.ts');
const app = await buildApp();

const ORIGIN = 'https://aldine.test';
const PORT = 49152;
const LOOPBACK = `http://127.0.0.1:${PORT}/callback`;
let ip = 0;
const nextIp = () => `10.7.${Math.floor(ip / 250) % 250}.${1 + (ip++ % 250)}`;
const get = (url, cookie, headers = {}) => app.inject({ method: 'GET', url, remoteAddress: nextIp(), headers: { ...(cookie ? { cookie } : {}), ...headers } });
const cookiesOf = (res) => [res.headers['set-cookie'] ?? []].flat();
const rawCookie = (res, name) => cookiesOf(res).find((s) => s.startsWith(`${name}=`));
const cookieValue = (res, name) => {
  const c = rawCookie(res, name);
  return c ? c.slice(name.length + 1).split(';')[0] : undefined;
};
const jar = (pairs) => Object.entries(pairs).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');

/** A desktop app's side of the flow: verifier, challenge, state and the start URL. */
function client(redirectUri = LOOPBACK, extra = '') {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  const q = new URLSearchParams({ code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: redirectUri, state });
  return { verifier, challenge, state, redirectUri, startUrl: `/x/api/auth/desktop/start?${q}${extra}` };
}
const exchange = (body, { cookie, headers = {}, remoteAddress = nextIp() } = {}) => app.inject({
  method: 'POST', url: '/x/api/auth/desktop/exchange', remoteAddress,
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
  payload: typeof body === 'string' ? body : JSON.stringify(body),
});
/** The loopback redirect's code and state, after checking it goes to the client's listener only. */
function loopbackParams(res, c) {
  const to = new URL(res.headers.location);
  eq(`${to.origin}${to.pathname}`, c.redirectUri, 'the browser goes to the app\'s loopback listener');
  eq([...to.searchParams.keys()].sort(), ['code', 'state'], 'with the code and state only');
  eq(to.searchParams.get('state'), c.state, 'state is the app\'s');
  return to.searchParams.get('code');
}

mock.addPersona({ code: 'ada', sub: 'ada-1', claims: { name: 'Ada Lovelace', email: 'ada@example.org', email_verified: true } });
mock.addPersona({ code: 'bob', sub: 'bob-1', claims: { name: 'Bob', email: 'bob@example.org', email_verified: true } });
mock.addPersona({ code: 'dis', sub: 'dis-1', claims: { name: 'Dis', email: 'dis@example.org', email_verified: true } });
mock.addPersona({ code: 'del', sub: 'del-1', claims: { name: 'Del', email: 'del@example.org', email_verified: true } });

/** Provider start → IdP (persona) → callback, carrying `cookie` (a handoff, a session) along. */
async function signIn(persona, { cookie = '', desktop = false } = {}) {
  const start = await get(`/x/api/auth/oauth/oidc${desktop ? '?desktop=1' : ''}`, cookie || undefined);
  eq(start.statusCode, 302, 'provider start redirects to the IdP');
  const stateCookie = `aldine_oauth_state=${cookieValue(start, 'aldine_oauth_state')}`;
  const loc = new URL(start.headers.location);
  loc.searchParams.set('persona', persona);
  const idp = await fetch(loc, { redirect: 'manual' });
  const back = new URL(idp.headers.get('location'));
  const cb = await get(`/x/api/auth/oauth/oidc/callback${back.search}`, [stateCookie, cookie].filter(Boolean).join('; '));
  return { start, cb, sid: cookieValue(cb, 'aldine_session') };
}

/** The whole flow for a browser that is not signed in; returns the loopback code. */
async function fullFlow(persona, c = client()) {
  const start = await get(c.startUrl);
  eq(start.statusCode, 302, `start redirects (${start.body})`);
  eq(start.headers.location, '/x/api/auth/oauth/oidc?desktop=1', 'into the only provider\'s sign-in, marked as the handoff\'s');
  const handoff = cookieValue(start, h.HANDOFF_COOKIE);
  check(handoff, 'handoff cookie set');
  const { start: providerStart, cb, sid } = await signIn(persona, { cookie: `${h.HANDOFF_COOKIE}=${handoff}`, desktop: true });
  check(!rawCookie(providerStart, h.HANDOFF_COOKIE), 'the handoff\'s own provider link keeps the handoff');
  eq(cb.statusCode, 302, `callback signs in (${cb.body})`);
  eq(cb.headers.location, '/x/api/auth/desktop/continue', 'and lands on /continue, not the app');
  check(sid, 'session cookie issued');
  const bound = cookieValue(cb, h.HANDOFF_COOKIE);
  check(bound && bound !== handoff, 'the callback records the sign-in in the handoff cookie');
  check(!bound.includes(sid), 'by MAC, never the session id');
  const cont = await get('/x/api/auth/desktop/continue', jar({ aldine_session: sid, [h.HANDOFF_COOKIE]: bound }));
  eq(cont.statusCode, 302, `a sign-in inside the flow continues without a confirmation (${cont.body})`);
  check(rawCookie(cont, h.HANDOFF_COOKIE)?.includes('Max-Age=0'), 'the handoff cookie is cleared');
  return { code: loopbackParams(cont, c), sid, c };
}

// ---- pure helpers ----
{
  for (const ok of ['http://127.0.0.1:1024/callback', 'http://127.0.0.1:65535/callback', 'http://[::1]:5000/callback']) eq(h.validLoopbackRedirect(ok), ok, `accepts ${ok}`);
  for (const bad of [
    'http://localhost:5000/callback', 'http://127.0.0.1/callback', 'http://127.0.0.1:80/callback', 'http://127.0.0.1:1023/callback',
    'http://127.0.0.1:65536/callback', 'https://127.0.0.1:5000/callback', 'http://127.0.0.2:5000/callback', 'http://evil.example:5000/callback',
    'http://127.0.0.1:5000/callback?x=1', 'http://127.0.0.1:5000/callback?', 'http://127.0.0.1:5000/callback#f', 'http://u:p@127.0.0.1:5000/callback',
    'http://127.0.0.1:5000/callback/', 'http://127.0.0.1:5000/cb', 'http://127.0.0.1:5000/a/../callback', 'http://127.1:5000/callback',
    'http://127.0.0.1:05000/callback', 'HTTP://127.0.0.1:5000/callback', 'http://[0:0:0:0:0:0:0:1]:5000/callback', 'http://127.0.0.1:5000\\callback',
    'http://127.0.0.1.:5000/callback', `http://127.0.0.1:5000/callback${' '.repeat(200)}`, '//127.0.0.1:5000/callback', 'javascript:alert(1)', '', null, 42,
  ]) eq(h.validLoopbackRedirect(bad), null, `refuses ${JSON.stringify(bad)}`);

  const c = client();
  const good = { code_challenge: c.challenge, code_challenge_method: 'S256', redirect_uri: LOOPBACK, state: c.state };
  check(h.parseHandoffStart(good).ok, 'a well-formed start parses');
  eq(h.parseHandoffStart({ ...good, provider: 'google' }).start.provider, 'google', 'with an optional provider');
  for (const [what, q] of [
    ['a short challenge', { ...good, code_challenge: c.challenge.slice(1) }], ['plain PKCE', { ...good, code_challenge_method: 'plain' }],
    ['no method', { ...good, code_challenge_method: undefined }], ['a repeated parameter', { ...good, state: [c.state, c.state] }],
    ['a short state', { ...good, state: 'abc' }], ['a state with a dot', { ...good, state: `${c.state}.x` }], ['a long state', { ...good, state: 'a'.repeat(129) }],
    ['a bad provider name', { ...good, provider: '../x' }], ['no redirect URI', { ...good, redirect_uri: undefined }],
  ]) eq(h.parseHandoffStart(q).ok, false, `refuses ${what}`);

  const now = Date.now();
  const sealed = h.sealHandoff({ challenge: c.challenge, redirectUri: LOOPBACK, state: c.state, exp: now + 60_000 });
  eq(h.openHandoff(sealed, now), { challenge: c.challenge, redirectUri: LOOPBACK, state: c.state, exp: now + 60_000 }, 'a sealed handoff opens');
  eq(h.openHandoff(sealed, now + 60_000), null, 'not once expired');
  const [body, sig] = sealed.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), r: 'http://127.0.0.1:6000/callback' })).toString('base64url');
  eq(h.openHandoff(`${forged}.${sig}`, now), null, 'a changed field breaks the MAC');
  eq(h.openHandoff(`${body}.${sig}.x`, now), null, 'extra parts are refused');
  eq(h.openHandoff(`${body}.${'A'.repeat(sig.length)}`, now), null, 'a wrong MAC is refused');
  const evil = h.sealHandoff({ challenge: c.challenge, redirectUri: 'https://evil.example/callback', state: c.state, exp: now + 60_000 });
  eq(h.openHandoff(evil, now), null, 'the redirect URI is validated again when read back, even under a valid MAC');

  check(h.signedInDuringHandoff({ session: h.sessionBinding('sid-a') }, 'sid-a'), 'the binding matches its session');
  check(!h.signedInDuringHandoff({ session: h.sessionBinding('sid-a') }, 'sid-b'), 'and no other');
  check(!h.signedInDuringHandoff({}, 'sid-a'), 'no binding, no match');

  const grant = { userId: 'u-pure', challenge: c.challenge, redirectUri: LOOPBACK };
  let code = h.issueHandoffCode(grant);
  eq(h.consumeHandoffCode(code, c.verifier, LOOPBACK), 'u-pure', 'a code exchanges once');
  eq(h.consumeHandoffCode(code, c.verifier, LOOPBACK), null, 'and never again');
  code = h.issueHandoffCode(grant);
  eq(h.consumeHandoffCode(code, client().verifier, LOOPBACK), null, 'a wrong verifier fails');
  eq(h.consumeHandoffCode(code, c.verifier, LOOPBACK), null, 'and costs the code');
  code = h.issueHandoffCode(grant);
  eq(h.consumeHandoffCode(code, c.verifier, 'http://127.0.0.1:49153/callback'), null, 'a different redirect URI fails');
  eq(h.consumeHandoffCode(code, c.verifier, LOOPBACK), null, 'and costs the code');
  code = h.issueHandoffCode(grant, now - h.HANDOFF_CODE_TTL_MS);
  eq(h.consumeHandoffCode(code, c.verifier, LOOPBACK, now), null, 'an expired code fails');
  code = h.issueHandoffCode(grant);
  eq(h.consumeHandoffCode(code, 'short', LOOPBACK), null, 'a malformed verifier fails');
  const before = h.pendingHandoffCodes();
  const many = Array.from({ length: 7 }, () => h.issueHandoffCode({ ...grant, userId: 'u-cap' }));
  eq(h.pendingHandoffCodes() - before, 5, 'an account holds at most five pending codes');
  eq(h.consumeHandoffCode(many[0], c.verifier, LOOPBACK), null, 'the oldest went first');
  eq(h.consumeHandoffCode(many[6], c.verifier, LOOPBACK), 'u-cap', 'the newest stays');
  h.discardHandoffCodesForUser('u-cap');
  eq(h.consumeHandoffCode(many[5], c.verifier, LOOPBACK), null, 'discarding drops every code of the account');
  eq(h.pendingHandoffCodes(), before, 'and nothing else');
}

// ---- start: validation ----
{
  const bad = [
    client('http://localhost:5000/callback'), client('http://127.0.0.1/callback'), client('https://127.0.0.1:5000/callback'),
    client('http://127.0.0.1:5000/callback?next=https://evil.example'), client('http://evil.example:5000/callback'), client('https://evil.example/'),
  ];
  for (const c of bad) {
    const r = await get(c.startUrl);
    eq(r.statusCode, 400, `refuses redirect_uri ${c.redirectUri}`);
    check(r.json().error.startsWith('redirect_uri must be'), `says why (${r.body})`);
    check(!rawCookie(r, h.HANDOFF_COOKIE), 'no handoff cookie for a refused start');
  }
  const c = client();
  let r = await get(c.startUrl.replace('S256', 'plain'));
  eq(r.statusCode, 400, 'plain PKCE refused');
  r = await get(c.startUrl.replace(/code_challenge=[^&]+/, 'code_challenge=abc'));
  eq(r.statusCode, 400, 'a malformed challenge refused');
  r = await get(c.startUrl.replace(/state=[^&]+/, 'state=short'));
  eq(r.statusCode, 400, 'a short state refused');
  r = await get(`${c.startUrl}&provider=github`);
  eq(r.statusCode, 400, 'an unconfigured provider refused');
  check(r.json().error.includes('not configured'), `says so (${r.body})`);
  r = await get(c.startUrl.replace('redirect_uri=', 'redirect_uri=x'), undefined, { accept: 'text/html' });
  eq(r.statusCode, 400, 'still 400 for a browser');
  check(String(r.headers['content-type']).startsWith('text/html'), 'as a page');
  check(r.body.includes('<title>Desktop sign-in failed · Laytekz</title>'), `titled like the web app, the product named once (${r.body.slice(0, 300)})`);
  check(!/<script/i.test(r.body) && String(r.headers['content-security-policy']).includes("default-src 'none'"), 'script-free');
}

// ---- the whole chain, then the exchange ----
{
  const { code, c } = await fullFlow('ada');
  const res = await exchange({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri });
  eq(res.statusCode, 200, `exchange succeeds (${res.body})`);
  eq(res.json().user.email, 'ada@example.org', 'answers the account');
  eq(res.headers['cache-control'], 'no-store', 'never cached');
  const raw = rawCookie(res, 'aldine_session');
  check(raw, 'sets the session cookie');
  for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/x;', 'Secure', 'Max-Age=2592000']) check(raw.includes(attr), `session cookie has ${attr} (${raw})`);
  const sid = cookieValue(res, 'aldine_session');
  check(!res.body.includes(sid), 'the session id is never in the body');
  const me = (await get('/x/api/auth/me', `aldine_session=${sid}`)).json();
  eq(me.user.email, 'ada@example.org', '/api/auth/me answers the user with the exchanged cookie');

  const replay = await exchange({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri });
  eq(replay.statusCode, 400, 'a replayed code is refused');
  eq(replay.json(), { error: 'invalid_grant' }, 'as invalid_grant');
  check(!rawCookie(replay, 'aldine_session'), 'with no session');
}

// ---- wrong verifier, wrong redirect URI, expiry, malformed requests ----
{
  let { code, c } = await fullFlow('ada');
  let r = await exchange({ code, code_verifier: client().verifier, redirect_uri: c.redirectUri });
  eq(r.statusCode, 400, 'a wrong verifier is refused');
  r = await exchange({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri });
  eq(r.statusCode, 400, 'and the code is spent by the attempt');

  ({ code, c } = await fullFlow('ada'));
  r = await exchange({ code, code_verifier: c.verifier, redirect_uri: `http://127.0.0.1:${PORT + 1}/callback` });
  eq(r.statusCode, 400, 'a different redirect URI is refused');
  r = await exchange({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri });
  eq(r.statusCode, 400, 'and the code is spent');

  const ada = await db().findUserByEmail('ada@example.org');
  const k = client();
  const stale = h.issueHandoffCode({ userId: ada.id, challenge: k.challenge, redirectUri: k.redirectUri }, Date.now() - h.HANDOFF_CODE_TTL_MS - 1);
  r = await exchange({ code: stale, code_verifier: k.verifier, redirect_uri: k.redirectUri });
  eq(r.statusCode, 400, 'an expired code is refused');

  r = await exchange({ code_verifier: k.verifier, redirect_uri: k.redirectUri });
  eq(r.statusCode, 400, 'no code: invalid_grant');
  r = await exchange('{"code":');
  eq(r.statusCode, 400, 'malformed JSON: 400');

  ({ code, c } = await fullFlow('ada'));
  r = await app.inject({ method: 'POST', url: '/x/api/auth/desktop/exchange', remoteAddress: nextIp(), headers: { 'content-type': 'text/plain' }, payload: JSON.stringify({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri }) });
  eq(r.statusCode, 415, 'a text/plain body is refused');
  r = await app.inject({ method: 'POST', url: '/x/api/auth/desktop/exchange', remoteAddress: nextIp(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri }).toString() });
  eq(r.statusCode, 415, 'a form body is refused');
  r = await app.inject({ method: 'POST', url: '/x/api/auth/desktop/exchange', remoteAddress: nextIp() });
  eq(r.statusCode, 415, 'no body at all is refused');
  r = await exchange({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri });
  eq(r.statusCode, 200, 'a refused content type never spent the code');
}

// ---- bearer tokens are refused, without spending the code ----
{
  const { code, c, sid } = await fullFlow('ada');
  const me = (await get('/x/api/auth/me', `aldine_session=${sid}`)).json().user;
  const { token } = await auth.createAccessToken(me.id, 'agent', null, null);
  let r = await exchange({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri }, { headers: { authorization: `Bearer ${token}` } });
  eq(r.statusCode, 403, `a valid access token is refused (${r.body})`);
  r = await exchange({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri }, { headers: { authorization: 'Bearer aldn_not-a-token' } });
  eq(r.statusCode, 403, 'an unknown bearer token is refused too');
  r = await get(client().startUrl, undefined, { authorization: `Bearer ${token}` });
  eq(r.statusCode, 403, 'start refuses an access token');
  r = await exchange({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri });
  eq(r.statusCode, 200, 'the refusals never spent the code');
}

// ---- rate limit ----
{
  const remoteAddress = '10.250.0.1';
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await exchange({ code: 'nope', code_verifier: client().verifier, redirect_uri: LOOPBACK }, { remoteAddress })).statusCode);
  eq(codes, [400, 400, 400, 400, 400, 429], 'the token limiter applies per address (RL_OAUTH_TOKEN_BURST=5 here)');
}

// ---- disabled and deleted accounts ----
{
  let { code, c, sid } = await fullFlow('dis');
  const dis = (await get('/x/api/auth/me', `aldine_session=${sid}`)).json().user;
  await auth.disableAccount(dis.id, false);
  let r = await exchange({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri });
  eq(r.statusCode, 400, 'disabling the account discards its pending codes');
  await auth.enableAccount(dis.id);

  ({ code, c } = await fullFlow('dis'));
  await db().setDisabled(dis.id, new Date().toISOString());
  r = await exchange({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri });
  eq(r.statusCode, 400, 'a code of an account disabled behind its back is refused at exchange');
  check(!rawCookie(r, 'aldine_session'), 'with no session');

  let del;
  ({ code, c, sid: del } = await fullFlow('del'));
  const delUser = (await get('/x/api/auth/me', `aldine_session=${del}`)).json().user;
  await auth.deleteAccount(delUser.id);
  r = await exchange({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri });
  eq(r.statusCode, 400, 'deleting the account discards its pending codes');
}

// ---- a browser that was already signed in confirms first ----
{
  const { sid } = await signIn('bob');
  check(sid, 'bob signed in on the site, outside any handoff');
  const c = client();
  const start = await get(c.startUrl, `aldine_session=${sid}`);
  eq(start.statusCode, 302, 'start with a session');
  eq(start.headers.location, '/x/api/auth/desktop/continue', 'goes straight to /continue');
  const handoff = cookieValue(start, h.HANDOFF_COOKIE);
  const pending = h.pendingHandoffCodes();
  const page = await get('/x/api/auth/desktop/continue', jar({ aldine_session: sid, [h.HANDOFF_COOKIE]: handoff }), { accept: 'text/html' });
  eq(page.statusCode, 200, `a confirmation page, not a redirect (${page.body.slice(0, 200)})`);
  eq(h.pendingHandoffCodes(), pending, 'no code exists before the person confirms');
  check(page.body.includes('data-testid="desktop-handoff-account">The Laytekz desktop app on this computer is asking to sign in as <strong>Bob (bob@example.org)</strong>'), `names the product and the account (${page.body})`);
  check(page.body.includes('<title>Sign in to the desktop app? · Laytekz</title>'), 'titled');
  check(page.body.includes('action="/x/api/auth/desktop/approve" enctype="text/plain"'), 'Continue posts to approve under the base path');
  check(page.body.includes('name="action" value="cancel" class="quiet" data-testid="desktop-handoff-cancel"'), `Cancel is a button of the same form (${page.body})`);
  const confirmField = /name="confirm" value="([A-Za-z0-9_-]{43})"/.exec(page.body)?.[1];
  check(confirmField, 'the form carries a confirmation tag for this handoff');
  check(!/<script/i.test(page.body), 'no scripts');
  const csp = String(page.headers['content-security-policy']);
  check(csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'"), `locked down (${csp})`);
  check(csp.includes(`form-action 'self' http://127.0.0.1:${PORT}`), `the form may go to this site, then the app's listener only (${csp})`);
  eq(page.headers['x-frame-options'], 'DENY', 'never framed');
  const confirmed = cookieValue(page, h.HANDOFF_COOKIE);
  check(confirmed && confirmed !== handoff, 'the handoff now names the account shown');

  const post = (cookie, origin, payload = `confirm=${confirmField}\r\naction=approve\r\n`) => app.inject({ method: 'POST', url: '/x/api/auth/desktop/approve', remoteAddress: nextIp(), headers: { cookie, 'content-type': 'text/plain', accept: 'text/html', ...(origin ? { origin } : {}) }, payload });
  let r = await post(jar({ aldine_session: sid, [h.HANDOFF_COOKIE]: confirmed }), 'https://evil.aldine.test');
  eq(r.statusCode, 403, 'approve from a sibling origin is refused');
  r = await post(jar({ aldine_session: sid, [h.HANDOFF_COOKIE]: confirmed }), 'https://other.example');
  eq(r.statusCode, 403, 'approve from another site is refused');
  r = await post(jar({ aldine_session: sid, [h.HANDOFF_COOKIE]: confirmed }));
  eq(r.statusCode, 403, 'approve without an Origin is refused');
  r = await post(jar({ aldine_session: sid, [h.HANDOFF_COOKIE]: handoff }), ORIGIN);
  eq(r.statusCode, 403, 'approve without having seen the confirmation is refused');
  r = await post(jar({ aldine_session: sid, [h.HANDOFF_COOKIE]: confirmed }), ORIGIN, '');
  eq(r.statusCode, 403, 'approve without the form\'s confirmation tag is refused');
  check(rawCookie(r, h.HANDOFF_COOKIE)?.includes('Max-Age=0'), 'and ends the handoff');
  const { sid: adaSid } = await signIn('ada');
  r = await post(jar({ aldine_session: adaSid, [h.HANDOFF_COOKIE]: confirmed }), ORIGIN);
  eq(r.statusCode, 403, 'approve by another account than the one shown is refused');
  check(rawCookie(r, h.HANDOFF_COOKIE)?.includes('Max-Age=0'), 'and ends the handoff');
  eq(h.pendingHandoffCodes(), pending, 'none of the refusals issued a code');

  r = await post(jar({ aldine_session: sid, [h.HANDOFF_COOKIE]: confirmed }), ORIGIN);
  eq(r.statusCode, 303, `approve from the page itself redirects (${r.body})`);
  const code = loopbackParams(r, c);
  check(rawCookie(r, h.HANDOFF_COOKIE)?.includes('Max-Age=0'), 'and clears the handoff');
  const ex = await exchange({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri });
  eq(ex.statusCode, 200, 'the approved code exchanges');
  eq(ex.json().user.email, 'bob@example.org', 'for the account shown');

  // Cancel goes through the server, which ends the handoff before telling the app.
  {
    const k = client();
    const st = await get(k.startUrl, `aldine_session=${sid}`);
    const pg = await get('/x/api/auth/desktop/continue', jar({ aldine_session: sid, [h.HANDOFF_COOKIE]: cookieValue(st, h.HANDOFF_COOKIE) }), { accept: 'text/html' });
    const tag = /name="confirm" value="([^"]+)"/.exec(pg.body)[1];
    const held = jar({ aldine_session: sid, [h.HANDOFF_COOKIE]: cookieValue(pg, h.HANDOFF_COOKIE) });
    const before = h.pendingHandoffCodes();
    const cancelled = await post(held, ORIGIN, `confirm=${tag}\r\naction=cancel\r\n`);
    eq(cancelled.statusCode, 303, `Cancel redirects (${cancelled.body})`);
    eq(cancelled.headers.location, `${LOOPBACK}?error=access_denied&state=${k.state}`, 'to the app with access_denied');
    check(rawCookie(cancelled, h.HANDOFF_COOKIE)?.includes('Max-Age=0'), 'and clears the handoff cookie');
    eq(h.pendingHandoffCodes(), before, 'no code is issued');
  }

  // A handoff bound to one session, presented with another (signed in elsewhere): confirm.
  const c2 = client();
  const s2 = await get(c2.startUrl);
  const { cb } = await signIn('ada', { cookie: `${h.HANDOFF_COOKIE}=${cookieValue(s2, h.HANDOFF_COOKIE)}`, desktop: true });
  const other = await get('/x/api/auth/desktop/continue', jar({ aldine_session: sid, [h.HANDOFF_COOKIE]: cookieValue(cb, h.HANDOFF_COOKIE) }));
  eq(other.statusCode, 200, 'a binding to another session asks for confirmation');
}

// ---- /continue without a usable handoff, or signed out ----
{
  const { sid } = await signIn('bob');
  let r = await get('/x/api/auth/desktop/continue', `aldine_session=${sid}`);
  eq(r.statusCode, 400, 'no handoff cookie: 400');
  r = await get('/x/api/auth/desktop/continue', jar({ aldine_session: sid, [h.HANDOFF_COOKIE]: 'e30.AAAA' }));
  eq(r.statusCode, 400, 'a forged handoff: 400');
  const c = client();
  const evil = h.sealHandoff({ challenge: c.challenge, redirectUri: 'https://evil.example/callback', state: c.state, exp: Date.now() + 60_000, session: h.sessionBinding(sid) });
  r = await get('/x/api/auth/desktop/continue', jar({ aldine_session: sid, [h.HANDOFF_COOKIE]: evil }));
  eq(r.statusCode, 400, 'a handoff naming a non-loopback URI never redirects, whatever signed it');
  check(!r.headers.location, 'no redirect at all');
  const start = await get(c.startUrl);
  r = await get('/x/api/auth/desktop/continue', `${h.HANDOFF_COOKIE}=${cookieValue(start, h.HANDOFF_COOKIE)}`);
  eq(r.statusCode, 401, 'a handoff without a session: 401');
}

// ---- a sign-in begun elsewhere drops an abandoned handoff ----
{
  const start = await get(client().startUrl);
  const handoff = `${h.HANDOFF_COOKIE}=${cookieValue(start, h.HANDOFF_COOKIE)}`;
  const { start: providerStart, cb } = await signIn('bob', { cookie: handoff });
  check(rawCookie(providerStart, h.HANDOFF_COOKIE)?.includes('Max-Age=0'), 'the web app\'s own sign-in link clears the handoff');
  eq(cb.headers.location, '/x/', 'a client that ignores the clearing still lands on the app: the sign-in was not the handoff\'s');
  check(rawCookie(cb, h.HANDOFF_COOKIE)?.includes('Max-Age=0'), 'and the callback clears the handoff again');
  // In a browser the cleared cookie is gone by the callback:
  const fresh = await signIn('bob');
  eq(fresh.cb.headers.location, '/x/', 'without the cookie the callback lands on the app');
}

// ---- several providers: a script-free chooser; provider= picks one ----
{
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';
  const c = client();
  const page = await get(c.startUrl, undefined, { accept: 'text/html' });
  eq(page.statusCode, 200, 'a chooser page');
  check(rawCookie(page, h.HANDOFF_COOKIE), 'with the handoff cookie set');
  check(page.body.includes('data-testid="desktop-handoff-provider-google" href="/x/api/auth/oauth/google?desktop=1">Continue with Google'), `lists Google (${page.body})`);
  check(page.body.includes('data-testid="desktop-handoff-provider-oidc" href="/x/api/auth/oauth/oidc?desktop=1">Continue with Keycloak'), 'and the OIDC provider');
  check(!page.body.includes('desktop-handoff-password'), 'no password note on an SSO-only server');
  check(!/<script/i.test(page.body), 'no scripts');
  const picked = await get(`${c.startUrl}&provider=google`);
  eq(picked.headers.location, '/x/api/auth/oauth/google?desktop=1', 'provider=google goes straight to Google');
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
}

// ---- the handoff cookie's shape ----
{
  const start = await get(client('http://[::1]:50000/callback').startUrl);
  eq(start.statusCode, 302, 'an IPv6 loopback starts too');
  const raw = rawCookie(start, h.HANDOFF_COOKIE);
  for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/x;', 'Max-Age=600', 'Secure']) check(raw.includes(attr), `handoff cookie has ${attr} (${raw})`);
  const { sid } = await signIn('bob');
  const page = await get('/x/api/auth/desktop/continue', jar({ aldine_session: sid, [h.HANDOFF_COOKIE]: cookieValue(start, h.HANDOFF_COOKIE) }));
  check(String(page.headers['content-security-policy']).includes("form-action 'self' http:"), 'CSP cannot name [::1]: the form may go to http');
}

await app.close();
await mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('desktop handoff: ALL PASSED');
