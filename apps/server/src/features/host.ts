/**
 * The server feature host (WP03 server-foundation). app.ts calls it once,
 * right after registerRoutes (one Galley-marked line), so every global guard
 * registerRoutes installs (origin check, session and bearer lookup, trash,
 * project access, token scope, viewers, showcases) already covers feature
 * routes.
 *
 * It registers the core V2 routes first (GET /api/capabilities, the account
 * preferences, GET/PATCH /api/projects/:id/settings), so no feature can take
 * their paths, then each feature in manifest order: its project settings,
 * its token and viewer write allowances, its doc-load hook, its
 * capabilities, and its routes (feature.register with a RouteKit, inside an
 * encapsulated plugin, so a hook or decorator it adds stays its own).
 *
 * A feature that is malformed or throws is skipped with an error in the log;
 * the server and the other features start anyway. A feature whose register
 * throws half way keeps the routes it had added.
 */
import type { FastifyInstance } from 'fastify';
import { SERVER_FEATURES } from './index.js';
import { FEATURE_IDS, type FeatureId, type ServerFeature } from './types.js';
import { allowTokenWrite, allowViewerWrite } from '../routes.js';
import { registerDocLoadHook } from '../collab.js';
import { createRouteKit, registerProjectSettingsRoutes } from './kit.js';
import { registerPrefsRoutes } from './prefs.js';
import { registerProjectSettings } from './projectSettings.js';
import { registerCapabilitiesRoute, type CapabilityProvider } from './capabilities.js';

/** A write allowance: a state-changing method and a route pattern under /api/projects/:id. */
const ALLOWANCE = /^(POST|PUT|PATCH|DELETE) \/api\/projects\/:id(\/[A-Za-z0-9._~:-]+)*$/;

/** The doc-load hook each feature has installed, so registering a feature again replaces it. */
const docLoadRemovals = new Map<FeatureId, () => void>();

/** Why a feature cannot be registered at all, or null. */
function malformed(f: ServerFeature, seen: ReadonlySet<string>): string | null {
  if (!f || typeof f !== 'object') return 'is not an object';
  if (!(FEATURE_IDS as readonly string[]).includes(f.id)) return `has an unknown id ${JSON.stringify(f.id)}`;
  if (seen.has(f.id)) return 'is listed twice';
  for (const key of ['tokenWrites', 'viewerWrites'] as const) {
    const list = f[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return `${key} is not a list`;
    const bad = list.find((e) => typeof e !== 'string' || !ALLOWANCE.test(e));
    if (bad !== undefined) return `${key} entry ${JSON.stringify(bad)} is not 'METHOD /api/projects/:id/…' with POST, PUT, PATCH or DELETE`;
  }
  for (const key of ['register', 'capabilities', 'onDocLoad'] as const) {
    if (f[key] !== undefined && typeof f[key] !== 'function') return `${key} is not a function`;
  }
  if (f.projectSettings !== undefined && !Array.isArray(f.projectSettings)) return 'projectSettings is not a list';
  return null;
}

/** Registers each feature's routes with a RouteKit, its project settings,
 *  token and viewer write allowances, doc-load hooks, the capabilities route
 *  and the preference and project-settings routes. */
export async function registerFeatures(app: FastifyInstance, features: readonly ServerFeature[] = SERVER_FEATURES): Promise<void> {
  const providers: CapabilityProvider[] = [];
  registerCapabilitiesRoute(app, providers);
  registerPrefsRoutes(app);
  registerProjectSettingsRoutes(app);

  const seen = new Set<string>();
  for (const f of features) {
    const problem = malformed(f, seen);
    if (problem) {
      app.log.error(`[features] ${String(f?.id ?? '?')} ${problem}; it is not registered`);
      continue;
    }
    seen.add(f.id);
    for (const p of registerProjectSettings(f.id, f.projectSettings ?? [])) app.log.error(`[features] ${p}; that setting is not registered`);
    for (const e of f.tokenWrites ?? []) allowTokenWrite(e);
    for (const e of f.viewerWrites ?? []) allowViewerWrite(e);
    docLoadRemovals.get(f.id)?.();
    docLoadRemovals.delete(f.id);
    if (f.onDocLoad) docLoadRemovals.set(f.id, registerDocLoadHook((doc, name) => f.onDocLoad!(doc, name)));
    if (f.capabilities) providers.push({ id: f.id, capabilities: (req) => f.capabilities!(req) });
    if (f.register) {
      const kit = createRouteKit(f.id);
      await app.register(async (scope) => {
        try {
          await f.register!(scope, kit);
        } catch (err) {
          app.log.error(`[features] ${f.id} failed to register its routes: ${(err as Error)?.message ?? err}`);
        }
      });
    }
  }
}
