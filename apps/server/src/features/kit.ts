/**
 * The route kit a server feature registers its routes with (WP03
 * server-foundation), and the project-settings routes built on it.
 *
 * Feature routes are registered after registerRoutes, so the global guards
 * already cover them: the origin check, the session and bearer lookup, the
 * trash, project access, token scope and the showcase lock. Writes under
 * /api/projects/:id are refused to bearer tokens and to "Can view" people
 * unless the feature lists them (ServerFeature.tokenWrites / viewerWrites,
 * registered by host.ts). The kit's guards repeat the access checks a route
 * relies on and add membership and ownership; they read `req.params.id`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as store from '../store.js';
import { AUTH_ENABLED, type TokenScope } from '../auth.js';
import { canAccess, canEdit } from '../authz.js';
import { protectedProjects, signalBranch } from '../collab.js';
import { reqAuthor, reqUser, requireMember, requireOwner } from '../routes.js';
import { RateLimiter, clientKey } from '../ratelimit.js';
import type { ProjectMeta } from '../db/types.js';
import { EXT_REV_KEY, PROJECT_SETTINGS_SIGNAL, type FeatureId, type ProjectSettingsPatch, type ProjectSettingsResponse, type RouteKit } from './types.js';
import { ProjectSettingError, applyExtChange, extRev, projectSettingDef, publicExt, validValue } from './projectSettings.js';

/**
 * Runs `fn` after every earlier call with the same scope and key has
 * settled; a rejection reaches only its own caller. Per process, like the
 * repo lock (gitops.withRepoLock): the supported topology has one app node
 * per project and account (docs/SCALING.md).
 */
const keyLocks = new Map<string, Promise<void>>();
export function withKeyLock<T>(scope: string, key: string, fn: () => Promise<T>): Promise<T> {
  const k = `${scope}\u0000${key}`;
  const prev = keyLocks.get(k) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(() => undefined, () => undefined);
  keyLocks.set(k, tail);
  void tail.then(() => { if (keyLocks.get(k) === tail) keyLocks.delete(k); });
  return run;
}

const SHOWCASE = 'This is a read-only showcase project — create your own to try editing.';

const tokenScopeOf = (req: FastifyRequest): TokenScope | null => ((req as unknown as { _tokenScope?: TokenScope | null })._tokenScope ?? null);

/** The project the request names, when the caller may open it; otherwise replies (404, 401 or 403) and resolves null. */
async function requireAccess(req: FastifyRequest, reply: FastifyReply): Promise<ProjectMeta | null> {
  const id = (req.params as { id?: unknown } | undefined)?.id;
  let meta: ProjectMeta | null = null;
  if (typeof id === 'string') {
    try { meta = await store.readMeta(id); } catch { meta = null; }
  }
  if (!meta || meta.deletedAt) { reply.code(404).send({ error: 'project not found' }); return null; }
  if (!AUTH_ENABLED) return meta;
  const user = reqUser(req);
  if (!user) { reply.code(401).send({ error: 'Sign in required' }); return null; }
  if (!canAccess(meta, user)) { reply.code(403).send({ error: 'You do not have access to this project' }); return null; }
  const scope = tokenScopeOf(req);
  if (scope?.projectIds && !scope.projectIds.includes(meta.id)) { reply.code(403).send({ error: 'This token does not have access to this project' }); return null; }
  return meta;
}

/** The value a project setting holds, when it is still valid for its definition. */
function readExt<T>(meta: ProjectMeta, id: string): T | undefined {
  if (id === EXT_REV_KEY) return undefined;
  const v = meta.ext?.[id];
  if (v === undefined) return undefined;
  const def = projectSettingDef(id);
  return def && !validValue(def, v) ? undefined : (v as T);
}

/**
 * The one write path of `ext`: validated against the registered definitions
 * (`client`: only clientWritable keys), written, and, when anything changed,
 * the revision bumped and every open branch told (PROJECT_SETTINGS_SIGNAL,
 * value: the new revision) so clients refetch. Serialised per project; the
 * window between the read and the write is the datastore's round trip, as
 * for every other metadata write.
 */
export async function writeProjectExt(projectId: string, set: unknown, unset: unknown, o: { client: boolean }): Promise<ProjectMeta> {
  return withKeyLock('ext', projectId, async () => {
    const meta = await store.readMeta(projectId);
    const { changed, rev } = applyExtChange(meta, set, unset, o);
    if (changed) {
      await store.writeMeta(meta);
      signalBranch(projectId, '*', PROJECT_SETTINGS_SIGNAL, rev);
    }
    return meta;
  });
}

