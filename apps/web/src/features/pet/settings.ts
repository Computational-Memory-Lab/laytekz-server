import type { AnySettingDef } from '../../settings/types';
import { PET_IDS, PET_SETTINGS } from './engine/prefs';

/**
 * The 'pet.*' settings (WP44 pet-runtime; definitions: engine/prefs.ts,
 * WP39 and PET2). Pure data.
 *
 * Two changes to the engine's definitions:
 * - 'pet.on' has no generic "Turn … on/off" palette row: that row would be
 *   listed on servers without a pet image too (settingToggleCommands does not
 *   ask `visible`). index.ts adds the same row, under the same id
 *   'setting.pet.on', only when the server offers a pet.
 * - Its hint says what reduced motion does to the pet while the system (or
 *   the "Reduce motion" setting) asks for it.
 */
const STILL = 'Reduced motion is on, so the pet sits still in one spot. It still squeaks when clicked.';

function reducedMotionNow(): boolean {
  try {
    if (typeof document !== 'undefined' && document.documentElement?.dataset?.motion === 'reduce') return true;
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export const settings: readonly AnySettingDef[] = PET_SETTINGS.map((d): AnySettingDef => {
  if (d.id !== PET_IDS.on) return d;
  const base = typeof d.hint === 'string' ? d.hint : '';
  return { ...d, palette: false, hint: () => (reducedMotionNow() ? `${base} ${STILL}`.trim() : base) };
});
