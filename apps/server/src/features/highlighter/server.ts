import fs from 'node:fs';
import type * as Y from 'yjs';
import type { ServerFeature } from '../types.js';
import { docName, hocuspocus } from '../../collab.js';
import { branchDir, listFiles } from '../../store.js';
import { ensureWorktree } from '../../gitops.js';
import { config } from '../../config.js';
import { isHiddenPath, safeJoin } from '../../util.js';
import { diffSpans } from '../../textdiff.js';
import { LIST_MAX, listHighlights, scratchFromSnapshot, snapshotPath, tidyHighlights, type ListedHighlight } from './highlights.js';

/**
 * F15 highlighter, server side (WP32): every doc's highlights are tidied when
 * it loads (malformed and collapsed entries removed, the newest 5,000 kept),
 * and GET /api/projects/:id/highlights?branch= lists a branch's highlights by
 * file for anyone who can open the project (a read, so viewers too).
 * Highlights are written by clients through the doc itself; a change that
 * touches only them is not an edit (collab.ts records none).
 */
function diskTextLF(projectId: string, branch: string, rel: string): string | null {
  try { return fs.readFileSync(safeJoin(branchDir(projectId, branch), rel), 'utf8').replace(/\r\n?/g, '\n'); } catch { return null; }
}

const feature: ServerFeature = {
  id: 'highlighter',
  onDocLoad(doc) {
    const removed = tidyHighlights(doc);
    if (removed) console.log(`[highlighter] tidied ${removed} highlight entr${removed === 1 ? 'y' : 'ies'} on load`);
  },
  register(app, kit) {
    app.get<{ Params: { id: string }; Querystring: { branch?: string } }>('/api/projects/:id/highlights', async (req, reply) => {
      const meta = await kit.requireAccess(req, reply);
      if (!meta) return;
      const branch = typeof req.query.branch === 'string' && req.query.branch ? req.query.branch : 'main';
      try { await ensureWorktree(meta.id, branch); } catch { return reply.code(404).send({ error: 'Project or branch not found' }); }
      const files: Array<{ path: string; highlights: ListedHighlight[] }> = [];
      let count = 0;
      let truncated = false;
      for (const f of listFiles(meta.id, branch)) {
        if (f.type !== 'file' || f.binary || isHiddenPath(f.path)) continue;
        const name = docName(meta.id, branch, f.path);
        const live = hocuspocus.documents.get(name) as unknown as Y.Doc | undefined;
        let doc: Y.Doc | null = live ?? null;
        let scratch: Y.Doc | null = null;
        if (!doc) {
          const snap = snapshotPath(config.metaRoot, name);
          if (!fs.existsSync(snap)) continue;
          scratch = scratchFromSnapshot(snap, diskTextLF(meta.id, branch, f.path), diffSpans);
          doc = scratch;
        }
        if (!doc) continue;
        try {
          let list = listHighlights(doc);
          if (!list.length) continue;
          if (count + list.length > LIST_MAX) { list = list.slice(0, LIST_MAX - count); truncated = true; }
          count += list.length;
          if (list.length) files.push({ path: f.path, highlights: list });
        } finally {
          scratch?.destroy();
        }
        if (truncated) break;
      }
      return { files, truncated };
    });
  },
};

export default feature;
