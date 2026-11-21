/**
 * Project settings in ProjectMeta.ext (WP03 server-foundation): the registry
 * of the server features' ProjectSettingDefs, the client view of `ext`, and
 * the one validated way to change it. No I/O here: store.ts (copyProject)
 * and routes.ts (publicMeta) import this file, and kit.ts does the reads and
 * writes. Every key in `ext` has a definition; a key without one (a feature
 * removed, a value written by a newer server) stays stored, is never sent to
 * a client and cannot be changed until a definition claims it again.
 */
import type { ProjectMeta } from '../db/types.js';
import { EXT_REV_KEY, type FeatureId, type ProjectSettingDef } from './types.js';

/** A refused change: the message is a sentence for the person, `key` the setting it is about. */
export class ProjectSettingError extends Error {
  constructor(message: string, readonly key?: string, readonly status = 400) {
    super(message);
    this.name = 'ProjectSettingError';
  }
}

/** Bounds that keep a project's metadata row small: every list and open reads it. */
export const EXT_LIMITS = { keysPerRequest: 64, valueBytes: 16 * 1024, totalBytes: 128 * 1024 } as const;

const defs = new Map<string, { def: ProjectSettingDef; feature: FeatureId }>();

const SETTING_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

/**
 * Adds a feature's definitions. A definition is dropped, and named in the
 * returned problems, when its id is not '<featureId>.<name>', another
 * feature already defines it, or it has no validate function. Registering
 * the same feature again replaces its definitions (one process may build
 * more than one app, as the tests do).
 */
export function registerProjectSettings(feature: FeatureId, list: readonly ProjectSettingDef[]): string[] {
  const problems: string[] = [];
  for (const [id, entry] of defs) if (entry.feature === feature) defs.delete(id);
  for (const def of list) {
    const id = def?.id;
    if (typeof id !== 'string' || !id.startsWith(`${feature}.`) || !SETTING_NAME.test(id.slice(feature.length + 1))) {
      problems.push(`${feature}: project setting id ${JSON.stringify(id)} is not '${feature}.<name>'`);
      continue;
    }
    if (typeof def.validate !== 'function') { problems.push(`${id}: has no validate function`); continue; }
    const other = defs.get(id);
    if (other) { problems.push(`${id}: already defined by ${other.feature}`); continue; }
    defs.set(id, { def, feature });
  }
  return problems;
}

/** The definition of a project setting, or undefined for an unknown id. */
export function projectSettingDef(id: string): ProjectSettingDef | undefined {
  return id === EXT_REV_KEY ? undefined : defs.get(id)?.def;
}

/** Every registered definition, in registration order. */
export function projectSettingDefs(): ProjectSettingDef[] {
  return [...defs.values()].map((e) => e.def);
}

/** A validator that throws counts as a refusal, never as a server error. */
export function validValue(def: ProjectSettingDef, v: unknown): boolean {
  try { return def.validate(v) === true; } catch { return false; }
}

/** The project settings revision: 0 until the first change. */
export function extRev(meta: ProjectMeta): number {
  const r = meta.ext?.[EXT_REV_KEY];
  return typeof r === 'number' && Number.isSafeInteger(r) && r >= 0 ? r : 0;
}

/** The `ext` a client may see: known keys whose definition is not
 *  `clientVisible: false`, without EXT_REV_KEY. routes.ts publicMeta uses it. */
export function publicExt(meta: ProjectMeta): Record<string, unknown> | undefined {
  const ext = meta.ext;
  if (!ext || typeof ext !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [id, v] of Object.entries(ext)) {
    const def = projectSettingDef(id);
    if (!def || def.clientVisible === false || !validValue(def, v)) continue;
    out[id] = v;
    any = true;
  }
  return any ? out : undefined;
}

/** The keys "Make a copy" carries over (store.copyProject): valid values of
 *  definitions marked `copyWithProject`. The copy starts at revision 0. */
export function copiedExt(meta: ProjectMeta): Record<string, unknown> | undefined {
  const ext = meta.ext;
  if (!ext || typeof ext !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  let any = false;
  for (const [id, v] of Object.entries(ext)) {
    const def = projectSettingDef(id);
    if (!def?.copyWithProject || !validValue(def, v)) continue;
    out[id] = structuredClone(v);
    any = true;
  }
  return any ? out : undefined;
}

/** Key-order-insensitive JSON, so a value set again unchanged is not a change. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates a change against the registered definitions and applies it to
 * `meta.ext` in place, bumping the revision when anything changed. `client`:
 * the request came from PATCH /api/projects/:id/settings, which may only
 * touch `clientWritable` keys. Throws ProjectSettingError, with nothing
 * applied, on an unknown key, a key that is not writable, an invalid or
 * oversized value, or a key both set and unset.
 */
export function applyExtChange(meta: ProjectMeta, set: unknown, unset: unknown, o: { client: boolean }): { changed: boolean; rev: number } {
  if (set !== undefined && !isPlainObject(set)) throw new ProjectSettingError('"set" must be an object of setting ids and values');
  if (unset !== undefined && (!Array.isArray(unset) || unset.some((k) => typeof k !== 'string'))) throw new ProjectSettingError('"unset" must be a list of setting ids');
  const sets = Object.entries((set ?? {}) as Record<string, unknown>);
  const unsets = (unset ?? []) as string[];
  if (sets.length + unsets.length > EXT_LIMITS.keysPerRequest) {
    throw new ProjectSettingError(`At most ${EXT_LIMITS.keysPerRequest} project settings can change in one request`);
  }
  const known = (id: string): ProjectSettingDef => {
    const def = projectSettingDef(id);
    if (!def) throw new ProjectSettingError(`${JSON.stringify(id.slice(0, 100))} is not a project setting`, id.slice(0, 100));
    if (o.client && !def.clientWritable) throw new ProjectSettingError(`The setting ${id} cannot be changed here`, id);
    return def;
  };
  const setIds = new Set<string>();
  for (const [id, v] of sets) {
    const def = known(id);
    setIds.add(id);
    let json: string | undefined;
    try { json = JSON.stringify(v); } catch { json = undefined; }
    if (json === undefined) throw new ProjectSettingError(`The value of ${id} is not a JSON value`, id);
    if (Buffer.byteLength(json) > EXT_LIMITS.valueBytes) throw new ProjectSettingError(`The value of ${id} is larger than ${EXT_LIMITS.valueBytes / 1024} KB`, id);
    if (!validValue(def, v)) throw new ProjectSettingError(`The value of ${id} is not valid`, id);
  }
  for (const id of unsets) {
    known(id);
    if (setIds.has(id)) throw new ProjectSettingError(`The setting ${id} cannot be both set and unset`, id);
  }

  const next: Record<string, unknown> = { ...(isPlainObject(meta.ext) ? meta.ext : {}) };
  let changed = false;
  for (const id of unsets) {
    if (Object.hasOwn(next, id)) { delete next[id]; changed = true; }
  }
  for (const [id, v] of sets) {
    if (Object.hasOwn(next, id) && stableJson(next[id]) === stableJson(v)) continue;
    next[id] = structuredClone(v);
    changed = true;
  }
  const rev = extRev(meta);
  if (!changed) return { changed: false, rev };
  if (Buffer.byteLength(JSON.stringify(next)) > EXT_LIMITS.totalBytes) {
    throw new ProjectSettingError(`The project's settings would take more than ${EXT_LIMITS.totalBytes / 1024} KB`);
  }
  next[EXT_REV_KEY] = rev + 1;
  meta.ext = next;
  return { changed: true, rev: rev + 1 };
}
