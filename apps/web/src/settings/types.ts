/**
 * Laytekz V2 settings contracts (WP01, frozen). Only the integrator changes
 * this file; a package that needs a change files a request
 * (docs/galley-v2/README.md). Type-only apart from the constants at the end.
 */
import type { ComponentProps, ComponentType } from 'react';
import type ProjectSettings from '../components/ProjectSettings';
import type { Capabilities } from '../features/types';

/** Where a value lives. `device`: this browser's localStorage only. `account`:
 *  synced through /api/account/preferences, mirrored on the device. `project`:
 *  `ProjectMeta.ext[id]`, shared with everyone on the project. */
export type Scope = 'device' | 'account' | 'project';

/** A settings page section: the path segment of /settings/<section> and
 *  /p/<id>/settings/<section>. The web page shows 'desktop' for the path
 *  'desktop-app' too (see DESKTOP_APP_PATH). */
export type SectionId =
  | 'account' | 'connections' | 'appearance' | 'editor-text' | 'editor-behaviour' | 'typing' | 'completion' | 'math'
  | 'tables' | 'references' | 'citations' | 'statistics' | 'files' | 'wordcount' | 'highlighter' | 'pet' | 'typesetting'
  | 'pdf' | 'shortcuts' | 'agents' | 'desktop' | 'labs' | 'project';

export interface SectionDef { id: SectionId; title: string; order: number }

/** The device mirror's text form. `decode(null)` is "nothing stored". A legacy
 *  key keeps its exact V1 codec (`aldine.vim` is on only for '1',
 *  `aldine.autoTypeset` is off only for '0'). `undefined` from decode means
 *  "not a value I know": the store then uses the default and never rewrites
 *  the key. `encode` returning null removes the key. */
export interface Codec<T> { decode(raw: string | null): T | undefined; encode(v: T): string | null }

/** Props of a `custom` control's component. */
export interface CustomControlProps<T> {
  def: SettingDef<T>;
  value: T;
  onChange(v: T): void;
  /** Viewers, showcases, or an unmet `dependsOn`. */
  disabled: boolean;
}

export type Control =
  | { kind: 'switch' }
  | { kind: 'segmented' | 'select'; options: { value: string | number; label: string }[] }
  | { kind: 'slider'; min: number; max: number; step: number; unit?: string }
  | { kind: 'text' | 'number'; min?: number; max?: number }
  | { kind: 'checklist'; options: { value: string; label: string }[] }
  | { kind: 'custom'; load(): Promise<{ default: ComponentType<CustomControlProps<any>> }> };

/** What a row's `visible()` may look at. */
export interface SettingsEnv {
  accounts: boolean;
  signedIn: boolean;
  desktop: boolean;
  phone: boolean;
  capabilities: Capabilities;
  /** The project whose editor the page is opened over; null on /settings. */
  project: { id: string; canEdit: boolean; showcase: boolean } | null;
}

export interface SettingDef<T = unknown> {
  /** '<featureId>.<name>' for a feature's settings (the id is also the
   *  account preference key, so it must match PREF_KEY_RE); core settings use
   *  their own first segment ('editor.', 'appearance.', 'typing.' …). */
  id: string;
  section: SectionId;
  label: string;
  hint?: string | ((v: T) => string);
  keywords?: string;
  scope: Scope;
  default: T;
  validate(v: unknown): v is T;
  /** The device mirror's key; default `aldine.${id}`. Legacy keys are reused verbatim. */
  key?: string;
  /** The device mirror's codec; default JSON. */
  codec?: Codec<T>;
  control: Control;
  /** Changes text, the meaning of a key, or shows UI nobody asked for: must
   *  be a switch, is listed under "Automatic changes", and defaults to false
   *  when localStorage['aldine.settings.testDefaults'] === 'automatic-off'. */
  automatic?: boolean;
  /** Another setting's id; this row is disabled while that one is false. */
  dependsOn?: string;
  visible?(env: SettingsEnv): boolean;
  /** 'reopen': takes effect the next time the editor opens. Default 'live'. */
  applies?: 'live' | 'reopen';
  order?: number;
  /** true: the palette gets "Turn <label> on/off" (switches only). */
  palette?: boolean;
}

/** A list of definitions of mixed value types (`hint` makes SettingDef<T> invariant in T). */
export type AnySettingDef = SettingDef<any>;

/** Where openSettings() goes: a section, and a row to highlight. */
export interface SettingsTarget { section?: SectionId; setting?: string }

