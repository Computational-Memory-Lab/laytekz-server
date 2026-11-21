/**
 * What the settings page (pages/Settings.tsx) shows, as pure functions over
 * the registry and the page's environment: which sections and rows, in what
 * order, with which scope badge, hint and test ids. No React, no store, so
 * the rules are unit-tested without a DOM.
 */
import type { AnySettingDef, Control, SectionDef, SectionId, SettingsEnv, SettingsPageProps } from '../../settings/types';
import { CORE_SETTING_IDS } from '../../settings/types';
import type { Capabilities } from '../../features/types';

/**
 * The test ids V1's Project settings dialog gave these preferences' controls.
 * The page keeps them on the generic controls (and as the controls' DOM ids,
 * as V1 had them), so the V1 specs find the same controls. A `segmented`
 * control with a legacy id renders as a native select, which is what those
 * specs drive (`selectOption`).
 */
export const LEGACY_TEST_IDS: Readonly<Record<string, string>> = {
  [CORE_SETTING_IDS.theme]: 'settings-theme',
  [CORE_SETTING_IDS.autoTypeset]: 'settings-auto-typeset',
  [CORE_SETTING_IDS.vim]: 'settings-vim',
  [CORE_SETTING_IDS.spellcheck]: 'settings-spellcheck',
  [CORE_SETTING_IDS.spellLang]: 'settings-spell-lang',
};

/** Settings an embedded block draws itself (the Shortcuts section's recorder
 *  rows), so they never get a generic row as well. */
export const EMBEDDED_SETTING_IDS: ReadonlySet<string> = new Set([CORE_SETTING_IDS.shortcuts]);

/** The row: `setting-<id>` (new in V2), also the target of a `#<id>` link. */
export const rowTestId = (id: string): string => `setting-${id}`;
/** The control: its V1 test id, or `setting-<id>-control`. */
export const controlTestId = (id: string): string => LEGACY_TEST_IDS[id] ?? `setting-${id}-control`;
/** The control's DOM id (what the label points at). */
export const controlDomId = (id: string): string => LEGACY_TEST_IDS[id] ?? `setting-control-${id}`;
export const labelDomId = (id: string): string => `setting-label-${id}`;
export const hintDomId = (id: string): string => `setting-hint-${id}`;
export const sectionDomId = (id: SectionId): string => `settings-section-${id}`;

/** How a control is drawn: the registry's kind, except a legacy segmented
 *  control, which stays a native select (see LEGACY_TEST_IDS). */
export function controlKind(def: Pick<AnySettingDef, 'id' | 'control'>): Control['kind'] {
  return def.control.kind === 'segmented' && LEGACY_TEST_IDS[def.id] ? 'select' : def.control.kind;
}

/** One label element names the control (`<label for>`); groups are named by aria-labelledby. */
export function labelledByFor(kind: Control['kind']): boolean {
  return kind === 'segmented' || kind === 'checklist' || kind === 'custom';
}

/** What the page's rows may look at (SettingsEnv), from what the page knows. */
export function settingsEnv(o: {
  accounts: boolean;
  signedIn: boolean;
  desktop: boolean;
  phone: boolean;
  capabilities: Capabilities;
  project?: SettingsPageProps['project'];
}): SettingsEnv {
  const p = o.project;
  return {
    accounts: o.accounts,
    signedIn: o.signedIn,
    desktop: o.desktop,
    phone: o.phone,
    capabilities: o.capabilities,
    project: p ? { id: p.project.id, canEdit: (p.canConfigure ?? true) && !p.readOnly, showcase: !!p.readOnly } : null,
  };
}

/** Shown on this page: project rows only over a project, and `visible()`
 *  (a feature's code, so a throw hides the row instead of the page). */
export function isRowVisible(def: AnySettingDef, env: SettingsEnv): boolean {
  if (EMBEDDED_SETTING_IDS.has(def.id)) return false;
  if (def.scope === 'project' && !env.project) return false;
  if (!def.visible) return true;
  try { return def.visible(env) !== false; } catch { return false; }
}

export interface PageSection {
  def: SectionDef;
  /** Generic rows, by order. */
  rows: AnySettingDef[];
  /** `automatic` rows, listed after the others under "Automatic changes". */
  automatic: AnySettingDef[];
  /** The page draws existing rows of its own here (account, connections, shortcuts, this project). */
  embedded: boolean;
}

/** The sections to show, in order: those with an embedded block or at least one visible row. */
export function pageSections(
  sections: readonly SectionDef[],
  rowsIn: (s: SectionId) => readonly AnySettingDef[],
  env: SettingsEnv,
  embedded: ReadonlySet<SectionId>,
): PageSection[] {
  const out: PageSection[] = [];
  for (const def of [...sections].sort((a, b) => a.order - b.order)) {
    const shown = rowsIn(def.id).filter((d) => isRowVisible(d, env));
    const section = { def, rows: shown.filter((d) => !d.automatic), automatic: shown.filter((d) => d.automatic), embedded: embedded.has(def.id) };
    if (section.embedded || section.rows.length || section.automatic.length) out.push(section);
  }
  return out;
}

/** Sections whose content is drawn by the page itself: the existing (V1)
 *  rows, every keybinding, and the Desktop app section (in the desktop app,
 *  or when the address asks for it: /settings/desktop-app on the web). */
