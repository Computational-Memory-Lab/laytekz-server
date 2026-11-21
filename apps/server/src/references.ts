import { createHash } from 'node:crypto';
import * as store from './store.js';
import { ensureWorktree, checkpointPathsHeld, withRepoLock, agentCommitMessage } from './gitops.js';
import { flushBranchDocs, refreshBranchDocsFromDisk, scheduleCommit, commitAgentWrite, applyEditsToDoc, openDocContent, bumpFilesSignal } from './collab.js';
import { bibKeys } from './bib.js';
// Galley: V2 (WP16) the lookup engine lives in refs/; this file orchestrates it and keeps V1's exports.
import { referenceTarget, paperBibFormat, addBibLoad, bibLoadedBySource } from './bibload.js';
import { isHiddenPath, rootSiblingPath } from './util.js';
import { refsConfig } from './refs/config.js';
import { idCache, openAlexLow, queryCache, UpstreamError } from './refs/http.js';
import { identify, type QueryKind } from './refs/identify.js';
import {
  applyFieldStyle, bibField, cleanBibtexText, cslToEntry, firstEntryText, formatEntry, parseEntry, protectEntryTitle,
  sanitizeBibtex, withKey, entryKey, type BibFieldValue, type BibFormat,
} from './refs/bibtex.js';
import { makeKey, uniqueKey, validKey, type KeyStyle } from './refs/keys.js';
import { findSamePaper, mergeCandidates, titleSimilarity, type Candidate } from './refs/merge.js';
import { doiHopAllowed, fetchDoiBibtex } from './refs/sources/doi.js';
import { searchCrossref } from './refs/sources/crossref.js';
import { openAlexToCsl, openAlexWork, searchOpenAlex, type OpenAlexWork } from './refs/sources/openalex.js';
import { arxivRecord } from './refs/sources/arxiv.js';
import { pmidForPmcid, pubmedRecord, searchPubmed } from './refs/sources/pubmed.js';
import { searchDatacite } from './refs/sources/datacite.js';
import { bookByIsbn } from './refs/sources/openlibrary.js';
import { searchSemanticScholar } from './refs/sources/semanticscholar.js';
import { projectLinks } from './refs/link.js'; // Galley: V2 (WP35) every linked .bib is synced

/**
 * Online references: look a query up (identifiers, titles, pasted BibTeX or
 * citations) across the free bibliographic services, preview the entry a
 * project would get, append it to a .bib, and take an append back. The V1
 * entry points (fetchBibEntry, searchWorks, addReference) keep their
 * signatures for the old routes and MCP `references_add`.
 */

export { doiHopAllowed };
export type { Candidate };

// ---------------------------------------------------------------- V1 entry points

export interface SearchHit { id: string; doi: string | null; title: string; authors: string; year: number | null; venue: string }

/** Full-text search (V1's /api/references/search shape): OpenAlex, or Crossref once OpenAlex's daily budget runs low. */
export async function searchWorks(query: string, limit = 12): Promise<SearchHit[]> {
  const hit = (c: Candidate, id: string): SearchHit => ({
    id,
    doi: c.doi ?? (c.arxiv ? `10.48550/arXiv.${c.arxiv}` : null),
    title: c.title,
    authors: c.authors.slice(0, 4).join(', ') + (c.authors.length > 4 ? ', et al.' : ''),
    year: c.year,
    venue: c.venue,
  });
  if (!openAlexLow()) {
    try {
      return (await searchOpenAlex(query, limit)).map((c) => hit(c, c.openalex ?? ''));
    } catch (err) {
      if (!(err instanceof UpstreamError && err.status === 429)) throw err;
    }
  }
  return (await searchCrossref(query, limit)).map((c, i) => hit(c, `crossref${i + 1}`));
}

/** V1's synthesized arXiv entry (Atom metadata), kept byte-identical for MCP. */
function legacyArxivEntry(rec: { id: string; title: string; authors: string[]; published: string }): string {
  const year = rec.published.slice(0, 4);
  const authorField = rec.authors.map((a) => {
    const parts = a.split(' ');
    const last = parts.pop();
    return `${last}, ${parts.join(' ')}`;
  }).join(' and ');
  const fields: BibFieldValue[] = [
    { name: 'title', value: bibField(rec.title), bare: false },
    { name: 'author', value: bibField(authorField), bare: false },
    { name: 'year', value: year, bare: false },
    { name: 'eprint', value: rec.id, bare: false },
    { name: 'archiveprefix', value: 'arXiv', bare: false },
    { name: 'url', value: `https://arxiv.org/abs/${rec.id}`, bare: false },
  ];
  return formatEntry('article', entryKey(fields, `anon${year}`), fields);
}

