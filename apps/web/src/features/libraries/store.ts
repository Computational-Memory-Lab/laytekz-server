/**
 * Libraries (F8): the project's links as last read from the server, and the
 * renamed-key notices. The read-only rule reads the links synchronously; the
 * plugin panels (plugins/zotero) tell this module about changes through the
 * window event below, because plugins cannot import app code.
 */
import { withBase } from '../../basePath';
import { normalizeLinks, normalizeRenames, type KeyRename, type LibraryLink } from './model';

/** Window event the plugin panels dispatch: `{type:'changed'|'renamed', projectId, provider?, linkId?, renames?}`. */
export const LIBRARIES_EVENT = 'laytekz:libraries';

export interface LibrariesEventDetail {
  type: 'changed' | 'renamed';
  projectId: string;
  branch?: string;
  provider?: string;
  linkId?: string;
  renames?: unknown;
}

const links = new Map<string, LibraryLink[]>();
/** Projects whose server has no links API (404): never asked again this tab. */
const unsupported = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

const emit = () => { version++; for (const fn of [...listeners]) { try { fn(); } catch { /* a listener's own problem */ } } };

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export const storeVersion = (): number => version;

export function linksFor(projectId: string): readonly LibraryLink[] {
  return links.get(projectId) ?? [];
}

const sameLinks = (a: readonly LibraryLink[], b: readonly LibraryLink[]) => JSON.stringify(a) === JSON.stringify(b);

/** Reads GET /api/projects/:id/libraries. Returns true when the list changed. Failures keep the last list. */
export async function refreshLinks(projectId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (unsupported.has(projectId)) return false;
  let next: LibraryLink[];
  try {
    const res = await fetchImpl(withBase(`/api/projects/${encodeURIComponent(projectId)}/libraries`));
    if (res.status === 404) { unsupported.add(projectId); return false; }
    if (!res.ok) return false;
    next = normalizeLinks(await res.json());
  } catch {
    return false;
  }
  if (sameLinks(linksFor(projectId), next)) return false;
  links.set(projectId, next);
  emit();
  return true;
}

/** Test seam. */
export function setLinksForTest(projectId: string, l: LibraryLink[] | null): void {
  if (l) links.set(projectId, l); else links.delete(projectId);
  unsupported.delete(projectId);
  emit();
}

// ---- Renamed-key notices, per project and branch ----

export interface RenameNotice { provider: string; linkId: string | null; renames: KeyRename[] }

const notices = new Map<string, RenameNotice>();
const noticeKey = (projectId: string, branch: string) => `${projectId}\u0000${branch}`;

export function noticeFor(projectId: string, branch: string): RenameNotice | null {
  return notices.get(noticeKey(projectId, branch)) ?? null;
}

/** Adds renames to the notice (a later sync's pairs merge into an open notice). */
export function addRenames(projectId: string, branch: string, provider: string, linkId: string | null, raw: unknown): void {
  const renames = normalizeRenames(raw);
  if (!renames.length) return;
  const k = noticeKey(projectId, branch);
  const prev = notices.get(k);
  const merged = new Map((prev?.renames ?? []).map((r) => [r.from, r.to]));
  for (const r of renames) merged.set(r.from, r.to);
  notices.set(k, { provider, linkId, renames: [...merged].map(([from, to]) => ({ from, to })) });
  emit();
}

export function dismissNotice(projectId: string, branch: string): void {
  if (notices.delete(noticeKey(projectId, branch))) emit();
}
