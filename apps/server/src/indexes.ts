import * as store from './store.js';
import { flushBranchDocs, contentVersion } from './collab.js';
import { parseBib, type BibEntry } from './bib.js';
import { wordCountSummary } from './wordcount/count.js'; // Galley: V2 (WP24) the rule-based count
import { isHiddenPath } from './util.js';
import { labelsIn, theoremsIn, markDuplicates, appendixFiles, type LabelDetail, type LabelEntry } from './labels.js'; // Galley: V2 (WP15) label kinds and titles
import { citeSetupOf, type CiteSetup } from './citesetup.js'; // Galley: V2 (WP15) citation package detection
import { loadedBibFiles } from './bibload.js'; // Galley: V2 (WP15)

/**
 * Per-branch derived indexes (\cite keys, \label targets, document word
 * count) shared by the REST routes and the MCP tools — one implementation,
 * never two copies (SECURITY.md: shared functions). Each walks the whole
 * branch (readdir + read + parse every .bib/.tex), so results are cached per
 * branch keyed by the content version that every write path bumps: a hit
 * costs a Map lookup, a miss exactly one walk. Every entry point flushes open
 * documents first so pending live edits count.
 */

const bibIndexCache = new Map<string, { v: number; entries: BibEntry[] }>();
const labelIndexCache = new Map<string, { v: number; labels: LabelDetail[] }>(); // Galley: V2 (WP15) LabelDetail, keyed by root too
const citeSetupCache = new Map<string, { v: number; body: CiteSetup }>(); // Galley: V2 (WP15)

export type { LabelEntry, LabelDetail } from './labels.js'; // Galley: V2 (WP15) the types moved to labels.ts
export type { CiteSetup } from './citesetup.js'; // Galley: V2 (WP15)
export interface WordCount { rootFile: string; total: number; files: Record<string, number> }

function versionKey(projectId: string, branch: string): { key: string; v: number } {
  flushBranchDocs(projectId, branch); // may bump the version (pending edits reach disk)
  return { key: `${projectId}::${branch}`, v: contentVersion(projectId, branch) };
}

export function bibIndex(projectId: string, branch: string): BibEntry[] {
  const { key, v } = versionKey(projectId, branch);
  const hit = bibIndexCache.get(key);
  if (hit && hit.v === v) return hit.entries;
  const entries: BibEntry[] = [];
  for (const f of store.listFiles(projectId, branch)) {
    if (f.type === 'file' && f.path.endsWith('.bib')) {
      try {
        entries.push(...parseBib(store.readFile(projectId, branch, f.path).toString('utf8'), f.path));
      } catch { /* skip broken bib */ }
    }
  }
  bibIndexCache.set(key, { v, entries });
  return entries;
}

/**
 * Galley: V2 (WP15). Every \label in the branch's .tex files with its kind,
 * environment, title, line and offset (labels.ts); commented-out labels are
 * not labels. Theorem names come from every file's \newtheorem; files
 * included after the root graph's \appendix give appendix headings. The
 * entries extend V1's {label, file}: the MCP tool maps back to that shape.
 */
export async function labelIndex(projectId: string, branch: string): Promise<LabelDetail[]> {
  const { key: branchKey, v } = versionKey(projectId, branch);
  const rootFile = (await store.readMeta(projectId).catch(() => null))?.rootFile ?? 'main.tex';
  const key = `${branchKey}::${rootFile}`;
  const hit = labelIndexCache.get(key);
  if (hit && hit.v === v) return hit.labels;
  const texts = new Map<string, string>();
  for (const f of store.listFiles(projectId, branch)) {
    if (f.type !== 'file' || !f.path.endsWith('.tex') || isHiddenPath(f.path)) continue;
    try { texts.set(f.path, store.readFile(projectId, branch, f.path).toString('utf8')); } catch { /* skip */ }
  }
  const theorems = new Map<string, string>();
  for (const text of texts.values()) theoremsIn(text, theorems);
  const appendix = appendixFiles(rootFile, (p) => texts.get(p) ?? null);
  const labels: LabelDetail[] = [];
  for (const [file, text] of texts) labels.push(...labelsIn(text, file, { theorems, appendix: appendix.has(file) }));
  markDuplicates(labels);
  labelIndexCache.set(key, { v, labels });
  return labels;
}

/** Galley: V2 (WP15). V1's label shape, for callers that promised it. */
export function compactLabels(labels: readonly LabelEntry[]): LabelEntry[] {
  return labels.map(({ label, file }) => ({ label, file }));
}

/**
 * Galley: V2 (WP15). The citation family, cross-reference packages and loaded
 * .bib files of the root file's preamble (citesetup.ts), cached per content
 * version and root file like wordCount.
 */
export function citeSetup(projectId: string, branch: string, rootFile: string): CiteSetup {
  const { key: branchKey, v } = versionKey(projectId, branch);
  const key = `${branchKey}::${rootFile}`;
  const hit = citeSetupCache.get(key);
  if (hit && hit.v === v) return hit.body;
  const read = (p: string): string | null => {
    if (isHiddenPath(p)) return null;
    try { return store.readFile(projectId, branch, p).toString('utf8'); } catch { return null; }
  };
  const body = citeSetupOf(read, rootFile);
  const existing = new Set(store.listFiles(projectId, branch).filter((f) => f.type === 'file').map((f) => f.path));
  const sources = body.files.map((p) => ({ path: p, text: read(p) ?? '', editable: true }));
  body.bibFiles = loadedBibFiles(sources, rootFile, existing);
  citeSetupCache.set(key, { v, body });
  return body;
}

/** Galley: V2 (WP24): the count under the project's word-count rule (wordcount/count.ts, cached there by
 *  content version, root file and rule). `rootFile`, `total` and `files` keep their names, now counted
 *  words in document order, with total === Σ files; the compact breakdown rides along. */
export async function wordCount(projectId: string, branch: string, userId?: string | null) {
  return wordCountSummary(projectId, branch, userId, bibIndex);
}