/** pages/Settings.tsx's default export (WP07), rendered by the routes WP06 adds. */
export interface SettingsPageProps {
  /** From the path; undefined shows the first section. */
  section?: SectionId;
  /** From the hash (#<setting id>): scrolled to and highlighted. */
  setting?: string;
  /** Opened over a project's editor (/p/:id/settings/*): exactly the props
   *  Editor.tsx gives ProjectSettings today, less onClose and focus, for the
   *  "This project" section. Null or absent on /settings. */
  project?: Omit<ComponentProps<typeof ProjectSettings>, 'onClose' | 'focus'> | null;
  /** Leave the page: back to the editor (no remount) or to Home. */
  onClose(): void;
}

// ---- Wire contracts shared with the server (srv/features/types.ts mirrors them) ----

/** GET /api/account/preferences (ETag "p<rev>", or 304), and every PATCH/PUT reply. */
export interface AccountPrefsResponse { prefs: Record<string, unknown>; rev: number; updatedAt: string | null }
/** PATCH /api/account/preferences. `keepExisting`: keys the account already has are left alone (first sync). */
export interface AccountPrefsPatch { set?: Record<string, unknown>; unset?: string[]; keepExisting?: boolean }
/** PUT /api/account/preferences: replaces everything. */
export interface AccountPrefsPut { prefs: Record<string, unknown> }
/** GET /api/projects/:id/settings, and every PATCH reply: `clientVisible` keys only. */
export interface ProjectSettingsResponse { values: Record<string, unknown>; rev: number }
/** PATCH /api/projects/:id/settings. Unknown or unwritable keys: 400 `{ error, key }`. */
export interface ProjectSettingsPatch { set?: Record<string, unknown>; unset?: string[] }

/** Account preference keys (server-enforced). */
export const PREF_KEY_RE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+){1,3}$/;
export const PREF_LIMITS = { keysPerRequest: 64, keysStored: 300, valueBytes: 2048, valueDepth: 3, totalBytes: 32768 } as const;

/** window CustomEvent<SettingsTarget | null>, cancelable. openSettings()
 *  dispatches it; the page host (WP06) navigates and calls preventDefault().
 *  The desktop shell's Settings… menu dispatches the same event and loads
 *  /settings itself when nobody prevented it. */
export const OPEN_SETTINGS_EVENT = 'laytekz:open-settings';
/** /settings/desktop-app: the desktop shell opens its own settings window
 *  there; the web page shows the 'desktop' section. */
export const DESKTOP_APP_PATH = 'desktop-app';
/** localStorage key that makes every `automatic` setting default to false (legacy e2e specs). */
export const TEST_DEFAULTS_KEY = 'aldine.settings.testDefaults';
/** Branch-signal key (srv signalBranch / web branchSignal.onSignal) that a project settings write bumps. */
export const PROJECT_SETTINGS_SIGNAL = 'settings';

/**
 * Core setting ids other packages read in wave 0, frozen so WP02 (which
 * defines them in settings/registry/core.ts) and their readers agree. The V1
 * preferences keep their device keys and exact V1 codecs; nothing is
 * migrated or rewritten.
 */
export const CORE_SETTING_IDS = {
  /** aldine.theme: 'system' | 'light' | 'dark'; absent or unknown is 'system'. */
  theme: 'appearance.theme',
  /** aldine.shortcuts: JSON { [binding id]: Chord }; the keybinding registry (WP04) reads and writes it. */
  shortcuts: 'keys.shortcuts',
  /** aldine.autoTypeset: on unless '0'. */
  autoTypeset: 'typesetting.auto',
  /** aldine.draftTypeset: on unless '0'. */
  draftTypeset: 'typesetting.draft',
  /** aldine.spellcheck: on unless '0'. */
  spellcheck: 'editor.spellcheck',
  /** aldine.spellcheckLang: a SPELL_LANGS tag; absent or '' follows the browser. */
  spellLang: 'editor.spellLang',
  /** aldine.vim: off unless '1'. */
  vim: 'editor.vim',
  /** aldine.changeMarks: on unless '0'. */
  changeMarks: 'editor.changeMarks',
  /** aldine.editorMode: 'source' | 'visual'; absent is 'source'. Device scope (the last choice here). */
  editorMode: 'editor.mode',
  /** aldine.layout: 'editor' | 'both' | 'pdf'; absent decides by window width (util/layout.ts). Device scope. */
  layout: 'layout.panes',
  /** aldine.pdfZoom: a multiple of fit-width, 0.5 to 3; absent is 1. Device scope. */
  pdfZoom: 'pdf.zoom',
  /** aldine.experimental.agentPresence: off unless '1'. Device scope. */
  agentPresence: 'labs.agentPresence',
  /** New in V2 (WP02): explain automatic changes the first 3 times. Account scope, on. */
  explainAutomatic: 'typing.explain',
  /** New in V2 (WP02): the editor's own right-click menu (WP04 reads it). Account scope, on. */
  contextMenu: 'editor.contextMenu',
} as const;
