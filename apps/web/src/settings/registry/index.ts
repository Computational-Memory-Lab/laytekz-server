/**
 * Laytekz V2 settings registry (WP01, frozen): every setting definition, from
 * the core lists and from each feature's settings.ts. Only the integrator
 * edits this file. Everything it imports is pure data, so it is cheap to load
 * on any page.
 */
import type { AnySettingDef, SectionDef, SectionId } from '../types';
import { CORE_SETTINGS } from './core';
import { EDITOR_SETTINGS } from '../../editor/core/editorSettingDefs';
import { settings as escape } from '../../features/escape/settings';
import { settings as automath } from '../../features/automath/settings';
import { settings as pairs } from '../../features/pairs/settings';
import { settings as envclose } from '../../features/envclose/settings';
import { settings as suggest } from '../../features/suggest/settings';
import { settings as mathPreview } from '../../features/mathPreview/settings';
import { settings as tables } from '../../features/tables/settings';
import { settings as citations } from '../../features/citations/settings';
import { settings as crossrefs } from '../../features/crossrefs/settings';
import { settings as links } from '../../features/links/settings';
import { settings as references } from '../../features/references/settings';
import { settings as libraries } from '../../features/libraries/settings';
import { settings as rename } from '../../features/rename/settings';
import { settings as outputs } from '../../features/outputs/settings';
import { settings as wordcount } from '../../features/wordcount/settings';
import { settings as pet } from '../../features/pet/settings';
import { settings as highlighter } from '../../features/highlighter/settings';
import { settings as stats } from '../../features/stats/settings';
import { settings as agents } from '../../features/agents/settings';
import { settings as webShell } from '../../features/webShell/settings';
import { settings as pdfComments } from '../../features/pdfComments/settings';
import { settings as refManagers } from '../../features/refManagers/settings';
import { settings as probe } from '../../features/_probe/settings';

export const SECTIONS: readonly SectionDef[] = [
  { id: 'account', title: 'Account', order: 10 },
  { id: 'connections', title: 'Connections', order: 20 },
  { id: 'appearance', title: 'Appearance', order: 30 },
  { id: 'editor-text', title: 'Editor text', order: 40 },
  { id: 'editor-behaviour', title: 'Editor behaviour', order: 50 },
  { id: 'typing', title: 'Typing', order: 60 },
  { id: 'completion', title: 'Completion', order: 70 },
  { id: 'math', title: 'Math', order: 80 },
  { id: 'tables', title: 'Tables', order: 90 },
  { id: 'references', title: 'References', order: 100 },
  { id: 'citations', title: 'Citations and cross-references', order: 110 },
  { id: 'statistics', title: 'Statistics', order: 120 },
  { id: 'files', title: 'Files and outputs', order: 130 },
  { id: 'wordcount', title: 'Word count', order: 140 },
  { id: 'highlighter', title: 'Highlighter', order: 150 },
  { id: 'pet', title: 'Desk pet', order: 160 },
  { id: 'typesetting', title: 'Typesetting', order: 170 },
  { id: 'pdf', title: 'PDF preview', order: 180 },
  { id: 'shortcuts', title: 'Keyboard shortcuts', order: 190 },
  { id: 'agents', title: 'Console and agents', order: 200 },
  { id: 'desktop', title: 'Desktop app', order: 210 },
  { id: 'labs', title: 'Labs', order: 220 },
  { id: 'project', title: 'This project', order: 230 },
];

/** Each feature's list, in manifest order. A feature's ids start with '<featureId>.'. */
const FEATURE_SETTINGS: readonly (readonly [string, readonly AnySettingDef[]])[] = [
  ['escape', escape],
  ['automath', automath],
  ['pairs', pairs],
  ['envclose', envclose],
  ['suggest', suggest],
  ['mathPreview', mathPreview],
  ['tables', tables],
  ['citations', citations],
  ['crossrefs', crossrefs],
  ['links', links],
  ['references', references],
  ['libraries', libraries],
  ['rename', rename],
  ['outputs', outputs],
  ['wordcount', wordcount],
  ['pet', pet],
  ['highlighter', highlighter],
  ['stats', stats],
  ['agents', agents],
  ['webShell', webShell],
  ['pdfComments', pdfComments],
  ['refManagers', refManagers],
  ['_probe', probe],
];

/** What is wrong with the definitions: duplicate ids, a feature id that does
 *  not start with its feature's prefix, an unknown section, an automatic
 *  setting that is not a switch. Empty when all is well; the settings-core
 *  tests (WP02) assert that. A bad definition is dropped, never thrown on. */
export const REGISTRY_PROBLEMS: string[] = [];

const sectionIds = new Set<SectionId>(SECTIONS.map((s) => s.id));
const all = new Map<string, AnySettingDef>();

function add(def: AnySettingDef, from: string, prefix: string | null): void {
  if (all.has(def.id)) { REGISTRY_PROBLEMS.push(`${from}: '${def.id}' is already defined`); return; }
  if (prefix && !def.id.startsWith(`${prefix}.`)) { REGISTRY_PROBLEMS.push(`${from}: '${def.id}' must start with '${prefix}.'`); return; }
  if (!sectionIds.has(def.section)) { REGISTRY_PROBLEMS.push(`${from}: '${def.id}' names an unknown section '${def.section}'`); return; }
  if (def.automatic && def.control.kind !== 'switch') { REGISTRY_PROBLEMS.push(`${from}: '${def.id}' is automatic, so its control must be a switch`); return; }
  all.set(def.id, def);
}

for (const def of CORE_SETTINGS) add(def, 'settings/registry/core', null);
for (const def of EDITOR_SETTINGS) add(def, 'editor/core/editorSettingDefs', null);
for (const [id, defs] of FEATURE_SETTINGS) for (const def of defs) add(def, `features/${id}/settings`, id);

/** Every setting by id, in registry order (core, editor, then features in manifest order). */
export const SETTINGS: ReadonlyMap<string, AnySettingDef> = all;

export function settingDef(id: string): AnySettingDef | undefined {
  return all.get(id);
}

/** A section's settings, by `order` (then registry order). */
export function settingsIn(section: SectionId): AnySettingDef[] {
  return [...all.values()].filter((d) => d.section === section).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
