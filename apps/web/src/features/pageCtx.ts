/**
 * The editor page's feature context (EditorPageCtx) and the page host's pure
 * helpers (WP06 page-host): which modules run, their commands, read-only
 * rules, interceptors and lifecycles, branch-signal values, and the settings
 * page's addresses. No React and no CodeMirror at run time, because the
 * project list and main.tsx use parts of it: everything a feature module
 * pulls in stays out of the entry chunk only while nothing here imports
 * features/manifest.ts.
 */
import type { CommandDef, Command } from '../commands/types';
import { DESKTOP_APP_PATH, type SectionId, type SettingsTarget } from '../settings/types';
import { SECTIONS } from '../settings/registry';
import { safeStorage } from '../util/safeStorage';
import { createEmitter } from './events';
import type {
  AppCtx, EditorPageCtx, FeatureModule, FilesMovedSignal, Interceptors, PageEvents, PinnedPanel,
} from './types';

/** localStorage key that turns the e2e probe feature on ('1'). */
export const PROBE_FLAG = 'aldine.e2e.probe';

export const probeEnabled = (): boolean => safeStorage.get(PROBE_FLAG) === '1';

/** The modules that run, in manifest order: `_probe` only when asked for. */
export function enabledModules(all: readonly FeatureModule[], probe: boolean): readonly FeatureModule[] {
  return all.filter((m) => m.id !== '_probe' || probe);
}

const warn = (what: string, err: unknown) => console.warn(`[laytekz] ${what}`, err);

// ---- The page context ----

/** What the editor page supplies to the context: the live values behind every member. */
export type PageCtxSource = Omit<EditorPageCtx, 'projectId' | 'branch' | 'events'>;

/**
 * One context per project and branch. Every member reads `source()` when it
 * is called, so a feature that keeps the context sees the page as it is now,
 * never as it was when it was activated.
 */
export function createEditorPageCtx(
  projectId: string,
  branch: string,
  source: () => PageCtxSource,
  events = createEmitter<PageEvents>(),
): EditorPageCtx {
  return Object.freeze({
    projectId,
    branch,
    events,
    project: () => source().project(),
    user: () => source().user(),
    canEdit: () => source().canEdit(),
    showcase: () => source().showcase(),
    activeFile: () => source().activeFile(),
    view: () => source().view(),
    files: () => source().files(),
    openFile: (path: string, at?: { line?: number; pos?: number; find?: string }) => source().openFile(path, at),
    insertAtCursor: (text: string) => source().insertAtCursor(text),
    editDocument: ((edit, done) => source().editDocument(edit, done)) as EditorPageCtx['editDocument'],
    compile: (o?: { clean?: boolean }) => source().compile(o),
    lastCompile: () => source().lastCompile(),
    pdf: () => source().pdf(),
    ui: Object.freeze({
      layout: () => source().ui.layout(),
      sidebarHidden: () => source().ui.sidebarHidden(),
      phone: () => source().ui.phone(),
      showPanel: (id: string, query?: string) => source().ui.showPanel(id, query),
    }),
    peers: () => source().peers(),
    comments: () => source().comments(),
    toast: ((text, kind, action) => source().toast(text, kind, action)) as EditorPageCtx['toast'],
    confirm: (o) => source().confirm(o),
    prompt: (o) => source().prompt(o),
    openSettings: (t?: SettingsTarget) => source().openSettings(t),
    runCommand: (id: string) => source().runCommand(id),
    refreshFiles: () => source().refreshFiles(),
    refreshProject: () => source().refreshProject(),
  } satisfies EditorPageCtx);
}

// ---- Lifecycles ----

function runAll(cleanups: (() => void)[], what: string): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const c of cleanups.reverse()) {
      try { c(); } catch (err) { warn(`${what} cleanup failed`, err); }
    }
  };
}

/** Every module's `activate(page)`, in manifest order; the result undoes them in reverse. */
export function activateFeatures(modules: readonly FeatureModule[], page: EditorPageCtx): () => void {
  const cleanups: (() => void)[] = [];
  for (const m of modules) {
    if (!m.activate) continue;
    try {
      const c = m.activate(page);
      if (typeof c === 'function') cleanups.push(c);
    } catch (err) { warn(`feature '${m.id}' failed to activate`, err); }
  }
  return runAll(cleanups, 'feature');
}

