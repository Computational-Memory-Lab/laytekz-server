import { IconBookmark } from '../../components/Icons';
import type { EditorPageCtx, FeatureModule } from '../types';
import { linkedBibReason } from './model';
import RenamedNotice from './RenamedNotice';
import { addRenames, LIBRARIES_EVENT, linksFor, refreshLinks, type LibrariesEventDetail } from './store';

/**
 * F8 reference-manager libraries, F20 their tabs on the sidebar's main row (WP36).
 *
 * The panels themselves are the `zotero` plugin's (plugins/zotero: a Zotero
 * tab, pinned by the page's PINNED_PANELS, and a Mendeley tab, pinned here).
 * This module makes every linked .bib read-only under a banner, shows the
 * renamed-key notice with "Update citations", and keeps the list of links the
 * read-only rule reads.
 */

/** filesChanged fires on each tree load: re-read the links at most this often for it. */
const FILES_REFRESH_MS = 5000;

function activate(page: EditorPageCtx): () => void {
  const { projectId, branch } = page;
  let lastFilesRefresh = 0;
  let disposed = false;

  const refresh = async () => {
    const path = page.activeFile();
    const before = linkedBibReason(linksFor(projectId), path);
    const changed = await refreshLinks(projectId);
    if (disposed || !changed) return;
    // The page re-reads read-only rules when it renders: make it render when the open file's answer changed.
    if (linkedBibReason(linksFor(projectId), page.activeFile()) !== before) void page.refreshProject().catch(() => {});
  };

  const onEvent = (e: Event) => {
    const d = (e as CustomEvent<LibrariesEventDetail>).detail;
    if (!d || d.projectId !== projectId) return;
    if (d.type === 'renamed' && (!d.branch || d.branch === branch)) addRenames(projectId, branch, d.provider ?? 'zotero', d.linkId ?? null, d.renames);
    void refresh();
  };
  window.addEventListener(LIBRARIES_EVENT, onEvent);
  const offs = [
    page.events.on('projectChanged', () => { void refresh(); }),
    page.events.on('filesChanged', () => {
      const now = Date.now();
      if (now - lastFilesRefresh < FILES_REFRESH_MS) return;
      lastFilesRefresh = now;
      void refresh();
    }),
  ];
  void refresh();
  return () => {
    disposed = true;
    window.removeEventListener(LIBRARIES_EVENT, onEvent);
    for (const off of offs) off();
  };
}

const feature: FeatureModule = {
  id: 'libraries',
  // The plugin registers the Mendeley panel; this puts it on the main row after Zotero (200).
  pinnedPanels: [{ id: 'plugin:mendeley', title: 'Mendeley', icon: IconBookmark, order: 210 }],
  readOnlyRules: [{ id: 'libraries.linkedBib', reason: (path, page) => linkedBibReason(linksFor(page.projectId), path) }],
  slots: [{ id: 'libraries.renamedNotice', slot: 'editor.banners', order: 300, render: RenamedNotice }],
  activate,
};

export default feature;