export function embeddedSections(o: { accounts: boolean; signedIn: boolean; project: boolean; desktop?: boolean }): Set<SectionId> {
  const out = new Set<SectionId>(['shortcuts']);
  // Without accounts the Account section holds this browser's name for co-authors.
  if (!o.accounts || o.signedIn) out.add('account');
  if (o.accounts && o.signedIn) out.add('connections');
  if (o.project) out.add('project');
  if (o.desktop) out.add('desktop');
  return out;
}

/** The run of consecutive sections that the V1 `account-settings` test id
 *  wraps on this page: Account and Connections, while signed in. */
export function accountRun(sections: readonly PageSection[], signedIn: boolean): { start: number; end: number } | null {
  if (!signedIn) return null;
  const isAccount = (s: PageSection) => s.def.id === 'account' || s.def.id === 'connections';
  const start = sections.findIndex(isAccount);
  if (start < 0) return null;
  let end = start;
  while (end + 1 < sections.length && isAccount(sections[end + 1])) end++;
  return { start, end };
}

/** The section to scroll to: the asked-for one when shown, else none (the top). */
export function resolveSection(asked: SectionId | undefined, shown: readonly PageSection[]): SectionId | null {
  return asked && shown.some((s) => s.def.id === asked) ? asked : null;
}

/** The page's address for a section (inside the app, before the base path). */
export function sectionPath(section: SectionId, projectId?: string | null): string {
  return projectId ? `/p/${encodeURIComponent(projectId)}/settings/${section}` : `/settings/${section}`;
}

export type ScopeName = 'This browser' | 'Your account' | 'This project';

/** The badge's words: where a change lands. An account setting stays on this
 *  browser when nobody is signed in to an account. */
export function scopeName(def: Pick<AnySettingDef, 'scope'>, env: Pick<SettingsEnv, 'accounts' | 'signedIn'>): ScopeName {
  if (def.scope === 'project') return 'This project';
  if (def.scope === 'account' && env.accounts && env.signedIn) return 'Your account';
  return 'This browser';
}

/** Where most settings land for this visitor. The page says it once at the top
 *  (scopeNote), so a row carries a badge only when its own scope differs. */
export function defaultScopeName(env: Pick<SettingsEnv, 'accounts' | 'signedIn'>): ScopeName {
  return env.accounts && env.signedIn ? 'Your account' : 'This browser';
}

/** The line under the page's title. */
export function scopeNote(env: Pick<SettingsEnv, 'accounts' | 'signedIn'>): string {
  return defaultScopeName(env) === 'Your account'
    ? 'Changes save as you make them, to your account unless a setting is marked otherwise.'
    : 'Changes save as you make them, in this browser unless a setting is marked otherwise.';
}

/** The badge's tooltip. */
export function scopeTitle(name: ScopeName): string {
  if (name === 'This project') return 'Saved with the project, for everyone working on it';
  if (name === 'Your account') return 'Saved to your account, in every browser you sign in on';
  return 'Saved in this browser only';
}

/** The row's explanation: "Turn on X first" while its parent is off, else the
 *  hint (a function of the value, guarded: it is a feature's code), then a
 *  note when the change applies on reopen. */
export function hintText(def: AnySettingDef, value: unknown, o: { parentOff?: boolean; parentLabel?: string | null } = {}): string | null {
  if (o.parentOff) return `Turn on ${o.parentLabel ? `“${o.parentLabel}”` : 'the setting above'} first`;
  let hint: string | null = null;
  if (typeof def.hint === 'function') {
    try { hint = def.hint(value) || null; } catch { hint = null; }
  } else if (def.hint) hint = def.hint;
  const reopen = def.applies === 'reopen' ? 'Applies when you reopen the file' : null;
  return [hint, reopen].filter(Boolean).join(' · ') || null;
}

/** A select's option value (DOM strings) back to the registry's typed value. */
export function optionFor<V extends string | number>(options: readonly { value: V; label?: string }[], key: string): V | undefined {
  return options.find((o) => String(o.value) === key)?.value;
}

/** A typed number to a slider's grid: clamped, snapped to the step from `min`, rid of float noise. */
export function snapToStep(n: number, c: { min: number; max: number; step: number }): number {
  const clamped = Math.min(c.max, Math.max(c.min, n));
  if (!(c.step > 0)) return clamped;
  const snapped = c.min + Math.round((clamped - c.min) / c.step) * c.step;
  const decimals = Math.max((String(c.step).split('.')[1] ?? '').length, (String(c.min).split('.')[1] ?? '').length);
  return Math.min(c.max, Number(snapped.toFixed(Math.min(10, decimals))));
}

/** A number field's text: a finite number, or null (blank or junk keeps the old value). */
export function parseNumber(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A checklist after one box changed, in the options' order. */
export function toggleChecklist(options: readonly { value: string; label?: string }[], current: readonly string[], value: string, on: boolean): string[] {
  const chosen = new Set(current);
  if (on) chosen.add(value); else chosen.delete(value);
  return options.map((o) => o.value).filter((v) => chosen.has(v));
}

/** The section whose top is the last one above the reading line (scrolled to
 *  the end: the last section, which may be too short to reach the line). */
export function sectionInView(tops: readonly { id: SectionId; top: number }[], scrollTop: number, atEnd: boolean, line = 24): SectionId | null {
  if (!tops.length) return null;
  if (atEnd) return tops[tops.length - 1].id;
  let current = tops[0].id;
  for (const t of tops) if (t.top <= scrollTop + line) current = t.id;
  return current;
}
