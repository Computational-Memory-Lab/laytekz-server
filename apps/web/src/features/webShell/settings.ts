import type { AnySettingDef } from '../../settings/types';

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** The 'webShell.*' settings (WP45). Pure data: import types only, never the store or UI code. */
export const settings: readonly AnySettingDef[] = [
  {
    id: 'webShell.updateNotice',
    section: 'appearance',
    label: 'Say when Laytekz has been updated',
    hint: 'After a new version is installed on the server, a message offers to reload the page. Nothing reloads by itself.',
    keywords: 'update new version reload deploy notice',
    scope: 'device',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    order: 900,
  },
];