/** Every module's `boot(app)`, once per tab. */
export function bootFeatures(modules: readonly FeatureModule[], app: AppCtx): () => void {
  const cleanups: (() => void)[] = [];
  for (const m of modules) {
    if (!m.boot) continue;
    try {
      const c = m.boot(app);
      if (typeof c === 'function') cleanups.push(c);
    } catch (err) { warn(`feature '${m.id}' failed to boot`, err); }
  }
  return runAll(cleanups, 'boot');
}

// ---- Commands ----

/** Who is looking: a read-only showcase, or someone who may only view. */
export interface CommandRole { showcase: boolean; viewer: boolean }

/** Every module's commands for `page`, in manifest order; a module that throws contributes none. */
export function featureCommandDefs(modules: readonly FeatureModule[], page: EditorPageCtx): CommandDef[] {
  const out: CommandDef[] = [];
  for (const m of modules) {
    if (!m.commands) continue;
    try {
      for (const c of m.commands(page) ?? []) if (c && typeof c.id === 'string' && typeof c.run === 'function') out.push(c);
    } catch (err) { warn(`feature '${m.id}' failed to list its commands`, err); }
  }
  return out;
}

/** The command may run here: not refused for this role, and its `when` holds. */
export function commandAllowed(def: CommandDef, role: CommandRole, page: EditorPageCtx): boolean {
  if (role.showcase && def.refusedFor?.includes('showcase')) return false;
  if (role.viewer && def.refusedFor?.includes('viewer')) return false;
  if (!def.when) return true;
  try { return !!def.when(page); } catch (err) { warn(`command '${def.id}' failed its check`, err); return false; }
}

/** Palette rows without the keybinding hints: what the page lists when the command adapter is unavailable. */
export function plainPaletteRows(defs: readonly CommandDef[], role: CommandRole, page: EditorPageCtx): Command[] {
  return defs.filter((d) => commandAllowed(d, role, page)).map((d) => ({
    id: d.id, title: d.title, hint: d.hint, group: d.group, keywords: d.keywords, run: () => d.run(),
  }));
}

// ---- Read-only rules and interceptors ----

/** The first reason any module gives for `path` being read-only, or null. */
export function readOnlyReason(modules: readonly FeatureModule[], path: string | null, page: EditorPageCtx): string | null {
  if (!path) return null;
  for (const m of modules) {
    for (const rule of m.readOnlyRules ?? []) {
      try {
        const reason = rule.reason(path, page);
        if (typeof reason === 'string' && reason) return reason;
      } catch (err) { warn(`read-only rule '${rule.id}' failed`, err); }
    }
  }
  return null;
}

type InterceptResult<K extends keyof Interceptors> = Awaited<ReturnType<Interceptors[K]>>;

async function intercept<K extends keyof Interceptors>(modules: readonly FeatureModule[], kind: K, args: Parameters<Interceptors[K]>): Promise<InterceptResult<K>> {
  for (const m of modules) {
    const fn = m.interceptors?.[kind] as ((...a: Parameters<Interceptors[K]>) => Promise<string>) | undefined;
    if (!fn) continue;
    try {
      const res = await fn(...args);
      if (res === 'handled' || res === 'cancelled') return res as InterceptResult<K>;
    } catch (err) { warn(`feature '${m.id}' failed to intercept ${kind}`, err); }
  }
  return 'default' as InterceptResult<K>;
}

/** Asks each module in manifest order; the first 'handled' or 'cancelled' ends it, and the page then does nothing itself. */
export function interceptFileRename(modules: readonly FeatureModule[], r: Parameters<Interceptors['fileRename']>[0], page: EditorPageCtx): Promise<InterceptResult<'fileRename'>> {
  return intercept(modules, 'fileRename', [r, page]);
}

export function interceptProjectRename(modules: readonly FeatureModule[], r: Parameters<Interceptors['projectRename']>[0], page: EditorPageCtx | null): Promise<InterceptResult<'projectRename'>> {
  return intercept(modules, 'projectRename', [r, page]);
}

