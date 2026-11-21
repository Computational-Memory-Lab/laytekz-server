/**
 * Laytekz V2 (WP16): online BibTeX, server side. Routes:
 *   GET  /api/references/lookup?q=&filter=          signed in; search or resolve
 *   GET  /api/projects/:id/references/lookup?q=…   the same, marking papers the branch already has
 *   GET  /api/projects/:id/references/targets       the .bib files a reference can go to
 *   POST /api/projects/:id/references/preview       the entry, key and duplicate check; writes nothing
 *   POST /api/projects/:id/references/insert        append final BibTeX (open to tokens), returns entryHash
 *   POST /api/projects/:id/references/remove        take an append back while its text is unchanged
 * The old /references/add and /api/references/search routes stay in routes.ts.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerFeature, RouteKit } from '../types.js';
import type { ProjectMeta } from '../../db/types.js';
import * as auth from '../../auth.js';
import { refLimiter, clientKey } from '../../ratelimit.js';
import { noteEdit, editorOf } from '../../activity.js';
import { BRANCH_RE, isHiddenPath } from '../../util.js';
import { refsConfig } from '../../refs/config.js';
import { UpstreamError } from '../../refs/http.js';
import { KEY_STYLES, type KeyStyle } from '../../refs/keys.js';
import {
  ReferenceError, insertReference, lookup, markInProject, previewReference, referenceTargets, removeReference,
  type FieldStyle, type LookupFilter, type ReferenceOptions,
} from '../../references.js';

const FIELD_STYLES = ['auto', 'biblatex', 'bibtex'];
const FILTERS: LookupFilter[] = ['all', 'medicine', 'datasets'];
const validBibPath = (v: unknown) => typeof v === 'string' && (v === '' || (v.length <= 300 && /\.bib$/i.test(v) && !isHiddenPath(v) && !v.split('/').includes('..') && !v.startsWith('/')));

function options(kit: RouteKit, meta: ProjectMeta): ReferenceOptions {
  return {
    keyStyle: kit.readExt<KeyStyle>(meta, 'references.keyStyle'),
    protectCaps: kit.readExt<boolean>(meta, 'references.protectCaps'),
    fieldStyle: kit.readExt<FieldStyle>(meta, 'references.fieldStyle'),
    defaultBib: kit.readExt<string>(meta, 'references.defaultBib') || undefined,
  };
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof ReferenceError) return reply.code(err.status).send({ error: err.message, code: err.code });
  if (err instanceof UpstreamError) return reply.code(502).send({ error: err.message });
  const e = err as { name?: string; message?: string };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /fetch failed/i.test(e?.message ?? '')) {
    return reply.code(502).send({ error: 'The reference service could not be reached. Try again in a moment.' });
  }
  throw err;
}

function branchOf(b: unknown, reply: FastifyReply): string | null {
  const branch = typeof b === 'string' && b ? b : 'main';
  if (!BRANCH_RE.test(branch)) { reply.code(400).send({ error: 'invalid branch name' }); return null; }
  return branch;
}

/** Set at registration (boot), before any capabilities request. */
let routeKit: RouteKit | null = null;

