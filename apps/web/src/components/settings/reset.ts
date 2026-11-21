/**
 * Reset and Undo for the settings page (WP23): a row, a section, or every
 * setting back to its default, and the snapshot that puts them back in one
 * step. Imports use the same snapshot, so their Undo is one step too.
 *
 * Changes go through the settings store (setSetting/resetSetting), so other
 * tabs and the account follow. An Undo also puts back the exact text a key
 * held (a V1 key holding a value V1 wrote, or one nobody wrote), because a
 * legacy key is never rewritten unless the person changed its value.
 */
import { sameValue } from '../../settings/codecs';
import type { AnySettingDef } from '../../settings/types';

export interface ResetStore {
  get(id: string): unknown;
  dflt(def: AnySettingDef): unknown;
  set(id: string, v: unknown): void;
  reset(id: string): void;
  /** The device key's stored text, null when absent. */
  raw(key: string): string | null;
  /** Puts back a key's exact text; only ever text that reads as the value already set. */
  writeRaw(key: string, raw: string | null): void;
}

export interface SnapshotEntry { id: string; key: string; value: unknown; raw: string | null }

export const storageKey = (def: Pick<AnySettingDef, 'id' | 'key'>): string => def.key ?? `aldine.${def.id}`;

export function isChanged(def: AnySettingDef, s: Pick<ResetStore, 'get' | 'dflt'>): boolean {
  return !sameValue(s.get(def.id), s.dflt(def));
}

function entry(def: AnySettingDef, s: ResetStore): SnapshotEntry {
  const key = storageKey(def);
  return { id: def.id, key, value: s.get(def.id), raw: s.raw(key) };
}

/** Resets each of `defs` that differs from its default or has a stored key; returns what Undo needs. */
export function resetDefs(defs: readonly AnySettingDef[], s: ResetStore): SnapshotEntry[] {
  const touched = defs.filter((d) => d.scope !== 'project' && (isChanged(d, s) || s.raw(storageKey(d)) !== null));
  const snap = touched.map((d) => entry(d, s));
  for (const d of touched) s.reset(d.id);
  return snap;
}

/** Sets each value (an import); returns what Undo needs. */
export function applyValues(changes: readonly { def: AnySettingDef; to: unknown }[], s: ResetStore): SnapshotEntry[] {
  const snap = changes.map((c) => entry(c.def, s));
  for (const c of changes) s.set(c.def.id, c.to);
  return snap;
}

/** Puts every entry back as it was: the value through the store, then the exact stored text. */
export function restore(snap: readonly SnapshotEntry[], s: ResetStore): void {
  for (const e of snap) {
    if (e.raw === null) s.reset(e.id);
    else s.set(e.id, e.value);
  }
  for (const e of snap) if (s.raw(e.key) !== e.raw) s.writeRaw(e.key, e.raw);
}

/** "Theme", "Theme and Font size", "Theme, Font size and 3 more". */
export function namesText(labels: readonly string[], max = 3): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  if (labels.length <= max) return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return `${labels.slice(0, max - 1).join(', ')} and ${labels.length - (max - 1)} more`;
}
