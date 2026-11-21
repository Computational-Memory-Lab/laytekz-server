/**
 * Account preferences (WP03 server-foundation): the settings a person keeps
 * in their account so every browser and the desktop app share them. One
 * `connections` row per account (provider PREFS_PROVIDER), so no migration:
 * a V1 server ignores the row, and deleting the account deletes it. The
 * server keeps no registry of preference names; it checks their shape and
 * size only, so a new setting needs no server change.
 *
 *   GET   /api/account/preferences   {prefs, rev, updatedAt}, ETag "p<rev>", 304 on If-None-Match
 *   PATCH /api/account/preferences   {set?, unset?, keepExisting?}
 *   PUT   /api/account/preferences   {prefs}: replaces all (import, "Reset all")
 *
 * 404 with accounts off, 401 signed out, 403 for bearer tokens. Every reply
 * is AccountPrefsResponse; an error is {error, key?}.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { AUTH_ENABLED, type PublicUser } from '../auth.js';
import { reqUser } from '../routes.js';
import { RateLimiter, clientKey } from '../ratelimit.js';
import { etagMatches } from '../thumbnail.js';
import { PREF_KEY_RE, PREF_LIMITS, PREFS_PROVIDER, type AccountPrefsPatch, type AccountPrefsPut, type AccountPrefsResponse } from './types.js';
import { withKeyLock } from './kit.js';
import { stableJson } from './projectSettings.js';

/** A refused change: a sentence for the person, and the preference it is about. */
export class PrefsError extends Error {
  constructor(message: string, readonly key?: string) {
    super(message);
    this.name = 'PrefsError';
  }
}

/** Longest text a preference value holds (a font name, a colour list entry). */
export const PREF_STRING_MAX = 500;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Why `v` cannot be stored as a preference value, or null when it can:
 *  true/false, a finite number, text of at most PREF_STRING_MAX characters,
 *  or lists and objects of those nested at most PREF_LIMITS.valueDepth deep. */
