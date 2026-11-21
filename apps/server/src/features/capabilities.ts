/**
 * GET /api/capabilities (WP03 server-foundation): what this server offers,
 * so the web app and the desktop app (which may be newer or older than the
 * server) turn features on or leave them out without probing routes.
 *
 * The base keys are public facts: `rev`, `accounts`, `prefs`, `mcp`,
 * `oauthRegistration` (/api/auth/me and the OAuth discovery documents tell
 * as much). Each server feature's capabilities(req) is merged in manifest
 * order under the keys it names, and may replace a base key (the web shell
 * feature names `rev`). A feature answers a signed-out caller (kit.user(req)
 * null with accounts on) with its public keys only: that is the "public
 * subset" signed-out callers get. One that throws, or takes longer than
 * PROVIDER_TIMEOUT_MS, is left out of that reply and logged.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { AUTH_ENABLED } from '../auth.js';
import { reqUser } from '../routes.js';
import { registrationMode } from '../oauth/registration.js';
import type { Capabilities, FeatureId, ServerFeature } from './types.js';

export interface CapabilityProvider { id: FeatureId; capabilities: NonNullable<ServerFeature['capabilities']> }

/** Capabilities answer on every page load: a feature computes them from memory, never from an upstream. */
export const PROVIDER_TIMEOUT_MS = 2000;

let rev: string | null = null;
/** The web build this server serves, as a short hash of its index.html
 *  (every build names new asset files there); '' when there is none (the
 *  dev server, the tests). Read once: a deploy restarts the server. */
export function buildRev(): string {
  if (rev !== null) return rev;
  try {
    rev = crypto.createHash('sha256').update(fs.readFileSync(path.join(config.webDist, 'index.html'))).digest('hex').slice(0, 12);
  } catch {
    rev = '';
  }
  return rev;
}

/** The keys every server answers with. `prefs`: account preference sync is available to this caller. */
export function baseCapabilities(req: FastifyRequest): Capabilities {
  const mcp = process.env.ALDINE_MCP === '1';
  const bearer = !!(req as unknown as { _tokenScope?: unknown })._tokenScope;
  return {
    rev: buildRev(),
    accounts: AUTH_ENABLED,
    prefs: AUTH_ENABLED && !!reqUser(req) && !bearer,
    mcp,
    oauthRegistration: AUTH_ENABLED && mcp && registrationMode() === 'open',
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** The merged answer for one request. */
export async function capabilitiesFor(req: FastifyRequest, providers: readonly CapabilityProvider[]): Promise<Capabilities> {
  const out = baseCapabilities(req);
  const answers = await Promise.allSettled(providers.map((p) => withTimeout(Promise.resolve().then(() => p.capabilities(req)), PROVIDER_TIMEOUT_MS)));
  answers.forEach((a, i) => {
    const id = providers[i].id;
    if (a.status === 'rejected') { req.log.warn({ feature: id, err: (a.reason as Error)?.message }, 'feature capabilities left out'); return; }
    const v = a.value;
    if (!v || typeof v !== 'object' || Array.isArray(v)) { req.log.warn({ feature: id }, 'feature capabilities are not an object; left out'); return; }
    Object.assign(out, v);
  });
  return out;
}

export function registerCapabilitiesRoute(app: FastifyInstance, providers: readonly CapabilityProvider[]): void {
  app.get('/api/capabilities', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return capabilitiesFor(req, providers);
  });
}
