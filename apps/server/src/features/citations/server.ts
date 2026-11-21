import type { ServerFeature } from '../types.js';
import { citeSetup } from '../../indexes.js';
import { BRANCH_RE } from '../../util.js';

/**
 * F17 citations, server side (WP15). `GET /api/projects/:id/cite-setup`
 * answers which citation family the document uses (biblatex, natbib, apacite
 * or plain BibTeX, from the apa7 class options or the packages), whether
 * cleveref, hyperref, amsmath, varioref and nameref are loaded, and which
 * .bib files it reads (citesetup.ts). The citation picker and
 * `insertCitation` read it. A read: viewers and bearer tokens may call it.
 * `?root=` asks about another root file; the project's root by default.
 */
const feature: ServerFeature = {
  id: 'citations',
  register(app, kit) {
    app.get<{ Params: { id: string }; Querystring: { branch?: string; root?: string } }>('/api/projects/:id/cite-setup', async (req, reply) => {
      const meta = await kit.requireAccess(req, reply);
      if (!meta) return;
      const branch = req.query.branch || 'main';
      if (!BRANCH_RE.test(branch) || branch.includes('..')) return reply.code(400).send({ error: 'invalid branch name' });
      const root = typeof req.query.root === 'string' && /^[^\\\0]{1,500}\.tex$/.test(req.query.root) && !req.query.root.split('/').includes('..')
        ? req.query.root : meta.rootFile || 'main.tex';
      return citeSetup(meta.id, branch, root);
    });
  },
};

export default feature;
