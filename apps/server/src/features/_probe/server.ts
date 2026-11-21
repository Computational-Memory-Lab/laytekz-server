import type { FastifyReply } from 'fastify';
import type { ServerFeature } from '../types.js';
import { ProjectSettingError } from '../projectSettings.js';
import { parseDocName } from '../../collab.js';

/**
 * The server half of the e2e probe (WP03): one use of every server extension
 * point, for the feature-host tests and the probe specs. Active only under
 * ALDINE_TEST_HOOKS=1 (every Playwright config and the unit tests that set
 * it); otherwise it registers nothing, so no production server answers a
 * probe route or stores a probe setting.
 */
const ON = process.env.ALDINE_TEST_HOOKS === '1';

const note = (v: unknown) => typeof v === 'string' && v.length <= 200;

/** Doc loads seen by the probe's onDocLoad, per project (in memory). */
const docLoads = new Map<string, number>();

const refused = (reply: FastifyReply, err: unknown) => {
  if (err instanceof ProjectSettingError) return reply.code(err.status).send({ error: err.message, ...(err.key ? { key: err.key } : {}) });
  throw err;
};

const probe: ServerFeature = {
  id: '_probe',
  projectSettings: [
    // Shown to clients and changed through PATCH /api/projects/:id/settings.
    { id: '_probe.note', validate: note, clientWritable: true },
    // Kept on the server: never in GET /api/projects/:id or /settings.
    { id: '_probe.serverOnly', validate: note, clientWritable: false, clientVisible: false },
    // Carried over by "Make a copy".
    { id: '_probe.copied', validate: (v) => typeof v === 'boolean', clientWritable: true, copyWithProject: true },
  ],
  capabilities(req) {
    // A header lets the tests check that a throwing feature is left out of the reply.
    if (req.headers['x-probe-throw'] === '1') throw new Error('probe capabilities refused on request');
    return { probe: true };
  },
  tokenWrites: ['POST /api/projects/:id/_probe/token'],
  viewerWrites: ['POST /api/projects/:id/_probe/viewer'],
  onDocLoad(_doc, name) {
    const parsed = parseDocName(name);
    if (parsed) docLoads.set(parsed.projectId, (docLoads.get(parsed.projectId) ?? 0) + 1);
  },
  register(app, kit) {
    app.get<{ Params: { id: string } }>('/api/projects/:id/_probe', async (req, reply) => {
      const meta = await kit.requireAccess(req, reply);
      if (!meta) return;
      return {
        id: meta.id,
        user: kit.user(req)?.id ?? null,
        author: kit.author(req) ?? null,
        note: kit.readExt<string>(meta, '_probe.note') ?? null,
        serverOnly: kit.readExt<string>(meta, '_probe.serverOnly') ?? null,
        docLoads: docLoads.get(meta.id) ?? 0,
      };
    });
    // A feature write: closed to bearer tokens and viewers (not listed).
    app.post<{ Params: { id: string }; Body: { set?: Record<string, unknown>; unset?: string[] } }>('/api/projects/:id/_probe/write', async (req, reply) => {
      const meta = await kit.requireMember(req, reply, 'write probe settings');
      if (!meta) return;
      try {
        const out = await kit.writeExt(meta.id, req.body?.set ?? {}, req.body?.unset);
        return { ok: true, note: kit.readExt(out, '_probe.note') ?? null, serverOnly: kit.readExt(out, '_probe.serverOnly') ?? null };
      } catch (err) { return refused(reply, err); }
    });
    // Listed in tokenWrites: a member's token may call it.
    app.post<{ Params: { id: string } }>('/api/projects/:id/_probe/token', async (req, reply) => {
      const meta = await kit.requireMember(req, reply, 'use the probe');
      if (!meta) return;
      return { ok: true };
    });
    // Listed in viewerWrites: "Can view" people may call it.
    app.post<{ Params: { id: string } }>('/api/projects/:id/_probe/viewer', async (req, reply) => {
      const meta = await kit.requireAccess(req, reply);
      if (!meta) return;
      return { ok: true };
    });
    app.post<{ Params: { id: string } }>('/api/projects/:id/_probe/owner', async (req, reply) => {
      const meta = await kit.requireOwner(req, reply, 'use the owner probe');
      if (!meta) return;
      return { ok: true };
    });
    app.post<{ Params: { id: string }; Body: { branch?: string; value?: unknown } }>('/api/projects/:id/_probe/signal', async (req, reply) => {
      const meta = await kit.requireMember(req, reply, 'send a probe signal');
      if (!meta) return;
      kit.signal(meta.id, typeof req.body?.branch === 'string' ? req.body.branch : '*', '_probe', req.body?.value ?? Date.now());
      return { ok: true };
    });
    const limited = kit.limiter('ping', { burst: 3, perSecond: 0.001 });
    app.get('/api/_probe/limited', async (req, reply) => (limited(req) ? { ok: true } : reply.code(429).send({ error: 'Too many probe requests' })));
  },
};

/** e2e probe of every extension point, active when ALDINE_TEST_HOOKS is 1 (the web half: localStorage aldine.e2e.probe). */
const feature: ServerFeature = ON ? probe : { id: '_probe' };

export default feature;
