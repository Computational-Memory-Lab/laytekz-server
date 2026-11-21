/**
 * The project's labels as WP15's GET /api/projects/:id/labels?detail=1 gives
 * them (kind, title, file, line), cached per project and branch,
 * stale-while-revalidate: a reader gets the cached list at once and a
 * refetch starts behind it.
 */
import { apiRequest } from '../../api';
import type { LabelDetail } from './refCommands';

const MAX_AGE_MS = 15_000;

interface Entry { labels: LabelDetail[] | null; at: number; pending: Promise<LabelDetail[]> | null }
const cache = new Map<string, Entry>();

const keyOf = (projectId: string, branch: string) => `${projectId}::${branch}`;

/** The last list for this project and branch (empty before the first one). */
export function cachedLabels(projectId: string, branch: string): LabelDetail[] {
  return cache.get(keyOf(projectId, branch))?.labels ?? [];
}

/** Fetches unless a fresh list is cached (or `fresh`); a failed fetch keeps the old list. */
export function loadLabels(projectId: string, branch: string, fresh = false): Promise<LabelDetail[]> {
  const key = keyOf(projectId, branch);
  const entry = cache.get(key) ?? { labels: null, at: 0, pending: null };
  cache.set(key, entry);
  if (entry.pending) return entry.pending;
  if (!fresh && entry.labels && Date.now() - entry.at < MAX_AGE_MS) return Promise.resolve(entry.labels);
  entry.pending = apiRequest<LabelDetail[]>(`/api/projects/${encodeURIComponent(projectId)}/labels?branch=${encodeURIComponent(branch)}&detail=1`)
    .then((labels) => {
      if (!Array.isArray(labels)) return entry.labels ?? [];
      entry.labels = labels.filter((l) => l && typeof l.label === 'string' && typeof l.file === 'string');
      entry.at = Date.now();
      return entry.labels;
    })
    .catch(() => entry.labels ?? [])
    .finally(() => { entry.pending = null; });
  return entry.pending;
}

/** Marks the list stale (an edit may have added a label); the next reader refetches. */
export function staleLabels(projectId: string, branch: string): void {
  const entry = cache.get(keyOf(projectId, branch));
  if (entry) entry.at = 0;
}

/** For tests. */
export function resetLabelCache(): void {
  cache.clear();
}
