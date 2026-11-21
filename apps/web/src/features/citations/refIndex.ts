/**
 * What the server knows about the document's citations (WP15's
 * GET /api/projects/:id/cite-setup), cached per project and branch,
 * stale-while-revalidate: a reader gets the cached answer at once and a
 * refetch starts behind it. The bib entries themselves stay in
 * editor/latexExtras.ts (loadBib, cachedBib), shared with \cite completion.
 */
import { apiRequest } from '../../api';
import type { CiteFamily } from './citeCommands';

/** The wire type (apps/server/src/citesetup.ts CiteSetup); only what the client reads. */
export interface CiteSetup {
  rootFile: string;
  documentClass: string | null;
  family: CiteFamily;
  familySource: string;
  biblatexStyle: string | null;
  natbibCommands: boolean;
  apa: boolean;
  /** The picker header: "biblatex · APA", "natbib", "BibTeX". */
  label: string;
  packages: string[];
  bibFiles: string[];
}

const MAX_AGE_MS = 15_000;

interface Entry { setup: CiteSetup | null; at: number; pending: Promise<CiteSetup | null> | null }
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();

const keyOf = (projectId: string, branch: string) => `${projectId}::${branch}`;

/** The last answer for this project and branch, or null before the first one. */
export function cachedSetup(projectId: string, branch: string): CiteSetup | null {
  return cache.get(keyOf(projectId, branch))?.setup ?? null;
}

/** Fetches unless a fresh answer is cached (or `fresh`); a failed fetch keeps the old answer. */
export function loadSetup(projectId: string, branch: string, fresh = false): Promise<CiteSetup | null> {
  const key = keyOf(projectId, branch);
  const entry = cache.get(key) ?? { setup: null, at: 0, pending: null };
  cache.set(key, entry);
  if (entry.pending) return entry.pending;
  if (!fresh && entry.setup && Date.now() - entry.at < MAX_AGE_MS) return Promise.resolve(entry.setup);
  entry.pending = apiRequest<CiteSetup>(`/api/projects/${encodeURIComponent(projectId)}/cite-setup?branch=${encodeURIComponent(branch)}`)
    .then((setup) => {
      if (!setup || typeof setup !== 'object' || typeof setup.family !== 'string') return entry.setup;
      entry.setup = setup;
      entry.at = Date.now();
      listeners.forEach((fn) => fn());
      return setup;
    })
    .catch(() => entry.setup)
    .finally(() => { entry.pending = null; });
  return entry.pending;
}

/** Marks the answer stale (an edit may have changed the preamble); the next reader refetches. */
export function staleSetup(projectId: string, branch: string): void {
  const entry = cache.get(keyOf(projectId, branch));
  if (entry) entry.at = 0;
}

/** Called after each new answer. Returns the unsubscribe. */
export function onSetup(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** For tests. */
export function resetSetupCache(): void {
  cache.clear();
}
