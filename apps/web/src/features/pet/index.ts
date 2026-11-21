import type { CommandDef } from '../../commands/types';
import type { EditorPageCtx, FeatureModule } from '../types';
import { getCapabilities } from '../../settings/capabilities';
import { getSetting, setSetting } from '../../settings/store';
import { awayUntil, comeBack, sendPetAway } from './away';
import { PET_IDS, petAvailable } from './engine/prefs';
import PetSlot from './PetSlot';

/**
 * F14 desk pet (WP44 pet-runtime; engine: WP39; roaming: PET2). Off by
 * default, and nothing at all on a server without a pet image. When on, it
 * hops around the editor window from the `editor.overlay` slot, rides the
 * PDF and the source as they scroll, reacts to the mouse, typing and
 * typesets, and squeaks when clicked. Only this person sees and hears it:
 * nothing reaches the document, awareness or the project.
 *
 * Palette (group View): turn it on or off, hide it for an hour or bring it
 * back, and open its settings. The pet itself takes no focus, so these keep
 * every action reachable from the keyboard.
 */

const GROUP = 'View';

function available(): boolean {
  try { return petAvailable({ capabilities: getCapabilities() }); } catch { return false; }
}

function isOn(): boolean {
  try { return getSetting<unknown>(PET_IDS.on) === true; } catch { return false; }
}

function commands(page: EditorPageCtx): CommandDef[] {
  if (!available()) return [];
  const on = isOn();
  const away = awayUntil() !== null;
  const out: CommandDef[] = [{
    // The id settingToggleCommands would give 'pet.on' (settings.ts turns that generic row off).
    id: `setting.${PET_IDS.on}`,
    group: GROUP,
    title: on ? 'Turn the desk pet off' : 'Turn the desk pet on',
    keywords: 'pet companion mascot setting toggle',
    run: () => { try { setSetting<boolean>(PET_IDS.on, !isOn()); } catch (err) { console.warn('[laytekz] the desk pet setting could not be changed', err); } },
  }];
  if (on && !away) out.push({ id: 'pet.away', group: GROUP, title: 'Hide the desk pet for an hour', keywords: 'pet away later', run: () => { sendPetAway(page.toast); } });
  if (on && away) out.push({ id: 'pet.back', group: GROUP, title: 'Bring the desk pet back', keywords: 'pet away return', run: comeBack });
  out.push({ id: 'pet.settings', group: GROUP, title: 'Desk pet settings…', keywords: 'pet companion preferences', run: () => page.openSettings({ section: 'pet' }) });
  return out;
}

const feature: FeatureModule = {
  id: 'pet',
  commands,
  slots: [{ id: 'pet.desk', slot: 'editor.overlay', order: 100, render: PetSlot }],
};

export default feature;
