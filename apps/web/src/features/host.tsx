/**
 * The page host's runtime (WP06 page-host): the app context features get on
 * every page, the installed feature modules, the bridge that turns
 * `openSettings()` into a route, and the page-scope keybindings.
 *
 * main.tsx imports this file, so it must stay light: it never imports
 * features/manifest.ts statically. A feature module may pull in CodeMirror,
 * which belongs in the editor's chunk; the editor page installs the manifest
 * itself (installFeatures), every other page loads it on demand (loadFeatures).
 */
import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import { useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import type { AuthUser } from '../api';
import { withBase } from '../basePath';
import { useAuth } from '../components/Auth';
import { useToast, type ToastAction } from '../components/Toast';
import { bindingFor, registerKeybindings } from '../keys/registry';
import type { KeybindingDef, KeyScope } from '../keys/types';
import { DEFAULT_CAPABILITIES, getCapabilities, loadCapabilities } from '../settings/capabilities';
import { openSettings as storeOpenSettings } from '../settings/store';
import { OPEN_SETTINGS_EVENT, type SettingsTarget } from '../settings/types';
import { isDesktop } from '../util/desktop';
import { bootFeatures, enabledModules, isSettingsPath, probeEnabled, projectPathOf, settingsHref } from './pageCtx';
import type { AppCtx, EditorPageCtx, FeatureModule, Notify, PageEvents } from './types';

const warn = (what: string, err: unknown) => console.warn(`[laytekz] ${what}`, err);

// ---- The app context ----

type ToastFn = (text: string, kind?: 'info' | 'ok' | 'error', action?: ToastAction) => void;

const live: { user: AuthUser | null; toast: ToastFn | null } = { user: null, toast: null };
/** Toasts asked for before the toast host mounted (a feature's boot). */
const early: Parameters<Notify>[] = [];

function desktopShell(): boolean {
  try { return isDesktop(); } catch { return false; }
}

function showToast(...[text, kind, action]: Parameters<Notify>): void {
  const toast = live.toast;
  if (!toast) { early.push([text, kind, action]); return; }
  toast(text, kind, action ? { label: action.label, onClick: () => action.run() } : undefined);
}

/** One per tab: what `boot(app)` and every slot item get. */
export const appCtx: AppCtx = Object.freeze({
  user: () => live.user,
  capabilities: () => {
    try { return getCapabilities(); } catch { return DEFAULT_CAPABILITIES; }
  },
  desktop: desktopShell(),
  openSettings: (t?: SettingsTarget) => requestOpenSettings(t),
  toast: showToast as Notify,
});

/** Keeps appCtx's user and toast current. Render it inside AuthProvider and ToastProvider, before the routes. */
export function AppBridge(): null {
  const { authEnabled, user } = useAuth();
  const toast = useToast();
  // During render, so the pages below read the signed-in user on their first render too.
  live.user = authEnabled ? user : null;
  const userId = authEnabled ? user?.id ?? null : null;
  useEffect(() => {
    live.toast = toast;
    for (const args of early.splice(0)) showToast(...args);
    return () => { if (live.toast === toast) live.toast = null; };
  }, [toast]);
  useEffect(() => {
    try { void loadCapabilities(); } catch { /* the settings client is not there: the defaults stand */ }
  }, [userId]);
  return null;
}

// ---- The settings page ----

/** Opens the settings page (OPEN_SETTINGS_EVENT, which OpenSettingsBridge turns into a route). */
export function requestOpenSettings(t?: SettingsTarget): void {
  try {
    storeOpenSettings(t);
    return;
  } catch { /* no settings store: dispatch the same event here */ }
  const ev = new CustomEvent<SettingsTarget | null>(OPEN_SETTINGS_EVENT, { detail: t ?? null, cancelable: true });
  if (window.dispatchEvent(ev)) window.location.assign(withBase(settingsHref(t, null)));
}

const historyIdx = (): number | null => {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' ? idx : null;
};

/** The history entry the settings page was opened from, to go back to on close. */
let settingsReturn: { idx: number; page: string } | null = null;

/**
 * Handles OPEN_SETTINGS_EVENT (from openSettings(), a feature, or the
 * desktop shell's Settings… menu): over the open project's editor when there
 * is one (the same element, so the editor is not remounted), else /settings.
 * Calling preventDefault tells the dispatcher it was handled.
 */
export function OpenSettingsBridge(): null {
  const navigate = useNavigate();
  const location = useLocation();
  const where = useRef(location);
  where.current = location;
  useEffect(() => {
    const onOpen = (e: Event) => {
      const t = (e as CustomEvent<SettingsTarget | null>).detail ?? undefined;
      const loc = where.current;
      const project = projectPathOf(loc.pathname);
      const inSettings = isSettingsPath(loc.pathname);
      if (!inSettings) {
        const idx = historyIdx();
        settingsReturn = idx === null ? null : { idx, page: project ?? '/' };
      }
      e.preventDefault();
      navigate(settingsHref(t, project, loc.search), { replace: inSettings });
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }, [navigate]);
  return null;
}

/**
 * Leaves the settings page for the page under it (`page`: '/p/<id>' or '/'):
 * back through the history to the entry it was opened from when there is
 * one, so Back afterwards does not return to settings; else to `page` in place.
 */
export function closeSettings(navigate: NavigateFunction, page: string, search = ''): void {
  const back = settingsReturn;
  settingsReturn = null;
  const idx = historyIdx();
  if (back && idx !== null && back.idx < idx && back.page === page) {
    navigate(back.idx - idx);
    return;
  }
  navigate(`${page}${search}`, { replace: true });
}

// ---- The feature modules ----

let installed: readonly FeatureModule[] | null = null;
const NONE: readonly FeatureModule[] = [];
const subscribers = new Set<() => void>();

/**
 * Installs the manifest once per tab: drops `_probe` unless asked for,
 * registers every module's keybindings and runs every `boot(app)`. Returns
 * the modules that run. Idempotent: later calls return the first result.
 */
export function installFeatures(all: readonly FeatureModule[]): readonly FeatureModule[] {
  if (installed) return installed;
  const modules = enabledModules(all, probeEnabled());
  installed = modules;
  const bindings: KeybindingDef[] = modules.flatMap((m) => m.keybindings ?? []);
  if (bindings.length) {
    try { registerKeybindings(bindings); } catch (err) { warn('feature keybindings could not be registered', err); }
  }
  bootFeatures(modules, appCtx);
  for (const fn of [...subscribers]) fn();
  return modules;
}

let loading: Promise<readonly FeatureModule[]> | null = null;

/** The installed modules, loading the manifest first on a page that has not. */
export function loadFeatures(): Promise<readonly FeatureModule[]> {
  if (installed) return Promise.resolve(installed);
  loading ??= import('./manifest').then((m) => installFeatures(m.FEATURES), (err) => { loading = null; throw err; });
  return loading;
}

const subscribe = (fn: () => void) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; };
const installedNow = () => installed ?? NONE;

/** The modules that run; none until the manifest is installed (the editor
 *  page does it as it loads; main.tsx when the page is idle). */
export function useFeatureModules(): readonly FeatureModule[] {
  return useSyncExternalStore(subscribe, installedNow, installedNow);
}

// ---- Page events ----

/** Re-renders the calling component whenever one of `names` is emitted on the page. */
export function usePageEvents(page: EditorPageCtx | null, names: readonly (keyof PageEvents)[]): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const key = names.join(' ');
  useEffect(() => {
    if (!page) return;
    const offs = key.split(' ').map((n) => page.events.on(n as keyof PageEvents, () => bump()));
    return () => offs.forEach((off) => off());
  }, [page, key]);
}

