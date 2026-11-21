/**
 * The project's label and bibliography indexes (WP15's routes), cached per
 * project and branch for the link hint, which must answer synchronously.
 * Any edit or file change marks them stale; the next look refetches.
 */
import { apiRequest } from '../../api';

/** GET /api/projects/:id/labels?detail=1 (srv/labels.ts LabelDetail), the fields used here. */
export interface LabelEntry { label: string; file: string; line?: number; from?: number }
/** GET /api/projects/:id/bib (srv/bib.ts BibEntry), the fields used here. */
export interface BibEntry { key: string; file: string; line?: number; type?: string }

type Kind = 'labels' | 'bib';

interface Cached<T> { data: T[] | null; at: number; dirty: boolean; inflight: Promise<T[]> | null }

/** Older than this, a cached index is refetched on the next look. */
export const FRESH_MS = 30_000;

const caches = new Map<string, Cached<unknown>>();
const keyOf = (kind: Kind, projectId: string, branch: string) => `${kind}\u0000${projectId}\u0000${branch}`;

function urlFor(kind: Kind, projectId: string, branch: string): string {
  const b = encodeURIComponent(branch);
  return kind === 'labels'
    ? `/api/projects/${encodeURIComponent(projectId)}/labels?branch=${b}&detail=1`
    : `/api/projects/${encodeURIComponent(projectId)}/bib?branch=${b}`;
}

function entry<T>(kind: Kind, projectId: string, branch: string): Cached<T> {
  const k = keyOf(kind, projectId, branch);
  let c = caches.get(k) as Cached<T> | undefined;
  if (!c) { c = { data: null, at: 0, dirty: true, inflight: null }; caches.set(k, c as Cached<unknown>); }
  return c;
}

const fresh = (c: Cached<unknown>) => !!c.data && !c.dirty && Date.now() - c.at < FRESH_MS;

function fetchInto<T>(kind: Kind, projectId: string, branch: string, c: Cached<T>): Promise<T[]> {
  if (c.inflight) return c.inflight;
  c.dirty = false;
  const p = apiRequest<T[]>(urlFor(kind, projectId, branch)).then((data) => {
    c.data = Array.isArray(data) ? data : [];
    c.at = Date.now();
    return c.data;
  }).catch(() => {
    c.dirty = true;
    return c.data ?? [];
  }).finally(() => { c.inflight = null; });
  c.inflight = p;
  return p;
}

/** What is cached now (null: nothing yet), and whether it is fresh; a stale index is refetched in the background. */
export function peekIndex<T>(kind: Kind, projectId: string, branch: string): { data: T[] | null; fresh: boolean } {
  const c = entry<T>(kind, projectId, branch);
  const isFresh = fresh(c);
  if (!isFresh) void fetchInto(kind, projectId, branch, c);
  return { data: c.data, fresh: isFresh };
}

/** The index, fetched again unless it is fresh (or always, with `force`). */
export function loadIndex<T>(kind: Kind, projectId: string, branch: string, force = false): Promise<T[]> {
  const c = entry<T>(kind, projectId, branch);
  if (!force && fresh(c)) return Promise.resolve(c.data!);
  return fetchInto(kind, projectId, branch, c);
}

/** Something changed the project's text or files: both indexes are stale. */
export function markStale(projectId: string, branch: string): void {
  for (const kind of ['labels', 'bib'] as const) {
    const c = caches.get(keyOf(kind, projectId, branch));
    if (c) c.dirty = true;
  }
}

/** Tests only. */
export function __resetIndexes(): void {
  caches.clear();
}
