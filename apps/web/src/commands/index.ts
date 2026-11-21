/**
 * The command adapter (WP04 input-core): turns CommandDefs (features' and the
 * page's own) into the command palette's rows, and `palette: true` switches
 * into "Turn X on/off" commands.
 */
import type { Command, CommandDef } from './types';
import type { AnySettingDef } from '../settings/types';
import { CORE_SETTING_IDS } from '../settings/types';
import type { EditorPageCtx } from '../features/types';
import { chordLabel } from '../keys/registry';
import { getSetting, setSetting } from '../settings/store';

/** Settings that already have a hand-written palette toggle in Editor.tsx
 *  (setting id → its command id). settingToggleCommands skips them, so the
 *  palette never lists the same switch twice. */
export const EXISTING_TOGGLE_COMMANDS: Readonly<Record<string, string>> = {
  [CORE_SETTING_IDS.vim]: 'vim',
  [CORE_SETTING_IDS.spellcheck]: 'spell',
  [CORE_SETTING_IDS.autoTypeset]: 'auto',
  [CORE_SETTING_IDS.draftTypeset]: 'draft-typeset',
  [CORE_SETTING_IDS.changeMarks]: 'change-marks',
  [CORE_SETTING_IDS.agentPresence]: 'experimental-agent',
};

/** The palette group of the generated setting toggles. */
export const SETTINGS_GROUP = 'Settings';

/** First words a label keeps capitalised mid-sentence. */
const PROPER = new Set(['Vim', 'Zotero', 'Mendeley', 'Claude', 'ChatGPT', 'Git', 'GitHub', 'GitLab', 'TeX', 'LaTeX', 'SyncTeX', 'KaTeX', 'MathLive', 'Unicode', 'Markdown', 'Laytekz', 'Overleaf', 'Windows', 'English']);

/** "Line numbers" → "line numbers", so the title reads as one sentence; "PDF …" and "Vim …" stay. */
function midSentence(label: string): string {
  const first = label.split(/\s/, 1)[0];
  return /^[A-Z][a-z]+$/.test(first) && !PROPER.has(first) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

function listed(def: CommandDef, o: { page: EditorPageCtx | null; showcase: boolean; viewer: boolean }): boolean {
  if (o.showcase && def.refusedFor?.includes('showcase')) return false;
  if (o.viewer && def.refusedFor?.includes('viewer')) return false;
  if (!def.when) return true;
  // A row that depends on the editor page has nothing to ask without one.
  if (!o.page) return false;
  try {
    return !!def.when(o.page);
  } catch (err) {
    console.warn(`Command ${def.id} hidden: its when() threw`, err);
    return false;
  }
}

/** Palette rows for `defs`: drops a row refused for this role or whose
 *  `when` is false, and fills `hint` from its keybinding's chord. */
export function paletteCommands(defs: readonly CommandDef[], o: { page: EditorPageCtx | null; showcase: boolean; viewer: boolean }): Command[] {
  const out: Command[] = [];
  for (const def of defs) {
    if (!listed(def, o)) continue;
    // A binding someone cleared shows no keys rather than a stale static hint.
    const hint = def.keybinding ? chordLabel(def.keybinding) || undefined : def.hint;
    out.push({
      id: def.id,
      title: def.title,
      run: def.run,
      ...(hint ? { hint } : {}),
      ...(def.group !== undefined ? { group: def.group } : {}),
      ...(def.keywords !== undefined ? { keywords: def.keywords } : {}),
    });
  }
  return out;
}

/** "Turn <label> on/off" for every `palette: true` switch, under the ids
 *  'setting.<id>' (existing command ids such as 'vim' and 'spell' stay as
 *  they are and are not duplicated). Titles read the value at call time: the
 *  page rebuilds the list when the settings change (subscribeSetting). */
export function settingToggleCommands(defs: Iterable<AnySettingDef>): CommandDef[] {
  const out: CommandDef[] = [];
  for (const def of defs) {
    if (!def.palette || def.control?.kind !== 'switch' || def.scope === 'project') continue;
    if (Object.prototype.hasOwnProperty.call(EXISTING_TOGGLE_COMMANDS, def.id)) continue;
    let on: boolean;
    try {
      // A row whose switch is disabled (dependsOn off) has no toggle either.
      if (def.dependsOn && getSetting<unknown>(def.dependsOn) === false) continue;
      on = getSetting<unknown>(def.id) === true;
    } catch (err) {
      console.warn(`Setting ${def.id} has no palette toggle: its value could not be read`, err);
      continue;
    }
    const id = def.id;
    out.push({
      id: `setting.${id}`,
      group: SETTINGS_GROUP,
      title: `Turn ${midSentence(def.label)} ${on ? 'off' : 'on'}`,
      keywords: [def.keywords, 'setting', 'toggle', def.section].filter(Boolean).join(' '),
      run: () => {
        try { setSetting<boolean>(id, getSetting<unknown>(id) !== true); } catch (err) { console.warn(`Setting ${id} could not be changed`, err); }
      },
    });
  }
  return out;
}
