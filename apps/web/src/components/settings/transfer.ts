/**
 * Export and import of laytekz-settings.json (WP23). Pure: the page passes
 * the definitions and the store's read functions in, so these are unit
 * tested without storage.
 *
 * The file holds every account- and device-scope setting whose value differs
 * from its default, by setting id. Project settings, the toolbar's own state
 * (editor mode, PDF zoom) and the sync switch are never exported, imported
 * or reset in bulk; nor are names, connections or tokens, which are not
 * settings. An import names what will change before anything does, and
 * leaves every setting the file does not name as it is.
 */
import { sameValue } from '../../settings/codecs';
import type { AnySettingDef } from '../../settings/types';

export const TRANSFER_FORMAT = 'laytekz-settings';
export const TRANSFER_VERSION = 1;
export const TRANSFER_FILENAME = 'laytekz-settings.json';

/** State the page sets as you work, and the switch that decides where settings live. */
export const LOCAL_ONLY_IDS: ReadonlySet<string> = new Set(['editor.mode', 'pdf.zoom', 'account.sync']);

/** Exported, imported and reset in bulk. */
export function isPortable(def: Pick<AnySettingDef, 'id' | 'scope'>): boolean {
  return def.scope !== 'project' && !LOCAL_ONLY_IDS.has(def.id);
}

export interface SettingsFile {
  format: typeof TRANSFER_FORMAT;
  version: number;
  exportedAt: string;
  settings: Record<string, unknown>;
}

export function buildExport(defs: Iterable<AnySettingDef>, value: (id: string) => unknown, dflt: (def: AnySettingDef) => unknown, now = new Date()): SettingsFile {
  const settings: Record<string, unknown> = {};
  for (const def of defs) {
    if (!isPortable(def)) continue;
    const v = value(def.id);
    if (v === undefined || sameValue(v, dflt(def))) continue;
    settings[def.id] = v;
  }
  return { format: TRANSFER_FORMAT, version: TRANSFER_VERSION, exportedAt: now.toISOString(), settings };
}

export interface ImportChange { id: string; label: string; from: unknown; to: unknown }

export interface ImportPlan {
  changes: ImportChange[];
  /** Ids this version does not know, or that never travel (project, toolbar state). */
  ignored: string[];
  /** Known settings whose value is not allowed here. */
  invalid: string[];
  /** Named in the file with the value this browser already has. */
  same: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What importing `text` would change, or a sentence saying why it cannot be imported. */
export function planImport(text: string, lookup: (id: string) => AnySettingDef | undefined, value: (id: string) => unknown): ImportPlan | { error: string } {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { error: 'That file isn’t a Laytekz settings file: it isn’t JSON.' }; }
  if (!isObject(data) || data.format !== TRANSFER_FORMAT) return { error: 'That file isn’t a Laytekz settings file.' };
  if (typeof data.version !== 'number' || data.version > TRANSFER_VERSION) {
    return { error: 'That settings file comes from a newer Laytekz. Update this one to import it.' };
  }
  if (!isObject(data.settings)) return { error: 'That settings file has no settings in it.' };
  const plan: ImportPlan = { changes: [], ignored: [], invalid: [], same: 0 };
  for (const [id, to] of Object.entries(data.settings)) {
    const def = lookup(id);
    if (!def || !isPortable(def)) { plan.ignored.push(id); continue; }
    let ok = false;
    try { ok = def.validate(to); } catch { ok = false; }
    if (!ok) { plan.invalid.push(id); continue; }
    const from = value(id);
    if (sameValue(from, to)) { plan.same += 1; continue; }
    plan.changes.push({ id, label: def.label, from, to });
  }
  return plan;
}

/** A value as the page names it: the option's label, On/Off, a number with its unit. */
export function describeValue(def: AnySettingDef | undefined, v: unknown): string {
  const c = def?.control;
  if (c && (c.kind === 'select' || c.kind === 'segmented')) {
    const o = c.options.find((x) => String(x.value) === String(v));
    if (o) return o.label;
  }
  if (c?.kind === 'checklist' && Array.isArray(v)) {
    const labels = v.map((x) => c.options.find((o) => o.value === x)?.label ?? String(x));
    return labels.length ? labels.join(', ') : 'None';
  }
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'number') return c?.kind === 'slider' && c.unit ? `${v} ${c.unit}` : String(v);
  if (typeof v === 'string') return v === '' ? 'Default' : v;
  if (isObject(v)) {
    const n = Object.keys(v).length;
    return n === 1 ? '1 change' : `${n} changes`;
  }
  return v === null || v === undefined ? 'Default' : JSON.stringify(v);
}