/** In-memory token buckets for one feature's limiter: synchronous, per node. */
interface Bucket { tokens: number; last: number }
const limiters = new Map<string, Map<string, Bucket>>();
function localLimiter(name: string, o: { burst: number; perSecond: number }): (req: FastifyRequest) => boolean {
  const burst = Math.max(1, Math.floor(o.burst));
  const rate = Math.max(0, o.perSecond);
  let buckets = limiters.get(name);
  if (!buckets) { buckets = new Map(); limiters.set(name, buckets); }
  const map = buckets;
  let swept = 0;
  return (req) => {
    const now = Date.now();
    // Bounded memory without a timer: idle callers are forgotten, at most once a minute.
    if (map.size > 10_000 && now - swept > 60_000) {
      swept = now;
      for (const [k, b] of map) if (now - b.last > 600_000) map.delete(k);
    }
    const key = clientKey(req, reqUser(req)?.id);
    const b = map.get(key) ?? { tokens: burst, last: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 1000) * rate);
    b.last = now;
    map.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

/** Owner or collaborator of a project the caller may open; never a showcase. */
async function requireMemberOf(req: FastifyRequest, reply: FastifyReply, action: string): Promise<ProjectMeta | null> {
  const meta = await requireAccess(req, reply);
  if (!meta) return null;
  if (protectedProjects.has(meta.id)) { reply.code(403).send({ error: SHOWCASE }); return null; }
  return requireMember(req, reply, action);
}

async function requireOwnerOf(req: FastifyRequest, reply: FastifyReply, action: string): Promise<ProjectMeta | null> {
  const meta = await requireAccess(req, reply);
  if (!meta) return null;
  if (protectedProjects.has(meta.id)) { reply.code(403).send({ error: SHOWCASE }); return null; }
  return requireOwner(req, reply, action);
}

/** A feature's kit; limiter names are scoped to the feature. */
export function createRouteKit(feature: FeatureId): RouteKit {
  return {
    user: (req) => reqUser(req),
    author: (req) => reqAuthor(req),
    requireAccess,
    requireMember: requireMemberOf,
    requireOwner: requireOwnerOf,
    readExt,
    writeExt: (projectId, set, unset) => writeProjectExt(projectId, set, unset ?? [], { client: false }),
    signal: signalBranch,
    limiter: (name, o) => localLimiter(`${feature}:${name}`, o),
  };
}

/** Project settings changes per person: the settings page sends one PATCH per change. */
const settingsLimiter = new RateLimiter('project-settings', 60, 1);

const settingsOf = (meta: ProjectMeta): ProjectSettingsResponse => ({ values: publicExt(meta) ?? {}, rev: extRev(meta) });

/**
 * GET /api/projects/:id/settings: the clientVisible values and the revision,
 * for anyone who may open the project. PATCH {set?, unset?}: members who may
 * edit (never a showcase, a viewer or a bearer token), clientWritable keys
 * only; an unknown or invalid key is a 400 naming it.
 */
export function registerProjectSettingsRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>('/api/projects/:id/settings', async (req, reply) => {
    const meta = await requireAccess(req, reply);
    if (!meta) return;
    reply.header('cache-control', 'no-store');
    return settingsOf(meta);
  });

  app.patch<{ Params: { id: string }; Body: ProjectSettingsPatch }>('/api/projects/:id/settings', async (req, reply) => {
    if (tokenScopeOf(req)) return reply.code(403).send({ error: 'Access tokens cannot change project settings — sign in to do this' });
    const meta = await requireMemberOf(req, reply, "change this project's settings");
    if (!meta) return;
    if (!canEdit(meta, reqUser(req))) return reply.code(403).send({ error: 'You can view this project, not change it. Ask its owner for edit access.' });
    if (!(await settingsLimiter.take(clientKey(req, reqUser(req)?.id)))) return reply.code(429).send({ error: 'Too many settings changes — wait a moment and try again' });
    const body = req.body as ProjectSettingsPatch | null | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ error: 'Send {"set": {…}, "unset": […]}' });
    try {
      const out = await writeProjectExt(meta.id, body.set, body.unset, { client: true });
      reply.header('cache-control', 'no-store');
      return settingsOf(out);
    } catch (err) {
      if (err instanceof ProjectSettingError) return reply.code(err.status).send({ error: err.message, ...(err.key ? { key: err.key } : {}) });
      throw err;
    }
  });
}
