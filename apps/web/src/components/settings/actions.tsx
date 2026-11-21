/**
 * The settings page's actions with their confirmations and Undo toasts
 * (WP23): reset a row, a section or everything, apply an import, and the
 * "Keep this browser's" toast after a sign-in replaced this browser's values.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { AnySettingDef } from '../../settings/types';
import { defaultOf, getSetting, onSettingsConflict, resetSetting, setSetting, subscribeSetting } from '../../settings/store';
import { settingDef } from '../../settings/registry';
import { safeStorage } from '../../util/safeStorage';
import { useToast } from '../Toast';
import { useDialogs } from '../Dialogs';
import { applyValues, isChanged, namesText, resetDefs, restore, type ResetStore, type SnapshotEntry } from './reset';

/** The settings store, as reset.ts needs it. */
export const liveStore: ResetStore = {
  get: (id) => getSetting<unknown>(id),
  dflt: (def) => defaultOf(def),
  set: (id, v) => setSetting(id, v),
  reset: (id) => resetSetting(id),
  raw: (key) => safeStorage.get(key),
  writeRaw: (key, raw) => { if (raw === null) safeStorage.remove(key); else safeStorage.set(key, raw); },
};

/** How many of `defs` differ from their default, live. */
export function useChangedCount(defs: readonly AnySettingDef[]): number {
  const key = defs.map((d) => d.id).join('\n');
  const subscribe = useCallback((fn: () => void) => subscribeSetting(key ? key.split('\n') : [], fn), [key]);
  const read = () => defs.filter((d) => { try { return isChanged(d, liveStore); } catch { return false; } }).length;
  return useSyncExternalStore(subscribe, read, read);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace('#', String(n)));

export function useSettingsActions() {
  const toast = useToast();
  const dialogs = useDialogs();

  const offerUndo = useCallback((text: string, snap: SnapshotEntry[], testId: string) => {
    toast(text, 'ok', {
      label: 'Undo',
      testId,
      key: 'settings-undo',
      onClick: () => { restore(snap, liveStore); toast('Put back', 'ok'); },
    });
  }, [toast]);

  const resetRow = useCallback((def: AnySettingDef) => {
    const snap = resetDefs([def], liveStore);
    if (snap.length) offerUndo(`“${def.label}” is back to its default`, snap, 'settings-reset-undo');
  }, [offerUndo]);

  const resetSection = useCallback(async (title: string, defs: readonly AnySettingDef[]) => {
    const changed = defs.filter((d) => isChanged(d, liveStore));
    if (!changed.length) return;
    const ok = await dialogs.confirm({
      title: `Reset “${title}”?`,
      body: `${namesText(changed.map((d) => d.label))} ${changed.length === 1 ? 'goes' : 'go'} back to the default. You can undo this.`,
      confirmLabel: 'Reset section',
    });
    if (!ok) return;
    const snap = resetDefs(defs, liveStore);
    offerUndo(`${title}: ${plural(changed.length, '1 setting', '# settings')} back to the default`, snap, 'settings-reset-undo');
  }, [dialogs, offerUndo]);

  const resetAll = useCallback(async (defs: readonly AnySettingDef[], account: boolean) => {
    const changed = defs.filter((d) => isChanged(d, liveStore));
    if (!changed.length) { toast('Every setting is already at its default', 'info'); return; }
    const ok = await dialogs.confirm({
      title: 'Reset all settings?',
      body: `${account ? 'Resets your account’s settings on every device and this browser’s settings.' : 'Resets this browser’s settings.'} Your projects, name, connections and tokens are not touched. You can undo this.`,
      confirmLabel: 'Reset all',
      danger: true,
    });
    if (!ok) return;
    const snap = resetDefs(defs, liveStore);
    offerUndo(`${plural(changed.length, '1 setting', '# settings')} back to the default`, snap, 'settings-reset-undo');
  }, [dialogs, offerUndo, toast]);

  const applyImport = useCallback((changes: readonly { def: AnySettingDef; to: unknown }[]) => {
    const snap = applyValues(changes, liveStore);
    offerUndo(`Imported ${plural(changes.length, '1 setting', '# settings')}`, snap, 'settings-import-undo');
  }, [offerUndo]);

  return { resetRow, resetSection, resetAll, applyImport };
}

/**
 * After a sign-in the account's values replaced some of this browser's: say
 * which, and offer to keep this browser's (settings/sync.ts keeps them).
 * The settings page mounts it; the app can mount it once for every page
 * (docs/galley-v2/WP23.md R1). A second toast replaces the first.
 */
export function useSettingsConflictToast(): void {
  const toast = useToast();
  useEffect(() => {
    try {
      return onSettingsConflict((c) => {
        const names = namesText(c.ids.map((id) => settingDef(id)?.label ?? id));
        toast(`Your account’s settings replaced this browser’s (${names}).`, 'info', {
          label: 'Keep this browser’s',
          testId: 'settings-keep-browser',
          key: 'settings-conflict',
          sticky: true,
          onClick: () => c.keepBrowser(),
        });
      });
    } catch {
      return undefined;
    }
  }, [toast]);
}

/** useSettingsConflictToast as an element, for main.tsx inside the ToastProvider (WP23 R1). */
export function SettingsConflictToast(): null {
  useSettingsConflictToast();
  return null;
}
