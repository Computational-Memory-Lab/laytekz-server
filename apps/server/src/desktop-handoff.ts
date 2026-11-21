import crypto from 'node:crypto';
import { subkey } from './output-signing.js';
import { CODE_CHALLENGE_RE, VERIFIER_RE, pkceMatches } from './oauth/pkce.js';

/**
 * Desktop sign-in handoff (RFC 8252, loopback redirect with PKCE). A native
 * shell that loads this server's origin cannot run the identity provider's
 * page itself (Google refuses embedded webviews), so it sends the person to
 * the system browser and receives a one-time code on a loopback listener:
 *
 *   GET  /api/auth/desktop/start     validate, set the signed handoff cookie, sign in
 *   GET  /api/auth/desktop/continue  code now (signed in during this flow) or a confirmation page
 *   POST /api/auth/desktop/approve   the confirmation page's Continue
 *   POST /api/auth/desktop/exchange  code + verifier → session cookie in the app's own browser session
 *
 * The routes live in routes.ts beside the SSO callback; this module holds
 * the parts that need no request: validation, the cookie, and the codes.
 */

export const HANDOFF_COOKIE = 'aldine_desktop_handoff';

/**
 * The handoff cookie's name. Where the browser allows the `__Host-` prefix
 * (Secure, Path=/, the live layout) it carries it: a page on a sibling
 * subdomain can then neither set nor shadow the cookie with one scoped to
 * the parent domain. Under a base path the plain name stays.
 */
export function handoffCookieName(opts: { path: string; secure: boolean }): string {
  return opts.secure && opts.path === '/' ? `__Host-${HANDOFF_COOKIE}` : HANDOFF_COOKIE;
}

/**
 * How many cookies named `name` a Cookie header carries. A sibling subdomain
 * can add a same-named cookie scoped to the parent domain, and which of two
 * a server reads then depends on the browser's ordering, so callers treat
 * more than one as none.
 */
export function cookieCount(header: string | undefined, name: string): number {
  let n = 0;
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) n += 1;
  }
  return n;
}
/** Seconds a started handoff stays usable: the time to get through the provider's sign-in. */
export const HANDOFF_TTL_S = 600;
/** The app exchanges the code a moment after its listener receives it. */
export const HANDOFF_CODE_TTL_MS = 60_000;
/** Pending codes kept at once, in all and per account; the oldest goes first. */
const MAX_CODES = 1000;
const MAX_CODES_PER_ACCOUNT = 5;
const REDIRECT_MAX = 200;
export const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const PROVIDER_RE = /^[a-z0-9-]{1,40}$/;

/**
 * The app's loopback listener, or null: http, host exactly 127.0.0.1 or
 * [::1] (never `localhost`, which a hosts file or DNS can point elsewhere,
 * RFC 8252 §8.3), an explicit unprivileged port, path /callback, nothing
 * else. The string must already be in the form the URL parser prints, so
 * the value checked is byte for byte the value redirected to.
 */