const feature: ServerFeature = {
  id: 'references',

  projectSettings: [
    { id: 'references.keyStyle', validate: (v) => KEY_STYLES.includes(v as KeyStyle), clientWritable: true, copyWithProject: true },
    { id: 'references.protectCaps', validate: (v) => typeof v === 'boolean', clientWritable: true, copyWithProject: true },
    { id: 'references.fieldStyle', validate: (v) => FIELD_STYLES.includes(v as string), clientWritable: true, copyWithProject: true },
    { id: 'references.defaultBib', validate: validBibPath, clientWritable: true, copyWithProject: true },
  ],

  // An agent's token adds references through MCP today; the REST insert takes the same final BibTeX.
  tokenWrites: ['POST /api/projects/:id/references/insert'],

  capabilities(req) {
    const c = refsConfig();
    const signedIn = !auth.AUTH_ENABLED || !!routeKit?.user(req);
    return { references: { online: c.online, ...(signedIn ? { sources: [...c.sources] } : {}) } };
  },

  register(app, kit) {
    routeKit = kit;
    const signedIn = (req: FastifyRequest) => !auth.AUTH_ENABLED || !!kit.user(req);

    async function runLookup(req: FastifyRequest<{ Querystring: { q?: string; filter?: string } }>, reply: FastifyReply) {
      if (!signedIn(req)) { reply.code(401).send({ error: 'Sign in to look up references online' }); return null; }
      if (!refsConfig().online) { reply.code(404).send({ error: 'Online reference lookup is off on this server' }); return null; }
      const q = (req.query.q || '').trim();
      const filter = FILTERS.includes(req.query.filter as LookupFilter) ? (req.query.filter as LookupFilter) : 'all';
      if (q.length < 3) return { kind: 'text', results: [], errors: [] };
      if (!(await refLimiter.take(clientKey(req, kit.user(req)?.id)))) { reply.code(429).send({ error: 'Search rate limit reached. Please slow down.' }); return null; }
      return lookup(q, filter);
    }

    app.get<{ Querystring: { q?: string; filter?: string } }>('/api/references/lookup', async (req, reply) => {
      try { return (await runLookup(req, reply)) ?? reply; } catch (err) { return fail(reply, err); }
    });

    app.get<{ Params: { id: string }; Querystring: { q?: string; filter?: string; branch?: string } }>('/api/projects/:id/references/lookup', async (req, reply) => {
      const meta = await kit.requireAccess(req, reply); if (!meta) return reply;
      const branch = branchOf(req.query.branch, reply); if (!branch) return reply;
      try {
        const r = await runLookup(req, reply);
        if (!r) return reply;
        return 'results' in r && Array.isArray(r.results) && r.results.length ? { ...r, results: markInProject(meta.id, branch, r.results as never) } : r;
      } catch (err) { return fail(reply, err); }
    });

    app.get<{ Params: { id: string }; Querystring: { branch?: string } }>('/api/projects/:id/references/targets', async (req, reply) => {
      const meta = await kit.requireAccess(req, reply); if (!meta) return reply;
      const branch = branchOf(req.query.branch, reply); if (!branch) return reply;
      try { return await referenceTargets(meta.id, branch, options(kit, meta)); } catch (err) { return fail(reply, err); }
    });

    app.post<{ Params: { id: string }; Body: { branch?: string; id?: string; bibtex?: string; key?: string; bibFile?: string } }>('/api/projects/:id/references/preview', async (req, reply) => {
      const meta = await kit.requireMember(req, reply, 'add references'); if (!meta) return reply;
      const body = req.body || {};
      const branch = branchOf(body.branch, reply); if (!branch) return reply;
      if (!body.id && !body.bibtex) return reply.code(400).send({ error: 'id or bibtex required' });
      if (body.bibtex && body.bibtex.length > 100_000) return reply.code(413).send({ error: 'That BibTeX is too long for one reference.' });
      if (body.bibFile !== undefined && !validBibPath(body.bibFile)) return reply.code(400).send({ error: 'Choose a .bib file.' });
      if (body.id && !body.bibtex) {
        if (!signedIn(req)) return reply.code(401).send({ error: 'Sign in to look up references online' });
        if (!refsConfig().online) return reply.code(404).send({ error: 'Online reference lookup is off on this server' });
        if (!(await refLimiter.take(clientKey(req, kit.user(req)?.id)))) return reply.code(429).send({ error: 'Rate limit reached. Please slow down.' });
      }
      try {
        return await previewReference(meta.id, branch, { id: body.id, bibtex: body.bibtex, key: body.key, bibFile: body.bibFile || undefined }, options(kit, meta));
      } catch (err) { return fail(reply, err); }
    });

    app.post<{ Params: { id: string }; Body: { branch?: string; bibtex?: string; key?: string; bibFile?: string; loadBib?: boolean; force?: boolean } }>('/api/projects/:id/references/insert', async (req, reply) => {
      const meta = await kit.requireMember(req, reply, 'add references'); if (!meta) return reply;
      const body = req.body || {};
      const branch = branchOf(body.branch, reply); if (!branch) return reply;
      if (!body.bibtex || typeof body.bibtex !== 'string') return reply.code(400).send({ error: 'bibtex required' });
      if (body.bibtex.length > 100_000) return reply.code(413).send({ error: 'That BibTeX is too long for one reference.' });
      if (body.bibFile !== undefined && !validBibPath(body.bibFile)) return reply.code(400).send({ error: 'Choose a .bib file.' });
      try {
        const r = await insertReference(meta.id, branch, { bibtex: body.bibtex, key: body.key, bibFile: body.bibFile || undefined, loadBib: !!body.loadBib, force: !!body.force }, options(kit, meta));
        if (!r.duplicate) noteEdit(meta.id, branch, editorOf(kit.user(req)));
        return { ok: true, ...r };
      } catch (err) { return fail(reply, err); }
    });

    app.post<{ Params: { id: string }; Body: { branch?: string; bibFile?: string; entryHash?: string } }>('/api/projects/:id/references/remove', async (req, reply) => {
      const meta = await kit.requireMember(req, reply, 'remove references'); if (!meta) return reply;
      const body = req.body || {};
      const branch = branchOf(body.branch, reply); if (!branch) return reply;
      if (!body.bibFile || !validBibPath(body.bibFile) || !body.entryHash) return reply.code(400).send({ error: 'bibFile and entryHash required' });
      try {
        const r = await removeReference(meta.id, branch, body.bibFile, body.entryHash);
        noteEdit(meta.id, branch, editorOf(kit.user(req)));
        return { ok: true, ...r };
      } catch (err) { return fail(reply, err); }
    });
  },
};

export default feature;
