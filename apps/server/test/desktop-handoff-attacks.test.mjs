/**
 * The desktop sign-in handoff against a browser that more than one party
 * steers: a second /start opened while the person is on the provider's page,
 * two confirmation pages open at once, Cancel followed by a stale Continue,
 * cookies planted for the parent domain by a sibling subdomain, and an
 * account that waits for approval. Runs in the live layout (no base path,
 * https public URL, so Secure cookies and the __Host- handoff cookie),
 * SSO-only, with signup approval and the mock OIDC provider; Google's
 * variables are set only to make /start show the provider chooser.
 *
 * Also covers what desktop-handoff.test.mjs leaves out: revokeAgentAccess
 * discarding codes, the exchange ending the window's previous session,
 * concurrent exchanges of one code, and the global cap on pending codes.
 *
 * Env must be set before any src import.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';
import { createMockOidc } from '../../../e2e/auth-tests/mock-oidc.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-handoff-attacks-'));
for (const k of Object.keys(process.env)) if (/^(OIDC_|GOOGLE_OAUTH_|GITHUB_LOGIN_|ORCID_)/.test(k)) delete process.env[k];
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_BASE_PATH', 'ALDINE_INSTANCE_NAME', 'SMTP_HOST', 'SES_FROM', 'COOKIE_SECURE']) delete process.env[k];
Object.assign(process.env, {
  AUTH_ENABLED: '1',
  ALDINE_SSO_ONLY: '1',
  ALDINE_SIGNUP: 'approval',
  ALDINE_ADMIN_EMAILS: 'ada@example.org,bob@example.org,eve@example.org',
  ALDINE_PUBLIC_URL: 'https://aldine.test',
  DATA_DIR: path.join(tmp, 'data'),
  META_DIR: path.join(tmp, 'meta'),
  CACHE_DIR: path.join(tmp, 'cache'),
  WEB_DIST: path.join(tmp, 'dist'),
});
fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<!doctype html><title>Laytekz</title>\n');

const mock = await createMockOidc().listen();
Object.assign(process.env, { OIDC_ISSUER: mock.issuer, OIDC_CLIENT_ID: 'aldine-e2e', OIDC_CLIENT_SECRET: 'aldine-e2e-secret', OIDC_LABEL: 'Keycloak' });
mock.addPersona({ code: 'ada', sub: 'ada-1', claims: { name: 'Ada', email: 'ada@example.org', email_verified: true } });
mock.addPersona({ code: 'bob', sub: 'bob-1', claims: { name: 'Bob', email: 'bob@example.org', email_verified: true } });
mock.addPersona({ code: 'eve', sub: 'eve-1', claims: { name: 'Eve', email: 'eve@example.org', email_verified: true } });
mock.addPersona({ code: 'wai', sub: 'wai-1', claims: { name: 'Wai', email: 'wai@example.org', email_verified: true } });

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const { buildApp } = await import('../src/app.ts');
const auth = await import('../src/auth.ts');
const h = await import('../src/desktop-handoff.ts');
const app = await buildApp();

const ORIGIN = 'https://aldine.test';
const HANDOFF = `__Host-${h.HANDOFF_COOKIE}`;
const PORT = 50100;
let ip = 0;
const nextIp = () => `10.8.${Math.floor(ip / 250) % 250}.${1 + (ip++ % 250)}`;
const setCookies = (res) => [res.headers['set-cookie'] ?? []].flat();

function client(port = PORT) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const q = new URLSearchParams({ code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: redirectUri, state });
  return { verifier, challenge, state, redirectUri, startUrl: `/api/auth/desktop/start?${q}` };
}

/** A browser's cookie jar for this one host: Set-Cookie applies, Max-Age=0 deletes. */
class Browser {
  constructor() { this.jar = new Map(); }
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  take(res) {
    for (const line of setCookies(res)) {
      const pair = line.split(';')[0];
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      if (/;\s*Max-Age=0\b/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, pair.slice(i + 1).trim());
    }
    return res;
  }
  async get(url, headers = {}) {
    return this.take(await app.inject({ method: 'GET', url, remoteAddress: nextIp(), headers: { cookie: this.cookie(), accept: 'text/html', ...headers } }));
  }
  async approve(fields, headers = {}) {
    const payload = Object.entries(fields).map(([k, v]) => `${k}=${v}\r\n`).join('');
    return this.take(await app.inject({
      method: 'POST', url: '/api/auth/desktop/approve', remoteAddress: nextIp(),
      headers: { cookie: this.cookie(), 'content-type': 'text/plain', accept: 'text/html', origin: ORIGIN, ...headers }, payload,
    }));
  }
  /** Provider start → mock IdP as `persona` → the callback URL (not yet visited). */
  async throughIdp(persona, { desktop = false } = {}) {
    const start = await this.get(`/api/auth/oauth/oidc${desktop ? '?desktop=1' : ''}`);
    eq(start.statusCode, 302, `the provider start redirects (${start.body})`);
    const loc = new URL(start.headers.location);
    loc.searchParams.set('persona', persona);
    const idp = await fetch(loc, { redirect: 'manual' });
    return `/api/auth/oauth/oidc/callback${new URL(idp.headers.get('location')).search}`;
  }
  async signInOnSite(persona) {
    const cb = await this.get(await this.throughIdp(persona));
    eq(cb.headers.location, '/', `${persona} signs in on the site (${cb.body})`);
    return this;
  }
}

