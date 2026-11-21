import type { FeatureModule } from '../types';
import { bindPluginPage, showPluginPanel } from '../../plugins/host';
import { citeTrackExtension } from './citeTrack';
import { onlineCiteSource } from './onlineSource';
import { REFERENCES_SETTING } from './settings';

/**
 * F9 online BibTeX, web half (WP22). The References panel itself is the
 * `references` plugin (plugins/references), which searches, previews and adds
 * through WP16's routes. This module gives it what a plugin cannot reach on
 * its own: the editor page (for Undo of the \cite and toasts with an action,
 * through plugins/host.ts), the range tracking that Undo uses, and the
 * "Search online for …" item in citation completion.
 */
const feature: FeatureModule = {
  id: 'references',
  editor: {
    extension: () => citeTrackExtension(),
    completionSources: [
      (ctx) => onlineCiteSource({
        enabled: () => ctx.setting<boolean>(REFERENCES_SETTING.online) !== false
          && ctx.setting<boolean>(REFERENCES_SETTING.completionSearch) !== false,
        open: (query) => showPluginPanel(ctx.page(), 'references', query),
      }),
    ],
  },
  activate: (page) => bindPluginPage(page),
};

export default feature;
