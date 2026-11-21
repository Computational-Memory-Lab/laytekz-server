import fs from 'node:fs';
import type { ServerFeature } from '../types.js';
import { compileStatus, synctexRunId } from '../../compile.js';
import { isOutputPath } from '../../output-signing.js';
import { branchDir } from '../../store.js';
import { BRANCH_RE, safeJoin } from '../../util.js';

/** A SyncTeX file past this is a thesis the preview would not parse anyway (the client caps the text at 50 MB). */
export const MAX_SYNCTEX_BYTES = 32 * 1024 * 1024;

/** The header that names the run a SyncTeX file belongs to; the client uses the file only when it equals the compileId of the PDF it shows. */
export const SYNCTEX_RUN_HEADER = 'x-synctex-run';
/** The file's path relative to the branch directory, URI-encoded: its folder is the root file's, which the SyncTeX inputs are relative to. */
export const SYNCTEX_PATH_HEADER = 'x-synctex-path';

/**
 * F3 formula preview, server side (WP21). `GET /api/projects/:id/output/synctex`
 * sends the SyncTeX file of the branch's last typeset, gzipped as the compiler
 * wrote it, with `x-synctex-run` set to the compileId of the run that wrote
 * it. While a typeset of the branch runs, or when no run is known (after a
 * restart, or after a clean), it answers 409: the file on disk may then be
 * another run's, and a wrong crop is worse than none. A read: viewers and
 * bearer tokens may call it, as they may fetch the PDF.
 */
const feature: ServerFeature = {
  id: 'mathPreview',
  register(app, kit) {
    app.get<{ Params: { id: string }; Querystring: { branch?: string } }>('/api/projects/:id/output/synctex', async (req, reply) => {
      const meta = await kit.requireAccess(req, reply);
      if (!meta) return;
      const branch = req.query.branch || 'main';
      if (!BRANCH_RE.test(branch) || branch.includes('..')) return reply.code(400).send({ error: 'invalid branch name' });
      reply.header('cache-control', 'no-store');
      const busy = () => compileStatus(meta.id, branch).running;
      const run = synctexRunId(meta.id, branch);
      if (!run || busy()) return reply.code(409).send({ error: 'No SyncTeX file for the PDF on screen. Typeset to make one.' });
      if (!isOutputPath(run.path)) return reply.code(404).send({ error: 'artifact not found' });
      let bytes: Buffer;
      try {
        const abs = safeJoin(branchDir(meta.id, branch), run.path);
        const st = await fs.promises.stat(abs);
        if (st.size > MAX_SYNCTEX_BYTES) return reply.code(413).send({ error: 'This SyncTeX file is too large to preview from.' });
        bytes = await fs.promises.readFile(abs);
      } catch {
        return reply.code(404).send({ error: 'artifact not found' });
      }
      // A typeset that started or finished while the file was read may have rewritten it.
      const after = synctexRunId(meta.id, branch);
      if (!after || after.id !== run.id || after.path !== run.path || busy()) {
        return reply.code(409).send({ error: 'A typeset changed the SyncTeX file. Try again.' });
      }
      return reply
        .header(SYNCTEX_RUN_HEADER, String(run.id))
        .header(SYNCTEX_PATH_HEADER, encodeURIComponent(run.path))
        .header('x-content-type-options', 'nosniff')
        .type('application/gzip')
        .send(bytes);
    });
  },
};

export default feature;
