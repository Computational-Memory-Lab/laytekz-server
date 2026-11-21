import type { AnySettingDef } from '../../settings/types';

/** The 'libraries.*' settings (WP36). Pure data: import types only, never the store or UI code. */
export const LIBRARIES_SETTING = {
  syncOnOpen: 'libraries.syncOnOpen',
  connections: 'libraries.connections',
} as const;

const KEYWORDS = 'zotero mendeley library libraries reference manager bibliography bib sync link';

export const settings: readonly AnySettingDef[] = [
  {
    id: LIBRARIES_SETTING.syncOnOpen,
    section: 'references',
    label: 'Sync linked libraries when a project opens',
    hint: 'A Zotero or Mendeley library linked to the project is synced into its .bib when you open the project and the last sync is more than an hour old. Off: only Sync now does it.',
    keywords: `${KEYWORDS} automatic stale hour`,
    scope: 'account',
    default: true,
    validate: (v: unknown): v is boolean => typeof v === 'boolean',
    control: { kind: 'switch' },
    automatic: true,
    order: 40,
    palette: true,
  },
  {
    id: LIBRARIES_SETTING.connections,
    section: 'connections',
    label: 'Reference managers',
    hint: 'Connect Mendeley to link its folders to your projects. The connection belongs to your account, so it works in the desktop app too.',
    keywords: `${KEYWORDS} connect sign in oauth disconnect`,
    // A row of buttons with no value of its own: device scope, never written.
    scope: 'device',
    default: null,
    validate: (v: unknown): v is null => v === null,
    control: { kind: 'custom', load: () => import('./ConnectionsControl') },
    order: 60,
  },
];
