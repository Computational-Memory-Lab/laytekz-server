import type { ServerFeature } from '../types.js';
import { BRANCH_RE } from '../../util.js';
import { bibIndex } from '../../indexes.js';
import { validRule } from '../../wordcount/validate.js';
import { RULE_SETTING, documentWordCount } from '../../wordcount/count.js';

/**
 * F13 word count, server side (WP24): the project rule as a project setting
 * (`wordcount.rule`, members may change it, copied with the project) and the
 * full breakdown under the rule in force:
 * GET /api/projects/:id/wordcount/breakdown?branch=main.
 * The older GET /api/projects/:id/wordcount and the MCP tool answer the same
 * count once requests R1 and R2 (docs/galley-v2/WP24.md) land.
 */
const feature: ServerFeature = {
  id: 'wordcount',
  projectSettings: [
    { id: RULE_SETTING, validate: validRule, clientWritable: true, clientVisible: true, copyWithProject: true },
  ],
  register(app, kit) {
    app.get<{ Params: { id: string }; Querystring: { branch?: string } }>('/api/projects/:id/wordcount/breakdown', async (req, reply) => {
      const meta = await kit.requireAccess(req, reply);
      if (!meta) return;
      const branch = typeof req.query.branch === 'string' && req.query.branch ? req.query.branch : 'main';
      if (!BRANCH_RE.test(branch) || branch.includes('..')) return reply.code(400).send({ error: 'bad branch name' });
      try {
        return await documentWordCount(meta.id, branch, kit.user(req)?.id ?? null, bibIndex);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return reply.code(404).send({ error: 'branch not found' });
        throw err;
      }
    });
  },
};

export default feature;