export function prefValueProblem(v: unknown, depth = 0): string | null {
  if (typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : 'is not a finite number';
  if (typeof v === 'string') return v.length <= PREF_STRING_MAX ? null : `is longer than ${PREF_STRING_MAX} characters`;
  if (Array.isArray(v) || isPlainObject(v)) {
    if (depth >= PREF_LIMITS.valueDepth) return `nests deeper than ${PREF_LIMITS.valueDepth} levels`;
    for (const item of Array.isArray(v) ? v : Object.values(v)) {
      const p = prefValueProblem(item, depth + 1);
      if (p) return p;
    }
    return null;
  }
  if (v === null) return 'is null (unset the preference instead)';
  return 'is not true/false, a number, text, or a list or object of those';
}

function checkKey(key: string): void {
  if (!PREF_KEY_RE.test(key)) throw new PrefsError(`${JSON.stringify(key.slice(0, 80))} is not a preference name (like "editor.fontSize")`, key.slice(0, 80));
}

function checkValue(key: string, v: unknown): void {
  const problem = prefValueProblem(v);
  if (problem) throw new PrefsError(`The value of ${key} ${problem}`, key);
  if (Buffer.byteLength(JSON.stringify(v)) > PREF_LIMITS.valueBytes) throw new PrefsError(`The value of ${key} is larger than ${PREF_LIMITS.valueBytes / 1024} KB`, key);
}

function checkStored(prefs: Record<string, unknown>): void {
  if (Object.keys(prefs).length > PREF_LIMITS.keysStored) throw new PrefsError(`An account keeps at most ${PREF_LIMITS.keysStored} preferences`);
  if (Buffer.byteLength(JSON.stringify(prefs)) > PREF_LIMITS.totalBytes) throw new PrefsError(`Your preferences would take more than ${PREF_LIMITS.totalBytes / 1024} KB`);
}

/** A PATCH body, checked before anything is read or written. */
export function parsePrefsPatch(body: unknown): { set: Record<string, unknown>; unset: string[]; keepExisting: boolean } {
  if (!isPlainObject(body)) throw new PrefsError('Send {"set": {…}, "unset": […]}');
  const { set, unset, keepExisting } = body as AccountPrefsPatch;
  if (set !== undefined && !isPlainObject(set)) throw new PrefsError('"set" must be an object of preference names and values');
  if (unset !== undefined && (!Array.isArray(unset) || unset.some((k) => typeof k !== 'string'))) throw new PrefsError('"unset" must be a list of preference names');
  if (keepExisting !== undefined && typeof keepExisting !== 'boolean') throw new PrefsError('"keepExisting" must be true or false');
  const sets = (set ?? {}) as Record<string, unknown>;
  const unsets = (unset ?? []) as string[];
  if (Object.keys(sets).length + unsets.length > PREF_LIMITS.keysPerRequest) throw new PrefsError(`At most ${PREF_LIMITS.keysPerRequest} preferences can change in one request`);
  for (const [k, v] of Object.entries(sets)) { checkKey(k); checkValue(k, v); }
  for (const k of unsets) {
    checkKey(k);
    if (Object.hasOwn(sets, k)) throw new PrefsError(`${k} cannot be both set and unset`, k);
  }
  return { set: sets, unset: unsets, keepExisting: keepExisting === true };
}

/** A PUT body: the whole set, bounded by what an account may store. */
export function parsePrefsPut(body: unknown): Record<string, unknown> {
  const prefs = isPlainObject(body) ? (body as Partial<AccountPrefsPut>).prefs : undefined;
  if (!isPlainObject(prefs)) throw new PrefsError('Send {"prefs": {…}}');
  for (const [k, v] of Object.entries(prefs)) { checkKey(k); checkValue(k, v); }
  checkStored(prefs);
  return prefs;
}

/** An account's preferences: empty at revision 0 until the first change. A
 *  row in any other shape reads as empty, keeping its revision. */
export async function readPrefs(userId: string): Promise<AccountPrefsResponse> {
  const row = await db().getConnection(userId, PREFS_PROVIDER);
  const rev = typeof row?.rev === 'number' && Number.isSafeInteger(row.rev) && row.rev >= 0 ? row.rev : 0;
  return {
    prefs: isPlainObject(row?.prefs) ? row.prefs : {},
    rev,
    updatedAt: typeof row?.updatedAt === 'string' ? row.updatedAt : null,
  };
}

async function store(userId: string, prefs: Record<string, unknown>, rev: number): Promise<AccountPrefsResponse> {
  const out: AccountPrefsResponse = { prefs, rev, updatedAt: new Date().toISOString() };
  await db().setConnection(userId, PREFS_PROVIDER, { ...out });
  return out;
}

/**
 * One atomic merge per account (serialised per process): `set` replaces
 * keys, or with `keepExisting` fills only the keys the account lacks (the
 * first browser to sync seeds the account), `unset` removes keys. The
 * revision moves only when something changed.
 */
export function patchPrefs(userId: string, patch: { set: Record<string, unknown>; unset: string[]; keepExisting: boolean }): Promise<AccountPrefsResponse> {
  return withKeyLock('prefs', userId, async () => {
    const cur = await readPrefs(userId);
    const next: Record<string, unknown> = { ...cur.prefs };
    let changed = false;
    for (const k of patch.unset) {
      if (Object.hasOwn(next, k)) { delete next[k]; changed = true; }
    }
    for (const [k, v] of Object.entries(patch.set)) {
      const has = Object.hasOwn(next, k);
      if (has && (patch.keepExisting || stableJson(next[k]) === stableJson(v))) continue;
      next[k] = v;
      changed = true;
    }
    if (!changed) return cur;
    checkStored(next);
    return store(userId, next, cur.rev + 1);
  });
}

/** Replaces every preference of the account (import, "Reset all"). */
export function replacePrefs(userId: string, prefs: Record<string, unknown>): Promise<AccountPrefsResponse> {
  return withKeyLock('prefs', userId, async () => {
    const cur = await readPrefs(userId);
    if (stableJson(cur.prefs) === stableJson(prefs)) return cur;
    return store(userId, { ...prefs }, cur.rev + 1);
  });
}

/** Preference writes per person: the client coalesces changes into one PATCH per 400 ms. */
const prefsLimiter = new RateLimiter('preferences', 60, 2);

/** The signed-in person a preferences request is for; otherwise replies and returns null. */
function prefsUser(req: FastifyRequest, reply: FastifyReply): PublicUser | null {
  if (!AUTH_ENABLED) { reply.code(404).send({ error: 'not found' }); return null; }
  if ((req as unknown as { _tokenScope?: unknown })._tokenScope) { reply.code(403).send({ error: 'Access tokens cannot use account preferences — sign in to do this' }); return null; }
  const user = reqUser(req);
  if (!user) { reply.code(401).send({ error: 'Sign in required' }); return null; }
  return user;
}

const etagOf = (rev: number) => `"p${rev}"`;

function send(reply: FastifyReply, out: AccountPrefsResponse): AccountPrefsResponse {
  reply.header('cache-control', 'no-store').header('etag', etagOf(out.rev));
  return out;
}

export function registerPrefsRoutes(app: FastifyInstance): void {
  app.get('/api/account/preferences', async (req, reply) => {
    const user = prefsUser(req, reply);
    if (!user) return;
    const out = await readPrefs(user.id);
    if (etagMatches(req.headers['if-none-match'], etagOf(out.rev))) {
      return reply.code(304).header('cache-control', 'no-store').header('etag', etagOf(out.rev)).send();
    }
    return send(reply, out);
  });

  const write = (handler: (userId: string, body: unknown) => Promise<AccountPrefsResponse>) => async (req: FastifyRequest, reply: FastifyReply) => {
    const user = prefsUser(req, reply);
    if (!user) return;
    if (!(await prefsLimiter.take(clientKey(req, user.id)))) return reply.code(429).send({ error: 'Too many preference changes — wait a moment and try again' });
    try {
      return send(reply, await handler(user.id, req.body));
    } catch (err) {
      if (err instanceof PrefsError) return reply.code(400).send({ error: err.message, ...(err.key ? { key: err.key } : {}) });
      throw err;
    }
  };
  app.patch('/api/account/preferences', write((userId, body) => patchPrefs(userId, parsePrefsPatch(body))));
  app.put('/api/account/preferences', write((userId, body) => replacePrefs(userId, parsePrefsPut(body))));
}