export function validLoopbackRedirect(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > REDIRECT_MAX) return null;
  if (/[?#@\\\s]/.test(raw)) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== '[::1]')) return null;
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/callback') return null;
  const port = Number(u.port);
  if (!u.port || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
  return u.href === raw ? raw : null;
}

export interface HandoffStart { challenge: string; redirectUri: string; state: string; provider: string | null }

/** The start request's query, or the sentence that says what is wrong with it. */
export function parseHandoffStart(q: Record<string, unknown>): { ok: true; start: HandoffStart } | { ok: false; error: string } {
  const challenge = q.code_challenge;
  if (typeof challenge !== 'string' || !CODE_CHALLENGE_RE.test(challenge)) return { ok: false, error: 'code_challenge must be the base64url SHA-256 of the code verifier (43 characters)' };
  if (q.code_challenge_method !== 'S256') return { ok: false, error: 'code_challenge_method must be S256' };
  const redirectUri = validLoopbackRedirect(q.redirect_uri);
  if (!redirectUri) return { ok: false, error: 'redirect_uri must be http://127.0.0.1:<port>/callback or http://[::1]:<port>/callback, with a port from 1024 to 65535' };
  const state = q.state;
  if (typeof state !== 'string' || !STATE_RE.test(state)) return { ok: false, error: 'state must be 16 to 128 base64url characters' };
  const provider = q.provider;
  if (provider !== undefined && (typeof provider !== 'string' || !PROVIDER_RE.test(provider))) return { ok: false, error: 'provider must name a sign-in provider of this server' };
  return { ok: true, start: { challenge, redirectUri, state, provider: provider ?? null } };
}

// ---------- the handoff cookie ----------

export interface Handoff {
  challenge: string;
  redirectUri: string;
  state: string;
  /** Epoch milliseconds. */
  exp: number;
  /** sessionBinding() of the session a sign-in inside this flow created. */
  session?: string;
  /** The account the confirmation page named; approve refuses any other. */
  account?: string;
}

const mac = (message: string) => crypto.createHmac('sha256', subkey('desktop-handoff')).update(message).digest('base64url');
const sameMac = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** The cookie value: base64url(JSON) and its MAC. Signed rather than stored, so a start nobody finishes costs no server memory. */
export function sealHandoff(h: Handoff): string {
  const body = Buffer.from(JSON.stringify({
    c: h.challenge, r: h.redirectUri, s: h.state, e: h.exp,
    ...(h.session ? { b: h.session } : {}), ...(h.account ? { a: h.account } : {}),
  })).toString('base64url');
  return `${body}.${mac(`cookie:${body}`)}`;
}

/** The handoff a cookie value carries, or null when it is forged, expired or malformed. Every field is validated again, the redirect URI included. */
export function openHandoff(value: string | undefined, now = Date.now()): Handoff | null {
  if (!value || value.length > 4096) return null;
  const [body, sig, extra] = value.split('.');
  if (!body || !sig || extra !== undefined || !sameMac(sig, mac(`cookie:${body}`))) return null;
  let v: Record<string, unknown>;
  try { v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const { c, r, s, e, b, a } = v;
  if (typeof e !== 'number' || e <= now) return null;
  if (typeof c !== 'string' || !CODE_CHALLENGE_RE.test(c) || typeof s !== 'string' || !STATE_RE.test(s)) return null;
  const redirectUri = validLoopbackRedirect(r);
  if (!redirectUri) return null;
  if ((b !== undefined && typeof b !== 'string') || (a !== undefined && typeof a !== 'string')) return null;
  return { challenge: c, redirectUri, state: s, exp: e, ...(b ? { session: b } : {}), ...(a ? { account: a } : {}) };
}

/** Set-Cookie for the handoff, or the header that clears it when `sealed` is null. */
export function handoffCookie(sealed: string | null, opts: { path: string; secure: boolean; maxAge?: number }): string {
  const maxAge = sealed === null ? 0 : Math.max(1, Math.floor(opts.maxAge ?? HANDOFF_TTL_S));
  return `${handoffCookieName(opts)}=${sealed ?? ''}; HttpOnly; SameSite=Lax; Path=${opts.path}; Max-Age=${maxAge}${opts.secure ? '; Secure' : ''}`;
}

/**
 * What the provider start of this handoff's own sign-in adds to the OAuth
 * state cookie: a MAC of that attempt's state and the handoff. The callback
 * hands the new session to the handoff only when the handoff it is shown is
 * the one the sign-in started for, so a second /start opened while the
 * person is on the provider's page, or a handoff cookie planted by a sibling
 * site, never receives somebody else's sign-in.
 */
export function attemptTag(oauthState: string, h: Handoff): string {
  return mac(`attempt:${oauthState}:${h.challenge}:${h.state}:${h.redirectUri}`);
}

export function attemptMatches(tag: string | undefined, oauthState: string, h: Handoff): boolean {
  return !!tag && sameMac(tag, attemptTag(oauthState, h));
}

/**
 * The hidden field of the confirmation form: a MAC of the handoff and the
 * account the page shows. Approve acts only when it matches the handoff
 * cookie it is sent with, so Continue on one confirmation page never issues
 * a code for another handoff that started in the same browser since.
 */
export function confirmationTag(h: Handoff): string | null {
  return h.account ? mac(`confirm:${h.challenge}:${h.state}:${h.redirectUri}:${h.account}`) : null;
}

export function confirmationMatches(tag: unknown, h: Handoff): boolean {
  const expected = confirmationTag(h);
  return !!expected && typeof tag === 'string' && sameMac(tag, expected);
}

/** The fields of a form posted with enctype="text/plain" (`name=value` lines). */
export function textPlainFields(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof body !== 'string' || body.length > 4096) return out;
  for (const line of body.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** What the callback writes into the cookie after a sign-in inside this flow: a MAC of the new session id, never the id. */
export function sessionBinding(sid: string): string {
  return mac(`session:${sid}`);
}

/** The browser signed in during this handoff, in the session it presents now. */
export function signedInDuringHandoff(h: Handoff, sid: string | undefined): boolean {
  return !!h.session && !!sid && sameMac(h.session, sessionBinding(sid));
}

/** `uri` with `params` added to its (empty) query. Only ever given a validated loopback URI. */
export function loopbackRedirect(uri: string, params: Record<string, string>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// ---------- one-time codes ----------
// In memory, like the MCP server's authorization codes (oauth/codes.ts): a
// code lives a minute and comes back to the node that issued it on the
// single-node deployment. Keyed by SHA-256 digest, never the plaintext.

interface CodeEntry { hash: string; userId: string; challenge: string; redirectUri: string; exp: number }
const codes = new Map<string, CodeEntry>();
const digest = (code: string) => crypto.createHash('sha256').update(code).digest('hex');

function sweep(now: number): void {
  for (const [k, v] of codes) if (v.exp <= now) codes.delete(k);
}

/** A fresh code for the account, bound to the handoff's challenge and redirect URI. Returns the plaintext, which goes out once, in the loopback redirect. */
export function issueHandoffCode(grant: { userId: string; challenge: string; redirectUri: string }, now = Date.now()): string {
  sweep(now);
  const mine = [...codes.values()].filter((c) => c.userId === grant.userId);
  for (const old of mine.slice(0, Math.max(0, mine.length - MAX_CODES_PER_ACCOUNT + 1))) codes.delete(old.hash);
  while (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value!);
  const code = crypto.randomBytes(32).toString('base64url');
  const hash = digest(code);
  codes.set(hash, { ...grant, hash, exp: now + HANDOFF_CODE_TTL_MS });
  return code;
}

/**
 * The account a code was issued to, or null. The code is gone after its
 * first presentation, before anything else is checked and before the caller
 * awaits anything: a wrong verifier or redirect URI costs it, and two
 * concurrent exchanges cannot both succeed.
 */
export function consumeHandoffCode(code: unknown, verifier: unknown, redirectUri: unknown, now = Date.now()): string | null {
  if (typeof code !== 'string' || !code || code.length > 256) return null;
  const key = digest(code);
  const entry = codes.get(key);
  if (!entry) return null;
  // The lookup is a hash-map probe; equality never rides on string comparison timing.
  const a = Buffer.from(entry.hash, 'hex'), b = Buffer.from(key, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  codes.delete(key);
  if (entry.exp <= now) return null;
  if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier) || redirectUri !== entry.redirectUri) return null;
  return pkceMatches(verifier, entry.challenge) ? entry.userId : null;
}

/** Drop every code issued to the account: none may be exchanged once it is disabled or deleted. */
export function discardHandoffCodesForUser(userId: string): void {
  for (const [k, v] of codes) if (v.userId === userId) codes.delete(k);
}

/** Test hook: how many codes are pending. */
export function pendingHandoffCodes(): number {
  return codes.size;
}