/** V1's synthesized OpenAlex entry, kept for MCP. */
function legacyOpenAlexEntry(w: OpenAlexWork): string {
  const authorField = (w.authorships ?? []).map((a) => {
    const n = a.author?.display_name || '';
    const parts = n.split(' ');
    const last = parts.pop();
    return last ? `${last}, ${parts.join(' ')}` : n;
  }).join(' and ');
  const year = w.publication_year ?? '';
  const venue = w.primary_location?.source?.display_name || '';
  const fields: BibFieldValue[] = [
    { name: 'title', value: bibField(String(w.title || w.display_name || 'Untitled')), bare: false },
    { name: 'author', value: bibField(authorField), bare: false },
    { name: 'year', value: String(year), bare: false },
    ...(venue ? [{ name: 'journaltitle', value: bibField(venue), bare: false }] : []),
    { name: 'url', value: String(w.id), bare: false },
  ];
  return formatEntry('article', entryKey(fields, `anon${year}`), fields);
}

/** BibTeX (V1 key rule) for a DOI, doi.org URL, arXiv id or OpenAlex id; null when nothing resolves. */
export async function fetchBibEntry(query: string): Promise<string | null> {
  const q = query.trim();
  const oa = q.match(/(?:openalex[:/]|openalex\.org\/)?(W\d{2,})/i);
  if (/openalex/i.test(q) && oa) return legacyOpenAlex(oa[1]);
  const doi = q.match(/10\.\d{4,9}\/[^\s"']+/);
  if (doi) { const b = await fetchDoiBibtex(doi[0]); return b ? sanitizeBibtex(b) : null; }
  const arxiv = q.match(/(?:arxiv:|arxiv\.org\/abs\/)?(\d{4}\.\d{4,5})(v\d+)?/i);
  if (arxiv) {
    // the DataCite record keeps the first version's year; the Atom feed is the fallback
    const viaDoi = await fetchDoiBibtex(`10.48550/arXiv.${arxiv[1]}`).catch(() => null);
    if (viaDoi) return sanitizeBibtex(viaDoi);
    const rec = await arxivRecord(arxiv[1]);
    return rec ? legacyArxivEntry(rec) : null;
  }
  if (oa) return legacyOpenAlex(oa[1]);
  return null;
}

async function legacyOpenAlex(id: string): Promise<string | null> {
  const w = await openAlexWork(id);
  if (!w) return null;
  const d = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//i, '') : null;
  if (d) { try { const b = await fetchDoiBibtex(d); if (b) return sanitizeBibtex(b); } catch { /* synthesize */ } }
  return legacyOpenAlexEntry(w);
}

// ---------------------------------------------------------------- lookup

export type LookupFilter = 'all' | 'medicine' | 'datasets';
export interface LookupError { source: string; message: string }
export interface LookupResult {
  kind: QueryKind;
  results: Candidate[];
  errors: LookupError[];
  /** A plain sentence for the panel (the OpenAlex budget, a weak citation match). */
  notice?: string;
  /** For free text: the same query on Google Scholar, opened by the user's own browser. The server never contacts Scholar. */
  scholarUrl?: string;
}

const SOURCE_TIMEOUT_MS = 4000;

async function withTimeout<T>(p: Promise<T>, source: string, errors: LookupError[]): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new UpstreamError(`${source} did not answer in time`)), SOURCE_TIMEOUT_MS); })]);
  } catch (err) {
    errors.push({ source, message: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function candidateFromEntry(entry: string, id: string, source: string, extra: Partial<Candidate> = {}): Candidate | null {
  const p = parseEntry(entry);
  if (!p) return null;
  const get = (n: string) => p.fields.find((f) => f.name === n)?.value ?? '';
  const authors = get('author').split(/\s+and\s+/i).map((a) => a.replace(/[{}]/g, '').trim()).filter(Boolean)
    .map((a) => (a.includes(',') ? `${a.split(',').slice(1).join(',').trim()} ${a.split(',')[0].trim()}`.trim() : a));
  const doi = get('doi') || undefined;
  const eprint = get('eprint') || undefined;
  return {
    id, source,
    title: get('title').replace(/[{}]/g, '') || 'Untitled',
    authors,
    year: Number(/\d{4}/.exec(get('year') || get('date'))?.[0]) || null,
    venue: (get('journal') || get('journaltitle') || get('booktitle') || get('publisher') || get('howpublished')).replace(/[{}]/g, ''),
    type: p.type,
    doi: doi && !/^10\.48550\//i.test(doi) ? doi : undefined,
    arxiv: eprint ?? (doi && /^10\.48550\/arxiv\./i.test(doi) ? doi.replace(/^10\.48550\/arxiv\./i, '') : undefined),
    pmid: get('pmid') || undefined,
    isbn: get('isbn') || undefined,
    rank: 0,
    ...extra,
  };
}

/** Free-text search across the sources the filter picks, merged. */
async function searchText(q: string, filter: LookupFilter, errors: LookupError[]): Promise<{ results: Candidate[]; notice?: string }> {
  const cfg = refsConfig();
  const jobs: Array<Promise<Candidate[] | null>> = [];
  let notice: string | undefined;
  if (filter === 'medicine') {
    if (cfg.sources.has('pubmed')) jobs.push(withTimeout(searchPubmed(q), 'PubMed', errors));
  } else if (filter === 'datasets') {
    if (cfg.sources.has('datacite')) jobs.push(withTimeout(searchDatacite(q), 'DataCite', errors));
  } else {
    if (cfg.sources.has('openalex')) {
      if (openAlexLow()) notice = 'Title search is busy until 00:00 UTC. DOI, arXiv and PubMed lookups still work.';
      else jobs.push(withTimeout(searchOpenAlex(q), 'OpenAlex', errors));
    }
    // Crossref always searches alongside, and carries free text alone once the OpenAlex budget runs low
    if (cfg.sources.has('crossref')) jobs.push(withTimeout(searchCrossref(q), 'Crossref', errors));
    if (cfg.sources.has('semanticscholar')) jobs.push(withTimeout(searchSemanticScholar(q), 'Semantic Scholar', errors));
  }
  const lists = (await Promise.all(jobs)).filter((l): l is Candidate[] => !!l);
  return { results: mergeCandidates(lists).slice(0, 20), notice };
}

/** A pasted citation: Crossref's best bibliographic match, flagged when it may be wrong. */
async function searchCitation(q: string, errors: LookupError[]): Promise<{ results: Candidate[]; notice?: string }> {
  if (!refsConfig().sources.has('crossref')) return { results: [] };
  const hits = await withTimeout(searchCrossref(q, 3), 'Crossref', errors);
  if (!hits?.length) return { results: [] };
  const best = { ...hits[0] };
  // a match whose title does not appear in the citation, or a low relevance score, needs a look
  const inText = titleSimilarity(best.title, q) > 0.3 || q.toLowerCase().includes(best.title.toLowerCase().slice(0, 40));
  best.weak = (best.score ?? 0) < 60 || !inText;
  return { results: [best, ...hits.slice(1).map((h) => ({ ...h, weak: true }))], notice: best.weak ? 'Check this match: it may not be the paper you pasted.' : undefined };
}

/** One record for an identifier, with its BibTeX already fetched (cached for the preview). */
async function lookupIdentifier(kind: QueryKind, value: string): Promise<Candidate | null> {
  const id = `${kind}:${value}`;
  const raw = await resolveRaw(id);
  if (!raw) return null;
  return candidateFromEntry(raw, id, kind === 'isbn' ? 'openlibrary' : kind === 'pmid' || kind === 'pmcid' ? 'pubmed' : kind === 'openalex' ? 'openalex' : 'doi');
}

export async function lookup(rawQuery: string, filter: LookupFilter = 'all'): Promise<LookupResult> {
  const q = rawQuery.trim().slice(0, 2000);
  const { kind, value } = identify(q);
  const cacheKey = `${filter}|${q}`;
  const cached = queryCache.get(cacheKey) as LookupResult | undefined;
  if (cached) return cached;
  const errors: LookupError[] = [];
  let out: LookupResult;
  if (kind === 'bibtex') {
    const entry = firstEntryText(value);
    const cleaned = entry ? cleanBibtexText(entry) : null;
    const c = cleaned ? candidateFromEntry(cleaned, 'bibtex', 'pasted', { bibtex: cleaned }) : null;
    out = { kind, results: c ? [c] : [], errors: c ? [] : [{ source: 'pasted', message: 'That BibTeX could not be read: check its braces and commas.' }] };
    return out; // never cached: it is the user's own text
  }
  if (kind === 'text' || kind === 'citation') {
    if (q.length < 3) return { kind, results: [], errors: [] };
    const r = kind === 'citation' ? await searchCitation(q, errors) : await searchText(q, filter, errors);
    out = { kind, results: r.results, errors, notice: r.notice, scholarUrl: `https://scholar.google.com/scholar?q=${encodeURIComponent(q)}` };
  } else {
    let c: Candidate | null = null;
    try { c = await lookupIdentifier(kind, value); } catch (err) { errors.push({ source: kind, message: err instanceof Error ? err.message : String(err) }); }
    out = { kind, results: c ? [c] : [], errors };
    if (!c && !errors.length) out.notice = `Nothing was found for that ${kind === 'doi' ? 'DOI' : kind === 'arxiv' ? 'arXiv ID' : kind === 'isbn' ? 'ISBN' : kind === 'openalex' ? 'OpenAlex ID' : 'PubMed ID'}.`;
    if (c?.arxiv && !c.doi) await offerPublished(c);
  }
  if (!errors.length) queryCache.set(cacheKey, out);
  return out;
}

/** An arXiv record's published version, from a free OpenAlex singleton. */
async function offerPublished(c: Candidate): Promise<void> {
  if (!refsConfig().sources.has('openalex') || !c.arxiv) return;
  try {
    const w = await openAlexWork(`doi:10.48550/arXiv.${c.arxiv}`);
    const loc = (w?.locations ?? []).map((l) => l.landing_page_url ?? '').find((u) => /doi\.org\/10\./i.test(u) && !/10\.48550/i.test(u));
    if (loc) c.publishedDoi = loc.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  } catch { /* the offer is optional */ }
}

// ---------------------------------------------------------------- resolving to BibTeX

function arxivMiscEntry(rec: { id: string; title: string; authors: string[]; published: string; doi?: string }): string {
  return cslToEntry({
    type: 'posted-content', title: rec.title,
    author: rec.authors.map((a) => { const p = a.split(/\s+/); const family = p.pop() ?? ''; return { family, given: p.join(' ') }; }),
    year: Number(rec.published.slice(0, 4)) || null, eprint: rec.id, doi: `10.48550/arXiv.${rec.id}`, url: `https://arxiv.org/abs/${rec.id}`,
  }, 'bibtex');
}

/**
 * Raw BibTeX (upstream key, not yet styled) for a candidate id
 * (`doi:…`, `arxiv:…`, `pmid:…`, `pmcid:…`, `isbn:…`, `openalex:W…`), or any
 * query an identifier can be read from. Cached for a day; null when unknown.
 */
export async function resolveRaw(idOrQuery: string): Promise<string | null> {
  let m = /^(doi|arxiv|pmid|pmcid|isbn|openalex):(.+)$/i.exec(idOrQuery.trim());
  if (!m) {
    const it = identify(idOrQuery);
    if (['text', 'citation', 'bibtex'].includes(it.kind)) return null;
    m = ['', it.kind, it.value] as unknown as RegExpExecArray;
  }
  const kind = m[1].toLowerCase();
  const value = m[2].trim();
  const key = `${kind}:${kind === 'doi' ? value.toLowerCase() : value}`;
  const hit = idCache.get(key);
  if (hit !== undefined) return hit;
  let raw: string | null = null;
  if (kind === 'doi') raw = await fetchDoiBibtex(value);
  else if (kind === 'arxiv') {
    raw = await fetchDoiBibtex(`10.48550/arXiv.${value}`).catch(() => null);
    if (!raw) { const rec = await arxivRecord(value); raw = rec ? arxivMiscEntry(rec) : null; }
  } else if (kind === 'pmid' || kind === 'pmcid') {
    const pmid = kind === 'pmcid' ? await pmidForPmcid(value) : value;
    const rec = pmid ? await pubmedRecord(pmid) : null;
    if (rec?.doi) raw = await fetchDoiBibtex(rec.doi).catch(() => null);
    if (raw && rec?.csl.pmid && !/\bpmid\s*=/i.test(raw)) raw = raw.replace(/\}\s*$/, `,\n  pmid = {${rec.csl.pmid}}\n}`);
    if (!raw && rec) raw = cslToEntry(rec.csl, 'bibtex');
  } else if (kind === 'isbn') {
    const csl = await bookByIsbn(value);
    raw = csl ? cslToEntry(csl, 'bibtex') : null;
  } else if (kind === 'openalex') {
    const w = await openAlexWork(value);
    const d = w?.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//i, '') : null;
    if (d) raw = await fetchDoiBibtex(d).catch(() => null);
    if (!raw && w) raw = cslToEntry(openAlexToCsl(w), 'bibtex');
  }
  idCache.set(key, raw);
  return raw;
}

// ---------------------------------------------------------------- the project side

export type FieldStyle = 'auto' | 'biblatex' | 'bibtex';
export interface ReferenceOptions { keyStyle?: KeyStyle; protectCaps?: boolean; fieldStyle?: FieldStyle; defaultBib?: string }

export class ReferenceError extends Error {
  constructor(message: string, public code: 'not-utf8' | 'bad-bibtex' | 'bad-key' | 'bad-path' | 'not-found' | 'changed' | 'synced', public status = 400) { super(message); }
}

export const NOT_UTF8 = "This .bib isn't UTF-8, so adding to it would damage it. Choose another file.";
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** A .bib's text for editing: null when it does not exist; throws `not-utf8` when its bytes are not UTF-8. */
function readBibStrict(projectId: string, branch: string, bibFile: string): string | null {
  let buf: Buffer;
  try { buf = store.readFile(projectId, branch, bibFile); } catch { return null; }
  try { return strictUtf8.decode(buf); } catch { throw new ReferenceError(NOT_UTF8, 'not-utf8', 409); }
}

function readBibLoose(projectId: string, branch: string, bibFile: string): string {
  const live = openDocContent(projectId, branch, bibFile);
  if (live !== null) return live;
  try { return store.readFile(projectId, branch, bibFile).toString('utf8'); } catch { return ''; }
}

function bibFilesOn(projectId: string, branch: string): string[] {
  return store.listFiles(projectId, branch).filter((f) => f.type === 'file' && /\.bib$/i.test(f.path) && !isHiddenPath(f.path)).map((f) => f.path);
}

/** Every citation key defined in the branch's .bib files (lowercased by uniqueKey). */
function keysOnBranch(projectId: string, branch: string): Set<string> {
  const keys = new Set<string>();
  for (const f of bibFilesOn(projectId, branch)) for (const k of bibKeys(readBibLoose(projectId, branch, f))) keys.add(k);
  return keys;
}

export interface BibTarget { path: string; exists: boolean; loaded: boolean; synced: boolean; editable: boolean }
export interface Targets { targets: BibTarget[]; default: string; format: BibFormat; rootFile: string }

/** Where a reference can go: every .bib on the branch, plus the default when it does not exist yet. */
export async function referenceTargets(projectId: string, branch: string, opts: ReferenceOptions = {}): Promise<Targets> {
  await ensureWorktree(projectId, branch);
  const meta = await store.readMeta(projectId);
  const linked = new Set(projectLinks(meta).map((l) => l.bibFile)); // Galley: V2 (WP35)
  const synced = meta.zotero?.bibFile ?? projectLinks(meta)[0]?.bibFile ?? null;
  const fallback = rootSiblingPath(meta.rootFile, 'references.bib');
  const chosen = referenceTarget(projectId, branch, meta.rootFile, synced, fallback, (p) => !isHiddenPath(p));
  const files = bibFilesOn(projectId, branch);
  const def = opts.defaultBib && !isHiddenPath(opts.defaultBib) && /\.bib$/i.test(opts.defaultBib) && opts.defaultBib !== synced ? opts.defaultBib : chosen.bibFile;
  const all = [...new Set([...files, def])];
  const targets = all.map((p) => {
    const exists = files.includes(p);
    let editable = true;
    if (exists) { try { readBibStrict(projectId, branch, p); } catch { editable = false; } }
    return { path: p, exists, loaded: bibLoadedBySource(projectId, branch, meta.rootFile, p), synced: p === synced || linked.has(p), editable };
  });
  return { targets, default: def, format: chosen.format, rootFile: meta.rootFile };
}

function formatFor(projectId: string, branch: string, style: FieldStyle | undefined): BibFormat {
  return style === 'biblatex' || style === 'bibtex' ? style : paperBibFormat(projectId, branch);
}

/** The entry a project would store: cleaned, styled key (unless kept), field names for the paper, capitals protected. */
export function finalizeEntry(raw: string, o: { keyStyle?: KeyStyle; keepKey?: boolean; protectCaps?: boolean; format: BibFormat }): { entry: string; key: string } {
  const text = cleanBibtexText(firstEntryText(raw) ?? raw);
  const p = parseEntry(text);
  if (!p) throw new ReferenceError('That BibTeX could not be read: check its braces and commas.', 'bad-bibtex');
  const key = o.keepKey && validKey(p.key) ? p.key : makeKey(p.fields, o.keyStyle ?? 'authoryear');
  let entry = formatEntry(p.type, key, p.fields);
  entry = applyFieldStyle(entry, o.format);
  if (o.protectCaps !== false) entry = protectEntryTitle(entry);
  return { entry, key };
}

export interface PreviewInput { id?: string; bibtex?: string; key?: string; bibFile?: string }
export interface Preview {
  bibtex: string;
  key: string;
  /** Set when the wanted key was taken by another paper and a suffix was added. */
  keyNote?: string;
  duplicate: { key: string; bibFile: string } | null;
  bibFile: string;
  loaded: boolean;
  targets: BibTarget[];
  format: BibFormat;
}

function duplicateIn(projectId: string, branch: string, entry: string, files: string[]): { key: string; bibFile: string } | null {
  for (const f of files) {
    const hit = findSamePaper(readBibLoose(projectId, branch, f), entry);
    if (hit) return { key: hit.key, bibFile: f };
  }
  return null;
}

function keyNote(wanted: string, got: string): string | undefined {
  return wanted.toLowerCase() === got.toLowerCase() ? undefined : `"${wanted}" is taken by another entry, using "${got}".`;
}

/** What adding would do; writes nothing. */
export async function previewReference(projectId: string, branch: string, input: PreviewInput, opts: ReferenceOptions = {}): Promise<Preview> {
  const t = await referenceTargets(projectId, branch, opts);
  const bibFile = input.bibFile || t.default;
  if (isHiddenPath(bibFile) || !/\.bib$/i.test(bibFile)) throw new ReferenceError('Choose a .bib file.', 'bad-path');
  let raw: string | null = input.bibtex ?? null;
  if (!raw && input.id) raw = await resolveRaw(input.id);
  if (!raw) throw new ReferenceError('No BibTeX was found for that reference.', 'not-found', 404);
  const format = formatFor(projectId, branch, opts.fieldStyle);
  const { entry, key: base } = finalizeEntry(raw, { keyStyle: opts.keyStyle, keepKey: !!input.bibtex, protectCaps: opts.protectCaps, format });
  const wanted = input.key?.trim() || base;
  if (!validKey(wanted)) throw new ReferenceError('A citation key cannot contain spaces, commas, braces, quotes or #%~\\.', 'bad-key');
  const files = [bibFile, ...bibFilesOn(projectId, branch).filter((f) => f !== bibFile)];
  const duplicate = duplicateIn(projectId, branch, entry, files);
  const p = parseEntry(entry)!;
  const key = duplicate ? duplicate.key : uniqueKey(wanted, keysOnBranch(projectId, branch), p.fields, opts.keyStyle);
  const target = t.targets.find((x) => x.path === bibFile);
  return {
    bibtex: withKey(entry, duplicate ? wanted : key),
    key,
    keyNote: duplicate ? undefined : keyNote(wanted, key),
    duplicate,
    bibFile,
    loaded: target?.loaded ?? false,
    targets: t.targets,
    format,
  };
}

export interface InsertInput { bibtex: string; key?: string; bibFile?: string; loadBib?: boolean; force?: boolean }
export interface Inserted {
  key: string;
  bibFile: string;
  duplicate: boolean;
  created: boolean;
  /** SHA-256 of the appended entry: /references/remove takes it back while that text is unchanged. */
  entryHash: string | null;
  keyNote?: string;
  loaded: boolean;
  /** The \addbibresource or \bibliography edit made because loadBib was set. */
  loadAdded?: { file: string; command: string } | null;
}

export const hashEntry = (entry: string) => createHash('sha256').update(entry.trim()).digest('hex');

/**
 * Append final BibTeX to a .bib. The same paper already in the project is
 * reported (nothing written) unless `force`; a key another paper holds gets
 * a suffix. A file that is not UTF-8 is refused untouched. An open .bib is
 * edited through its live doc, so the append merges with whatever anyone is
 * typing; a closed one is written on disk.
 */
export async function insertReference(projectId: string, branch: string, input: InsertInput, opts: ReferenceOptions = {}): Promise<Inserted> {
  const meta = await store.readMeta(projectId);
  await ensureWorktree(projectId, branch);
  const bibFile = input.bibFile || (await referenceTargets(projectId, branch, opts)).default;
  if (isHiddenPath(bibFile) || !/\.bib$/i.test(bibFile)) throw new ReferenceError('Choose a .bib file.', 'bad-path');
  if (meta.zotero?.bibFile === bibFile || projectLinks(meta).some((l) => l.bibFile === bibFile)) throw new ReferenceError('That file is synced from a reference manager and each sync replaces it. Choose another file.', 'synced', 409); // Galley: V2 (WP35)
  const format = formatFor(projectId, branch, opts.fieldStyle);
  // the client sends what the preview showed (maybe edited): keep its key, clean its text
  const { entry: cleaned, key: given } = finalizeEntry(input.bibtex, { keepKey: true, protectCaps: false, format });
  const wanted = input.key?.trim() || given;
  if (!validKey(wanted)) throw new ReferenceError('A citation key cannot contain spaces, commas, braces, quotes or #%~\\.', 'bad-key');

  flushBranchDocs(projectId, branch);
  // synchronous from the checks to the write: no keystroke lands in between
  const live = openDocContent(projectId, branch, bibFile);
  const existing = readBibStrict(projectId, branch, bibFile);
  if (live !== null && live.includes('�')) throw new ReferenceError(NOT_UTF8, 'not-utf8', 409);
  const files = [bibFile, ...bibFilesOn(projectId, branch).filter((f) => f !== bibFile)];
  const loadedBefore = bibLoadedBySource(projectId, branch, meta.rootFile, bibFile);
  if (!input.force) {
    const dup = duplicateIn(projectId, branch, cleaned, files);
    if (dup) return { key: dup.key, bibFile: dup.bibFile, duplicate: true, created: false, entryHash: null, loaded: loadedBefore };
  }
  const p = parseEntry(cleaned)!;
  const key = uniqueKey(wanted, keysOnBranch(projectId, branch), p.fields, opts.keyStyle);
  const entry = withKey(cleaned, key);
  const text = live ?? existing ?? '';
  const sep = text === '' ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  if (live !== null && applyEditsToDoc(projectId, branch, bibFile, [{ from: live.length, to: live.length, insert: `${sep}${entry}\n` }]) === 'applied') {
    bumpFilesSignal(projectId, branch);
    scheduleCommit(projectId, branch);
  } else {
    const crlf = (existing ?? '').includes('\r\n');
    const add = `${sep}${entry}\n`;
    store.writeFile(projectId, branch, bibFile, (existing ?? '') + (crlf ? add.replace(/\n/g, '\r\n') : add));
    refreshBranchDocsFromDisk(projectId, branch, [bibFile]);
    scheduleCommit(projectId, branch);
  }
  let loadAdded: Inserted['loadAdded'] = null;
  let loaded = loadedBefore;
  if (input.loadBib && !loadedBefore) {
    const r = addBibLoad(projectId, branch, meta.rootFile, bibFile);
    if (r.added) loadAdded = { file: r.added.file, command: r.added.command };
    loaded = r.state.loaded;
  }
  return { key, bibFile, duplicate: false, created: existing === null && live === null, entryHash: hashEntry(entry), keyNote: keyNote(wanted, key), loaded, loadAdded };
}

/** The [from, to) range that removes the entry whose trimmed text hashes to `entryHash`, with the blank line before it. */
export function removalRange(text: string, entryHash: string): [number, number] | null {
  const starts = [...text.matchAll(/@([a-zA-Z]+)\s*\{/g)].map((m) => m.index!);
  for (let i = 0; i < starts.length; i++) {
    const slice = text.slice(starts[i], starts[i + 1] ?? text.length);
    const trimmed = slice.trimEnd();
    if (hashEntry(trimmed) !== entryHash) continue;
    let from = starts[i];
    let to = starts[i] + trimmed.length;
    while (from > 0 && /\s/.test(text[from - 1])) from--;
    if (from === 0) while (to < text.length && /\s/.test(text[to])) to++;
    return [from, to];
  }
  return null;
}

/** Take an append back while its exact text is still in the file. */
export async function removeReference(projectId: string, branch: string, bibFile: string, entryHash: string): Promise<{ removed: boolean }> {
  if (isHiddenPath(bibFile) || !/\.bib$/i.test(bibFile)) throw new ReferenceError('Choose a .bib file.', 'bad-path');
  if (!/^[0-9a-f]{64}$/.test(entryHash)) throw new ReferenceError('entryHash must be the hash the add returned.', 'bad-path');
  await ensureWorktree(projectId, branch);
  flushBranchDocs(projectId, branch);
  const live = openDocContent(projectId, branch, bibFile);
  const text = live ?? readBibStrict(projectId, branch, bibFile);
  if (text === null) throw new ReferenceError('That .bib no longer exists.', 'changed', 409);
  const range = removalRange(text, entryHash);
  if (!range) throw new ReferenceError('The entry was changed after it was added, so it was left in place.', 'changed', 409);
  const [from, to] = range;
  if (live !== null && applyEditsToDoc(projectId, branch, bibFile, [{ from, to, insert: '' }]) === 'applied') {
    bumpFilesSignal(projectId, branch);
  } else {
    store.writeFile(projectId, branch, bibFile, text.slice(0, from) + text.slice(to));
    refreshBranchDocsFromDisk(projectId, branch, [bibFile]);
  }
  scheduleCommit(projectId, branch);
  return { removed: true };
}

/** "In project as smith2020" for each result whose paper a branch's .bib already holds. */
export function markInProject(projectId: string, branch: string, results: Candidate[]): Array<Candidate & { inProject?: { key: string; bibFile: string } }> {
  const files = bibFilesOn(projectId, branch).map((f) => ({ f, text: readBibLoose(projectId, branch, f) }));
  return results.map((c) => {
    const author = c.authors.slice(0, 1).map((a) => {
      if (a.includes(',')) return { family: a.split(',')[0].trim(), given: a.split(',').slice(1).join(',').trim() };
      const parts = a.trim().split(/\s+/);
      const family = parts.pop() ?? '';
      return { family, given: parts.join(' ') };
    });
    const probe = c.bibtex ?? cslToEntry({ title: c.title, year: c.year, author, doi: c.doi, eprint: c.arxiv, pmid: c.pmid, isbn: c.isbn });
    for (const { f, text } of files) {
      const hit = findSamePaper(text, probe);
      if (hit) return { ...c, inProject: { key: hit.key, bibFile: f } };
    }
    return c;
  });
}

// ---------------------------------------------------------------- V1's add (old route and MCP)

/** `created`: the .bib did not exist before this call (folders included). */
export interface AddedReference { key: string; bibFile: string; duplicate: boolean; created: boolean }

/**
 * Look a query up and append the entry to `bibFile` on the branch (created
 * if missing). Shared by the REST route and the MCP tool — the caller
 * validates `bibFile` and takes the rate-limit token. Returns null when
 * nothing resolves; upstream failures throw with a user-readable message.
 * With `author` set the write is checkpointed and committed at once like
 * every other agent mutation. `beforeWrite` runs right before the file is
 * written — and not at all when nothing is. `alsoIn`: other .bib files the
 * paper reads; a paper already in one of them is reported there (duplicate,
 * that file) and nothing is written. The same paper is recognised by its
 * identifiers or a near-identical title; a key another paper already holds
 * gets a suffix (smith2020a) instead of citing the wrong paper. A target that
 * is not UTF-8 is refused untouched.
 */
export async function addReference(projectId: string, branch: string, query: string, bibFile: string, author?: string, beforeWrite?: () => void, alsoIn: string[] = [], requester?: string | null): Promise<AddedReference | null> {
  const fetched = await fetchBibEntry(query.trim());
  if (!fetched) return null;
  await ensureWorktree(projectId, branch);
  // Synchronous on purpose: with an author it runs inside the repo lock, and
  // an await between the write and the commit's snapshot would let a
  // keystroke into the attributed commit.
  const append = (): AddedReference & { before: Buffer | null; after: string } => {
    let before: Buffer | null = null;
    try { before = store.readFile(projectId, branch, bibFile); } catch { /* new file */ }
    let existing: string | null = null;
    if (before) { try { existing = strictUtf8.decode(before); } catch { throw new ReferenceError(NOT_UTF8, 'not-utf8', 409); } }
    const same = findSamePaper(existing ?? '', fetched);
    if (same) return { key: same.key, bibFile, duplicate: true, created: false, before, after: existing ?? '' };
    const taken = new Set(bibKeys(existing ?? ''));
    for (const other of alsoIn) {
      let text: string;
      try { text = store.readFile(projectId, branch, other).toString('utf8'); } catch { continue; }
      const found = findSamePaper(text, fetched);
      if (found) return { key: found.key, bibFile: other, duplicate: true, created: false, before, after: existing ?? '' };
      for (const k of bibKeys(text)) taken.add(k);
    }
    const base = [...bibKeys(fetched)][0] ?? '';
    const key = base ? uniqueKey(base, taken) : base;
    const entry = key && key !== base ? withKey(fetched, key) : fetched;
    const after = (existing ?? '').trimEnd() + '\n\n' + entry.trim() + '\n';
    beforeWrite?.();
    store.writeFile(projectId, branch, bibFile, after);
    refreshBranchDocsFromDisk(projectId, branch, [bibFile], author ? { agent: new Map([[bibFile, before]]) } : {});
    if (!author) scheduleCommit(projectId, branch);
    return { key, bibFile, duplicate: false, created: existing === null, before, after };
  };
  if (!author) {
    // The refresh resets every open doc that differs from its file: what was
    // typed but not yet saved, the .bib included, must be on disk first.
    flushBranchDocs(projectId, branch);
    const { key, bibFile: file, duplicate, created } = append();
    return { key, bibFile: file, duplicate, created };
  }
  return withRepoLock(projectId, async () => {
    flushBranchDocs(projectId, branch);
    await checkpointPathsHeld(projectId, branch, [bibFile]);
    flushBranchDocs(projectId, branch);
    const { key, bibFile: file, duplicate, created, before, after } = append();
    if (!duplicate) await commitAgentWrite(projectId, branch, [{ path: bibFile, before, after }], agentCommitMessage(`Add reference ${key || bibFile}`, requester));
    return { key, bibFile: file, duplicate, created };
  });
}
