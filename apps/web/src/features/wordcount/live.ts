/**
 * The open file's text and selection for the live word count (WP27): after
 * a pause in typing or selecting, the editor reports them to the store,
 * which splices the file into the server's breakdown. Edits from
 * collaborators are counted the same way; nothing here changes the document.
 */
import { ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { getSetting } from '../../settings/store';
import type { EditorFeatureCtx } from '../types';
import { reportLive, SHOW_SETTING } from './store';

/** After this pause the open file is counted again (V1 used 350 ms). */
const RECOUNT_MS = 300;
/** Above this size the pause is longer: a full re-scan of a long thesis takes about 10 ms. */
const LONG_DOC = 512 * 1024;
const RECOUNT_LONG_MS = 1000;

export function liveCountExtension(ctx: EditorFeatureCtx): Extension {
  return ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let first = true;
    const report = () => {
      timer = null;
      if (getSetting<boolean>(SHOW_SETTING) === false) return;
      const s = view.state;
      const sel = s.selection.main;
      reportLive(ctx.projectId, ctx.branch, ctx.filePath, s.doc.toString(), sel.empty ? null : s.sliceDoc(sel.from, sel.to));
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(report, view.state.doc.length > LONG_DOC ? RECOUNT_LONG_MS : RECOUNT_MS);
    };
    schedule();
    return {
      update(u: ViewUpdate) {
        if (!u.docChanged && !u.selectionSet) return;
        // The collab doc's first sync is counted at once.
        if (u.docChanged && first) { first = false; if (timer) clearTimeout(timer); report(); return; }
        schedule();
      },
      destroy() { if (timer) clearTimeout(timer); },
    };
  });
}