const exchange = (c, code, cookie) => app.inject({
  method: 'POST', url: '/api/auth/desktop/exchange', remoteAddress: nextIp(),
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  payload: JSON.stringify({ code, code_verifier: c.verifier, redirect_uri: c.redirectUri }),
});
const confirmTag = (page) => /name="confirm" value="([^"]+)"/.exec(page.body)?.[1];
const codeFor = (res, c) => {
  const to = new URL(res.headers.location);
  eq(`${to.origin}${to.pathname}`, c.redirectUri, `the code goes to ${c.redirectUri}`);
  eq(to.searchParams.get('state'), c.state, 'with that client\'s state');
  return to.searchParams.get('code');
};
const chooser = (on) => {
  if (on) Object.assign(process.env, { GOOGLE_OAUTH_CLIENT_ID: 'test-client', GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret' });
  else { delete process.env.GOOGLE_OAUTH_CLIENT_ID; delete process.env.GOOGLE_OAUTH_CLIENT_SECRET; }
};

// ---- the live layout: the handoff cookie is __Host- prefixed ----
{
  const b = new Browser();
  const c = client();
  const start = await b.get(c.startUrl);
  eq(start.statusCode, 302, `start redirects (${start.body})`);
  const raw = setCookies(start).find((s) => s.startsWith(`${HANDOFF}=`));
  check(raw, `the handoff cookie is named ${HANDOFF} (${setCookies(start)})`);
  for (const attr of ['Path=/;', 'Secure', 'HttpOnly', 'SameSite=Lax']) check(raw.includes(attr), `with ${attr} (${raw})`);
  check(!/Domain=/i.test(raw), 'and no Domain');
  // The same sealed value under the plain name is what a sibling subdomain could
  // plant; it is not the handoff cookie.
  const bob = await new Browser().signInOnSite('bob');
  const sealed = b.jar.get(HANDOFF);
  let r = await app.inject({ method: 'GET', url: '/api/auth/desktop/continue', remoteAddress: nextIp(), headers: { cookie: `${bob.cookie()}; ${h.HANDOFF_COOKIE}=${sealed}` } });
  eq(r.statusCode, 400, 'a handoff under the plain name is ignored in the live layout');
  r = await app.inject({ method: 'GET', url: '/api/auth/desktop/continue', remoteAddress: nextIp(), headers: { cookie: `${bob.cookie()}; ${HANDOFF}=${sealed}; ${HANDOFF}=${sealed}` } });
  eq(r.statusCode, 400, 'two handoff cookies count as none');
  r = await app.inject({ method: 'GET', url: '/api/auth/desktop/continue', remoteAddress: nextIp(), headers: { cookie: `${bob.cookie()}; ${HANDOFF}=${sealed}` } });
  eq(r.statusCode, 200, 'the one handoff cookie is read');
}

// ---- the app's own sign-in, provider chooser shown, nobody interfering ----
{
  chooser(true);
  const b = new Browser();
  const c = client();
  const page = await b.get(c.startUrl);
  eq(page.statusCode, 200, 'two providers: /start shows the chooser');
  const cb = await b.get(await b.throughIdp('ada', { desktop: true }));
  eq(cb.headers.location, '/api/auth/desktop/continue', `the handoff's own sign-in continues to the app (${cb.body})`);
  const cont = await b.get('/api/auth/desktop/continue');
  eq(cont.statusCode, 302, 'without a confirmation');
  const code = codeFor(cont, c);
  eq((await exchange(c, code)).statusCode, 200, 'and the code exchanges');
  chooser(false);
}

// ---- finding: a second /start while the person is on the provider's page ----
{
  chooser(true);
  const b = new Browser();
  const mine = client(PORT);
  const theirs = client(PORT + 1);
  eq((await b.get(mine.startUrl)).statusCode, 200, 'the app opens /start: the chooser');
  const callback = await b.throughIdp('ada', { desktop: true });
  // While the person is on the provider's page, a local process opens its own /start.
  eq((await b.get(theirs.startUrl)).statusCode, 200, 'a second /start replaces the handoff cookie and shows the chooser');
  const pending = h.pendingHandoffCodes();
  const cb = await b.get(callback);
  eq(cb.statusCode, 302, `the person's sign-in completes (${cb.body})`);
  eq(cb.headers.location, '/', 'but lands on the app: the handoff now in the browser is not the one it started for');
  check(!b.jar.has(HANDOFF), 'and that handoff is ended');
  check(b.jar.has('aldine_session'), 'the browser itself is signed in');
  const cont = await b.get('/api/auth/desktop/continue');
  eq(cont.statusCode, 400, 'nothing is left to continue');
  check(!cont.headers.location, 'no redirect to any loopback listener');
  eq(h.pendingHandoffCodes(), pending, 'no code was issued');
  chooser(false);
}

// ---- finding: a planted state cookie (login CSRF from a sibling site) never reaches a handoff ----
{
  chooser(true);
  // The attacker runs a sign-in of their own as far as the provider's answer.
  const attacker = new Browser();
  const attackerCallback = await attacker.throughIdp('eve');
  const planted = attacker.jar.get('aldine_oauth_state');
  // The victim's desktop app is waiting on the chooser page.
  const victim = new Browser();
  const c = client();
  eq((await victim.get(c.startUrl)).statusCode, 200, 'the victim\'s app shows the chooser');
  victim.jar.set('aldine_oauth_state', planted);
  const pending = h.pendingHandoffCodes();
  const cb = await victim.get(attackerCallback);
  eq(cb.headers.location, '/', `a sign-in the handoff did not start lands on the app (${cb.body})`);
  check(!victim.jar.has(HANDOFF), 'and ends the handoff');
  eq(h.pendingHandoffCodes(), pending, 'the desktop app gets no code for the attacker\'s account');

  // The victim's own state cookie and a planted one together count as none.
  const v2 = new Browser();
  const c2 = client();
  await v2.get(c2.startUrl);
  const own = await v2.throughIdp('ada', { desktop: true });
  const both = await app.inject({ method: 'GET', url: own, remoteAddress: nextIp(), headers: { accept: 'text/html', cookie: `aldine_oauth_state=${planted}; ${v2.cookie()}` } });
  eq(both.statusCode, 400, `two state cookies are a state mismatch (${both.statusCode})`);
  check(both.body.includes('OAuth state mismatch'), 'said as such');
  chooser(false);
}

// ---- finding: two confirmation pages; Continue on the first never serves the second ----
{
  const b = await new Browser().signInOnSite('bob');
  const mine = client(PORT + 2);
  const theirs = client(PORT + 3);
  eq((await b.get(mine.startUrl)).headers.location, '/api/auth/desktop/continue', 'signed in: start goes to the confirmation');
  const minePage = await b.get('/api/auth/desktop/continue');
  eq(minePage.statusCode, 200, 'the app\'s confirmation page');
  const mineTag = confirmTag(minePage);
  check(mineTag, 'carries its confirmation tag');
  await b.get(theirs.startUrl);
  const theirPage = await b.get('/api/auth/desktop/continue');
  const theirTag = confirmTag(theirPage);
  check(theirTag && theirTag !== mineTag, 'a second confirmation page has its own tag');
  const pending = h.pendingHandoffCodes();
  let r = await b.approve({ confirm: mineTag, action: 'approve' });
  eq(r.statusCode, 403, `Continue on the first page is refused (${r.body.slice(0, 200)})`);
  check(r.body.includes('out of date'), 'and says the page is out of date');
  check(!r.headers.location, 'no redirect');
  check(!b.jar.has(HANDOFF), 'both are ended');
  r = await b.approve({ confirm: theirTag, action: 'approve' });
  eq(r.statusCode, 400, 'so the second page cannot approve afterwards either');
  eq(h.pendingHandoffCodes(), pending, 'no code was issued');
}

// ---- finding: Cancel ends the handoff on the server; a stale Continue then gets nothing ----
{
  const b = await new Browser().signInOnSite('bob');
  const c = client(PORT + 4);
  await b.get(c.startUrl);
  const page = await b.get('/api/auth/desktop/continue');
  const tag = confirmTag(page);
  const pending = h.pendingHandoffCodes();
  let r = await b.approve({ confirm: tag, action: 'cancel' });
  eq(r.statusCode, 303, 'Cancel answers with a redirect');
  eq(r.headers.location, `${c.redirectUri}?error=access_denied&state=${c.state}`, 'telling the app the person cancelled');
  check(!b.jar.has(HANDOFF), 'the handoff cookie is gone');
  r = await b.approve({ confirm: tag, action: 'approve' });
  eq(r.statusCode, 400, `Continue on the same page afterwards finds no handoff (${r.statusCode})`);
  eq(h.pendingHandoffCodes(), pending, 'no code was issued');
  // A Cancel from another site is refused like an approve.
  await b.get(c.startUrl);
  const again = await b.get('/api/auth/desktop/continue');
  r = await b.approve({ confirm: confirmTag(again), action: 'cancel' }, { origin: 'https://evil.aldine.test' });
  eq(r.statusCode, 403, 'Cancel from a sibling origin is refused');
}

// ---- an account that waits for approval ends the handoff ----
{
  const b = new Browser();
  const c = client(PORT + 5);
  const start = await b.get(c.startUrl);
  eq(start.headers.location, '/api/auth/oauth/oidc?desktop=1', 'one provider: straight to its sign-in');
  const cb = await b.get(await b.throughIdp('wai', { desktop: true }));
  eq(cb.statusCode, 403, `a new account waits for approval (${cb.statusCode})`);
  check(cb.body.includes('Waiting for approval'), 'said on the page');
  check(!b.jar.has(HANDOFF), 'and the handoff is ended');
}

// ---- the signed-out browser at /continue ends the handoff ----
{
  const b = new Browser();
  await b.get(client(PORT + 6).startUrl);
  check(b.jar.has(HANDOFF), 'a handoff is held');
  const r = await b.get('/api/auth/desktop/continue');
  eq(r.statusCode, 401, 'not signed in: 401');
  check(!b.jar.has(HANDOFF), 'and the handoff is ended');
}

/** The whole chain for a signed-out browser; returns the code for `c`. */
async function codeVia(persona, c = client()) {
  const b = new Browser();
  await b.get(c.startUrl);
  await b.get(await b.throughIdp(persona, { desktop: true }));
  return { code: codeFor(await b.get('/api/auth/desktop/continue'), c), c };
}

// ---- revokeAgentAccess (a password change or reset) discards pending codes ----
{
  const { code, c } = await codeVia('ada');
  const ada = await db().findUserByEmail('ada@example.org');
  await auth.revokeAgentAccess(ada.id);
  eq((await exchange(c, code)).statusCode, 400, 'a code issued before revokeAgentAccess is refused');
}

// ---- the exchange ends the window's previous session ----
{
  const old = await new Browser().signInOnSite('bob');
  const oldSid = old.jar.get('aldine_session');
  eq((await old.get('/api/auth/me', { accept: 'application/json' })).json().user?.email, 'bob@example.org', 'the window has a session');
  const { code, c } = await codeVia('ada');
  const r = await exchange(c, code, `aldine_session=${oldSid}`);
  eq(r.statusCode, 200, 'the exchange succeeds');
  eq(await auth.verifyToken(oldSid), null, 'and the window\'s previous session is ended');
}

// ---- concurrent exchanges of one code: exactly one succeeds ----
{
  const { code, c } = await codeVia('ada');
  const results = await Promise.all(Array.from({ length: 8 }, () => exchange(c, code)));
  eq(results.map((r) => r.statusCode).sort(), [200, 400, 400, 400, 400, 400, 400, 400], 'one of eight concurrent exchanges succeeds');
}

// ---- at most 1000 pending codes in all; the oldest goes first ----
{
  const c = client();
  const grant = (i) => ({ userId: `cap-${i}`, challenge: c.challenge, redirectUri: c.redirectUri });
  const first = h.issueHandoffCode(grant(0));
  for (let i = 1; i <= 1000; i++) h.issueHandoffCode(grant(i));
  eq(h.pendingHandoffCodes(), 1000, 'the store holds 1000 codes at most');
  eq(h.consumeHandoffCode(first, c.verifier, c.redirectUri), null, 'the oldest code went first');
  for (let i = 0; i <= 1000; i++) h.discardHandoffCodesForUser(`cap-${i}`);
}

await app.close();
await mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('desktop handoff attacks: ALL PASSED');
