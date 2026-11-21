import type { AnySettingDef } from '../../settings/types';

/**
 * The '_probe.*' settings (WP06). Pure data: import types only, never the
 * store or UI code. Device scope (README D6) and never listed: only the
 * probe's automatic edit reads it, and the probe runs in e2e specs alone.
 */
export const settings: readonly AnySettingDef[] = [{
  id: '_probe.autoEdit',
  section: 'labs',
  label: 'Probe automatic edit (tests only)',
  scope: 'device',
  default: true,
  validate: (v: unknown): v is boolean => typeof v === 'boolean',
  control: { kind: 'switch' },
  visible: () => false,
}];