// ---- Page-scope keybindings ----

/** V1's own shortcuts: Editor.tsx and the palette dispatch these themselves. */
const SELF_DISPATCHED = new Set(['typeset', 'comment', 'jump', 'palette', 'search']);
/** The keybinding registry threw (it is not there): stop asking it on every key. */
let registryMissing = false;

/** A text field other than the code editor, which keeps the keys typed in it. */
function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.closest('.cm-editor')) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

const modalOpen = () => !!document.querySelector('[role="dialog"][aria-modal="true"]');

/**
 * Runs `run(binding.command)` for each `page` (bubble phase) and
 * `page-capture` (capture phase) keybinding pressed on this page; a command
 * that ran takes the key. Skipped in text fields other than the code editor,
 * over an open dialog, for repeats, and for the bindings the page already
 * dispatches itself. In the desktop app, 'native-menu' bindings are the
 * menu's.
 */
export function usePageKeys(run: (command: string) => boolean, enabled = true): void {
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!enabled) return;
    const handler = (scope: KeyScope) => (e: KeyboardEvent) => {
      if (registryMissing || e.defaultPrevented || e.repeat || e.isComposing || inTextField(e.target) || modalOpen()) return;
      let binding: KeybindingDef | null;
      try {
        binding = bindingFor(e, [scope], { desktop: appCtx.desktop });
      } catch (err) {
        registryMissing = true;
        warn('page keybindings are unavailable', err);
        return;
      }
      if (!binding || SELF_DISPATCHED.has(binding.id)) return;
      if (!runRef.current(binding.command)) return;
      e.preventDefault();
      if (scope === 'page-capture') e.stopPropagation();
    };
    const bubble = handler('page');
    const capture = handler('page-capture');
    window.addEventListener('keydown', bubble);
    window.addEventListener('keydown', capture, true);
    return () => {
      window.removeEventListener('keydown', bubble);
      window.removeEventListener('keydown', capture, true);
    };
  }, [enabled]);
}
