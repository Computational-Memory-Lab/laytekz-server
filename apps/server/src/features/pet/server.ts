import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AUTH_ENABLED } from '../../auth.js';
import type { RouteKit, ServerFeature } from '../types.js';
import { loadPet, type LoadedPet, type PetImage, type PetSqueak } from './asset.js';

/**
 * F14 desk pet, server side (WP39 pet-engine).
 *
 * - The operator variables are read and checked once, at boot (asset.ts);
 *   refusals are logged as warnings and the feature stays hidden.
 * - GET /api/capabilities gains `pet: {v, w, h, s, q}` for callers who may
 *   see the image (signed in, or any caller on a server without accounts);
 *   everyone else gets no `pet` key, so the web app shows no setting. `q` is
 *   the recorded squeak's version, or null (the app synthesizes the squeak).
 * - GET /api/instance/pet/:variant? serves the image (variant `silhouette`)
 *   and the recorded squeak (variant `squeak`, PET2): 401 signed out,
 *   `private` caching only (so a CDN never stores a photo of a person),
 *   CORP same-origin, nosniff and a sandbox CSP like the logo.
 */

let loaded: LoadedPet | null = null;

/** The pet shipped with the server (assets/pet, same path from src/ and dist/). */
const BUNDLED_PET = fileURLToPath(new URL('../../../assets/pet/', import.meta.url));

/** A squeak dropped next to the bundled pet (squeak.mp3, .ogg or .wav), or ''. */
export function bundledSqueak(dir = BUNDLED_PET): string {
  for (const ext of ['mp3', 'ogg', 'wav']) {
    const f = `${dir}squeak.${ext}`;
    try { if (fs.statSync(f).isFile()) return f; } catch { /* not there */ }
  }
  return '';
}

/** The operator's images when ALDINE_INSTANCE_PET names one; no pet for
 *  `none`; otherwise the bundled pet and its silhouette. The squeak: the
 *  operator's ALDINE_INSTANCE_PET_SQUEAK, none for `none`, otherwise a
 *  squeak file next to the bundled pet when there is one. */
export function withDefaultPet(env: NodeJS.ProcessEnv, squeakDir = BUNDLED_PET): NodeJS.ProcessEnv {
  const own = (env.ALDINE_INSTANCE_PET || '').trim();
  if (own.toLowerCase() === 'none') return { ...env, ALDINE_INSTANCE_PET: '', ALDINE_INSTANCE_PET_SILHOUETTE: '', ALDINE_INSTANCE_PET_SQUEAK: '' };
  const out: NodeJS.ProcessEnv = own ? { ...env } : { ...env, ALDINE_INSTANCE_PET: `${BUNDLED_PET}pet.png`, ALDINE_INSTANCE_PET_SILHOUETTE: `${BUNDLED_PET}pet-silhouette.png` };
  const squeak = (env.ALDINE_INSTANCE_PET_SQUEAK || '').trim();
  out.ALDINE_INSTANCE_PET_SQUEAK = squeak.toLowerCase() === 'none' ? '' : squeak || bundledSqueak(squeakDir);
  return out;
}
/** The checked images. Read lazily so a test may set the env before the first call. */
function current(): LoadedPet {
  if (!loaded) loaded = loadPet(withDefaultPet(process.env));
  return loaded;
}
/** Forget the images read at boot (tests only: production reads them once). */
export function resetPetForTests(): void { loaded = null; }

/** What the client needs to show the pet; null when it must not see it. */
export interface PetCapability { v: string; w: number | null; h: number | null; s: string | null; q: string | null }

function maySee(req: FastifyRequest, kit: Pick<RouteKit, 'user'> | null): boolean {
  if (!AUTH_ENABLED) return true;
  return !!kit?.user(req);
}

export function petCapability(): PetCapability | null {
  const { pet, silhouette, squeak } = current();
  if (!pet) return null;
  return { v: pet.v, w: pet.w, h: pet.h, s: silhouette?.v ?? null, q: squeak?.v ?? null };
}

let routeKit: RouteKit | null = null;

function send(req: FastifyRequest<{ Querystring: { v?: unknown } }>, reply: FastifyReply, img: PetImage | PetSqueak) {
  const etag = `"${img.v}"`;
  reply
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    .header('cross-origin-resource-policy', 'same-origin')
    .header('etag', etag);
  if (req.query?.v === img.v) {
    reply.header('cache-control', 'private, max-age=31536000, immutable');
  } else {
    reply.header('cache-control', 'private, no-cache');
    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).includes(etag)) {
      return reply.code(304).send();
    }
  }
  return reply.header('content-type', img.type).send(img.bytes);
}

const feature: ServerFeature = {
  id: 'pet',
  register(app: FastifyInstance, kit: RouteKit) {
    routeKit = kit;
    for (const w of current().warnings) app.log.warn(w);
    app.get<{ Params: { variant?: string }; Querystring: { v?: unknown } }>('/api/instance/pet/:variant?', async (req, reply) => {
      const { pet, silhouette, squeak } = current();
      const variant = req.params.variant;
      if (variant !== undefined && variant !== 'silhouette' && variant !== 'squeak') return reply.code(404).send({ error: 'not found' });
      if (variant === 'squeak' && pet && !squeak) return reply.code(404).send({ error: 'No desk pet squeak' });
      const img = variant === 'squeak' ? squeak : variant === 'silhouette' ? silhouette : pet;
      if (!img) return reply.code(404).send({ error: 'No desk pet image' });
      if (!maySee(req, kit)) return reply.code(401).send({ error: 'Sign in required' });
      return send(req, reply, img);
    });
  },
  capabilities(req: FastifyRequest) {
    const cap = petCapability();
    if (!cap || !maySee(req, routeKit)) return {};
    return { pet: cap };
  },
};

export default feature;
