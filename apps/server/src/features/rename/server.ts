import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerFeature, RouteKit } from '../types.js';
import { canEdit } from '../../authz.js';
import { noteEdit, editorOf } from '../../activity.js';
import { RenameError, applyRename, branchOf, planRename, titleApply, titlePlan, type ApplyBody } from '../../rename.js';

/**
 * F10 reference-aware rename, server side (WP28): the preview and apply
 * routes for renaming a file or folder together with the references to it,
 * and the same pair for the document's \title when the project is renamed.
 * Members who may edit only; bearer tokens and viewers are refused by the
 * feature host (no tokenWrites/viewerWrites). The plain POST /file/rename
 * stays as it was for the API, MCP and older bundles.
 */

type Q = { branch?: string; from?: string; to?: string };

async function editor(kit: RouteKit, req: FastifyRequest, reply: FastifyReply) {
  const meta = await kit.requireAccess(req, reply);
  if (!meta) return null;
  if (!canEdit(meta, kit.user(req))) { reply.code(403).send({ error: 'You can view this project, not change it. Ask its owner for edit access.' }); return null; }
  return meta;
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof RenameError) return reply.code(err.status).send(err.body);
  throw err;
}

const feature: ServerFeature = {
  id: 'rename',
  register(app, kit) {
    const planLimit = kit.limiter('plan', { burst: 30, perSecond: 2 });
    const applyLimit = kit.limiter('apply', { burst: 10, perSecond: 0.5 });

    app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/file/rename-plan', async (req, reply) => {
      const meta = await editor(kit, req, reply);
      if (!meta) return;
      if (!planLimit(req)) return reply.code(429).send({ error: 'Too many rename previews — wait a moment and try again' });
      try {
        reply.header('cache-control', 'no-store');
        return await planRename(meta.id, branchOf(req.query.branch), req.query.from, req.query.to);
      } catch (err) { return fail(reply, err); }
    });

    app.post<{ Params: { id: string }; Body: ApplyBody }>('/api/projects/:id/file/rename-apply', async (req, reply) => {
      const meta = await editor(kit, req, reply);
      if (!meta) return;
      if (!applyLimit(req)) return reply.code(429).send({ error: 'Too many renames — wait a moment and try again' });
      try {
        const user = kit.user(req);
        const out = await applyRename(meta.id, req.body ?? {}, kit.author(req), user?.name ?? null);
        noteEdit(meta.id, branchOf(req.body?.branch), editorOf(user));
        return out;
      } catch (err) { return fail(reply, err); }
    });

    const plan = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, q: Q) => {
      const meta = await editor(kit, req, reply);
      if (!meta) return;
      if (!planLimit(req)) return reply.code(429).send({ error: 'Too many title checks — wait a moment and try again' });
      try {
        reply.header('cache-control', 'no-store');
        return await titlePlan(meta.id, branchOf(q.branch), q.from, q.to);
      } catch (err) { return fail(reply, err); }
    };
    app.get<{ Params: { id: string }; Querystring: Q }>('/api/projects/:id/title-plan', (req, reply) => plan(req, reply, req.query));
    app.post<{ Params: { id: string }; Body: Q }>('/api/projects/:id/title-plan', (req, reply) => plan(req, reply, req.body ?? {}));

    app.post<{ Params: { id: string }; Body: { branch?: unknown; from?: unknown; to?: unknown; edits?: unknown } }>('/api/projects/:id/title-apply', async (req, reply) => {
      const meta = await editor(kit, req, reply);
      if (!meta) return;
      if (!applyLimit(req)) return reply.code(429).send({ error: 'Too many changes — wait a moment and try again' });
      try {
        const out = await titleApply(meta.id, req.body ?? {}, kit.author(req));
        if (out.edited) noteEdit(meta.id, branchOf(req.body?.branch), editorOf(kit.user(req)));
        return out;
      } catch (err) { return fail(reply, err); }
    });
  },
};

export default feature;