// ---- Sidebar ----

/** The plugin panels with a tab on the sidebar's main row: the core ones and every module's, by `order`, each id once. */
export function pinnedPluginPanels(core: readonly PinnedPanel[], modules: readonly FeatureModule[]): PinnedPanel[] {
  const seen = new Set<string>();
  const all: { p: PinnedPanel; i: number }[] = [];
  for (const p of [...core, ...modules.flatMap((m) => m.pinnedPanels ?? [])]) {
    if (!p || typeof p.id !== 'string' || seen.has(p.id)) continue;
    seen.add(p.id);
    all.push({ p, i: all.length });
  }
  return all.sort((a, b) => a.p.order - b.p.order || a.i - b.i).map((x) => x.p);
}

// ---- Branch signals ----

const isPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The `moves` signal's value, or null when it is not one (an older or newer server). */
export function parseFilesMoved(v: unknown): FilesMovedSignal | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { moves?: unknown; by?: unknown; at?: unknown };
  if (!Array.isArray(o.moves)) return null;
  const moves: [string, string][] = [];
  for (const m of o.moves) {
    if (!Array.isArray(m) || m.length !== 2 || !isPath(m[0]) || !isPath(m[1])) return null;
    moves.push([m[0], m[1]]);
  }
  return { moves, by: typeof o.by === 'string' ? o.by : null, at: typeof o.at === 'number' ? o.at : 0 };
}

/** Where `path` is after `moves` (applied in order; a folder's move carries what is in it). */
export function remapPath(path: string, moves: readonly (readonly [string, string])[]): string {
  let p = path;
  for (const [from, to] of moves) {
    if (p === from) p = to;
    else if (p.startsWith(`${from}/`)) p = to + p.slice(from.length);
  }
  return p;
}

// ---- The settings page's addresses ----

const SECTION_IDS: ReadonlySet<string> = new Set(SECTIONS.map((s) => s.id));

/** A path segment as a settings section: 'desktop-app' shows the desktop section on the web; anything unknown, the first. */
export function settingsSection(segment: string | undefined): SectionId | undefined {
  if (!segment) return undefined;
  if (segment === DESKTOP_APP_PATH) return 'desktop';
  return SECTION_IDS.has(segment) ? (segment as SectionId) : undefined;
}

/** '/p/<id>' when `pathname` (router-relative) is a project's editor or one of its subpages. */
export function projectPathOf(pathname: string): string | null {
  const m = /^\/p\/([^/]+)/.exec(pathname);
  return m ? `/p/${m[1]}` : null;
}

/** The settings page is on screen: /settings… or /p/<id>/settings…. */
export function isSettingsPath(pathname: string): boolean {
  return /^(?:\/p\/[^/]+)?\/settings(?:\/|$)/.test(pathname);
}

/** The address of the settings page for `t`: over the editor at `projectPath` ('/p/<id>', keeping `search`, which names the branch), else /settings. */
export function settingsHref(t: SettingsTarget | null | undefined, projectPath: string | null, search = ''): string {
  const section = t?.section ? `/${t.section}` : '';
  const hash = t?.setting ? `#${encodeURIComponent(t.setting)}` : '';
  return `${projectPath ?? ''}/settings${section}${search}${hash}`;
}

/** What the part of an editor URL after /p/<id>/ asks for: the editor, the settings page over it, or nothing that exists. */
export function editorSubpage(splat: string | undefined): { kind: 'editor' } | { kind: 'settings'; section?: SectionId } | { kind: 'unknown' } {
  const rest = (splat ?? '').replace(/\/+$/, '');
  if (!rest) return { kind: 'editor' };
  const m = /^settings(?:\/([^/]+))?$/.exec(rest);
  if (!m) return { kind: 'unknown' };
  return { kind: 'settings', section: settingsSection(m[1]) };
}

/** The setting a settings URL's hash names, or undefined. */
export function settingFromHash(hash: string): string | undefined {
  const raw = hash.replace(/^#/, '');
  if (!raw) return undefined;
  try { return decodeURIComponent(raw); } catch { return raw; }
}
