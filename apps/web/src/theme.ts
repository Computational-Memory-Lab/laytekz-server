import { useSyncExternalStore } from 'react';
// Galley: the appearance is the settings store's `appearance.theme` (V2,
// WP02): one storage listener for every setting, and the account keeps the
// choice. The key, its values and this module's exports are unchanged.
import { getSetting, setSetting, startLocalSettings, subscribeSetting } from './settings/store';
import { CORE_SETTING_IDS } from './settings/types';
import { parseAppearance as parseStored, type Appearance } from './settings/codecs';
import { darkMedia, paintTheme, resolveTheme, systemIsDark, THEME_COLOR, type Theme } from './settings/apply';

/** What is drawn: `data-theme` on <html>. "system" in Appearance follows the
 *  operating system's setting. */
export type { Theme, Appearance };

export const THEME_KEY = 'aldine.theme';

/** Each theme's --bg-app, for the browser's own chrome. The pre-paint script
 *  in index.html repeats these two values and the rules below. */
export { THEME_COLOR, resolveTheme };

export const APPEARANCES: readonly { id: Appearance; label: string }[] = [
  { id: 'system', label: 'Match system' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/** Galley: the default follows the operating system: nothing stored, or anything
 *  unknown, is "system" (upstream defaulted to dark). */
export function parseAppearance(raw: string | null | undefined): Appearance {
  return parseStored(raw);
}

/** The explicit choice a light/dark switch makes from what is on screen. */
export function toggled(current: Theme): Theme {
  return current === 'dark' ? 'light' : 'dark';
}

const ID = CORE_SETTING_IDS.theme;

export function getAppearance(): Appearance {
  return getSetting<Appearance | undefined>(ID) ?? 'system';
}

export function getTheme(): Theme {
  return resolveTheme(getAppearance(), systemIsDark());
}

export function setAppearance(next: Appearance): void {
  // Painted first, with its cross-fade: the store's own repaint then finds it done.
  paintTheme(resolveTheme(next, systemIsDark()), true);
  setSetting(ID, next);
}

/** An explicit light or dark choice. */
export function setTheme(t: Theme): void {
  setAppearance(t);
}

export function toggleTheme(): Theme {
  const next = toggled(getTheme());
  setAppearance(next);
  return next;
}

/**
 * Keeps the page on the chosen appearance after first paint: follows the
 * system while the choice is "system", and follows a choice made in another
 * tab or, once startSettings runs, on another device. Called once at startup.
 */
export function startThemeSync(): void {
  startLocalSettings();
}

/** The choice, and the system's dark mode while following it. */
function subscribe(l: () => void) {
  const off = subscribeSetting(ID, l);
  const media = darkMedia();
  media?.addEventListener('change', l);
  return () => { off(); media?.removeEventListener('change', l); };
}

/** The stored choice, live across changes from anywhere. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, getAppearance, getAppearance);
}

/** What is on screen, live across a system switch while following it. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}
