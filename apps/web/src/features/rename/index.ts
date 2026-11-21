import type { FeatureModule } from '../types';
import { getSetting, setSetting } from '../../settings/store';
import { fileSpots } from '../../editor/fileSpots';
import { docNameOf } from '../../editor/core/hooks';
import { renameClient } from './client';
import { followPeers, interceptFileRename, interceptProjectRename, type RenameDeps } from './flow';

/**
 * F10 reference-aware rename, web side (WP29). Renaming or moving a file asks
 * the server what else would change (WP28's plan); when other files refer to
 * it, or files beside the main document share its name, a preview lists the
 * changes to confirm and applies them as one commit with an Undo. Renaming
 * the project offers to change a \title that still holds the old name.
 * Collaborators follow the renamed file (WP06) and are told who renamed it.
 * The dialog's code loads on first use.
 */
const deps: RenameDeps = {
  client: renameClient,
  setting: getSetting,
  setSetting,
  preview: (plan, o) => import('./RenamePreview').then((m) => m.openRenamePreview(plan, o)),
  now: () => Date.now(),
};

const feature: FeatureModule = {
  id: 'rename',
  interceptors: {
    fileRename: (r, page) => interceptFileRename(r, page, deps),
    projectRename: (r, page) => interceptProjectRename(r, page, deps),
  },
  activate(page) {
    return followPeers(page, deps, fileSpots, (path) => docNameOf(page.projectId, page.branch, path));
  },
};

export default feature;
