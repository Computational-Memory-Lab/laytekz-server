/**
 * Laytekz V2 (WP16): one result per paper across sources, and "is this paper
 * already in the project". Two records are the same paper when they share an
 * identifier (DOI, arXiv id, PMID, ISBN), or, failing that, when their
 * normalised titles are near-identical, their years are within one, and the
 * first author's surname matches. Pure.
 */
import { parseEntry } from './bibtex.js';
import { firstSurname, yearOf } from './keys.js';

export interface Candidate {
  /** Opaque, stable within one lookup: what the client sends back to preview it. */
  id: string;
  source: string;
  sources?: string[];
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  type?: string;
  doi?: string;
  arxiv?: string;
  pmid?: string;
  isbn?: string;
  openalex?: string;
  /** Crossref's relevance score for a pasted citation. */
  score?: number;
  /** A pasted citation's best match that may be wrong. */
  weak?: boolean;
  preprint?: boolean;
  /** For an arXiv result: the published version's DOI, when one is known. */
  publishedDoi?: string;
  /** Ready BibTeX, when the source gave it (pasted BibTeX). */
  bibtex?: string;
  /** The source's own order, 0 first. */
  rank: number;
}

export function normDoi(d: string | undefined | null): string {
  return (d || '').trim().replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, '').toLowerCase();
}
export function normArxiv(a: string | undefined | null): string {
  return (a || '').trim().replace(/^arxiv:/i, '').replace(/v\d+$/i, '').toLowerCase();
}

/** A title for comparison: TeX commands, braces, accents and punctuation stripped, lowercase, single spaces. */
export function normTitle(t: string): string {
  return t
    .replace(/\\[a-zA-Z]+\s*/g, ' ').replace(/[{}$\\]/g, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function trigrams(s: string): Map<string, number> {
  const padded = `  ${s} `;
  const m = new Map<string, number>();
  for (let i = 0; i < padded.length - 2; i++) {
    const g = padded.slice(i, i + 3);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}
/** Dice coefficient over character trigrams, 0…1. */
export function titleSimilarity(a: string, b: string): number {
  const x = normTitle(a); const y = normTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ta = trigrams(x); const tb = trigrams(y);
  let common = 0; let na = 0; let nb = 0;
  for (const v of ta.values()) na += v;
  for (const v of tb.values()) nb += v;
  for (const [g, v] of ta) common += Math.min(v, tb.get(g) ?? 0);
  return (2 * common) / (na + nb);
}

export const TITLE_MATCH = 0.92;

function surnameOf(authors: string[]): string {
  const a = authors[0] ?? '';
  return firstSurname(a.includes(',') ? a : a);
}

function idsOf(c: Candidate): string[] {
  const ids: string[] = [];
  if (c.doi) ids.push(`doi:${normDoi(c.doi)}`);
  if (c.arxiv) ids.push(`arxiv:${normArxiv(c.arxiv)}`);
  if (c.pmid) ids.push(`pmid:${c.pmid}`);
  if (c.isbn) ids.push(`isbn:${c.isbn}`);
  return ids;
}

function sameByTitle(a: { title: string; year: number | null; surname: string }, b: { title: string; year: number | null; surname: string }): boolean {
  if (titleSimilarity(a.title, b.title) < TITLE_MATCH) return false;
  if (a.year && b.year && Math.abs(a.year - b.year) > 1) return false;
  if (a.surname && b.surname && a.surname !== b.surname) return false;
  return true;
}

const isPreprint = (c: Candidate) => !!c.preprint || (!!c.arxiv && !c.doi) || /^10\.48550\//i.test(c.doi || '') || c.type === 'posted-content';

/**
 * Merge per-source lists into one ranked list. Records with identifiers come
 * first, a published version ahead of its preprint (the preprint's arXiv id
 * folds into it), then by each source's own rank.
 */
export function mergeCandidates(lists: Candidate[][]): Candidate[] {
  const groups: Candidate[][] = [];
  const byId = new Map<string, Candidate[]>();
  for (const list of lists) {
    for (const c of list) {
      let group: Candidate[] | undefined;
      for (const id of idsOf(c)) { group = byId.get(id); if (group) break; }
      if (!group) {
        const me = { title: c.title, year: c.year, surname: surnameOf(c.authors) };
        group = groups.find((g) => sameByTitle(me, { title: g[0].title, year: g[0].year, surname: surnameOf(g[0].authors) }));
      }
      if (!group) { group = []; groups.push(group); }
      group.push(c);
      for (const id of idsOf(c)) if (!byId.has(id)) byId.set(id, group);
    }
  }
  const merged = groups.map((g) => {
    const published = g.filter((c) => !isPreprint(c));
    const lead = { ...(published[0] ?? g[0]) };
    lead.sources = [...new Set(g.map((c) => c.source))];
    for (const c of g) {
      lead.doi ??= isPreprint(c) && published.length ? undefined : c.doi;
      lead.arxiv ??= c.arxiv;
      lead.pmid ??= c.pmid;
      lead.isbn ??= c.isbn;
      lead.openalex ??= c.openalex;
      if (!lead.venue && c.venue) lead.venue = c.venue;
      if (!lead.year && c.year) lead.year = c.year;
      if (!lead.authors.length && c.authors.length) lead.authors = c.authors;
    }
    if (published.length && g.some(isPreprint)) lead.preprint = false;
    return { lead, best: Math.min(...g.map((c) => c.rank)), hasId: g.some((c) => idsOf(c).length > 0), count: g.length };
  });
  merged.sort((a, b) => Number(b.hasId) - Number(a.hasId) || a.best - b.best || b.count - a.count);
  return merged.map((m) => m.lead);
}

// ---- duplicates against a .bib's text ----

export interface BibEntryInfo { key: string; text: string; ids: Set<string>; title: string; year: number | null; surname: string }

const DOI_URL_RE = /^https?:\/\/(?:dx\.)?doi\.org\//i;
const ARXIV_URL_RE = /arxiv\.org\/abs\/([^\s/?#]+(?:\/\d{7})?)/i;

/** The identifiers an entry carries, comparable across upstreams and key styles. */
export function entryIdentifiers(entry: string): Set<string> {
  const ids = new Set<string>();
  const p = parseEntry(entry.trim());
  const fields = p?.fields ?? [...entry.matchAll(/\b(doi|eprint|url|pmid|isbn|archiveprefix)\s*=\s*(?:\{([^}]*)\}|"([^"]*)")/gi)].map((m) => ({ name: m[1].toLowerCase(), value: (m[2] ?? m[3] ?? '').trim(), bare: false }));
  for (const f of fields) {
    const value = f.value.trim();
    if (!value) continue;
    if (f.name === 'doi' || (f.name === 'url' && DOI_URL_RE.test(value))) {
      const d = normDoi(value);
      ids.add(`doi:${d}`);
      const ax = /^10\.48550\/arxiv\.(.+)$/i.exec(d);
      if (ax) ids.add(`eprint:${normArxiv(ax[1])}`);
    } else if (f.name === 'eprint') ids.add(`eprint:${normArxiv(value)}`);
    else if (f.name === 'url' && ARXIV_URL_RE.test(value)) ids.add(`eprint:${normArxiv(ARXIV_URL_RE.exec(value)![1])}`);
    else if (f.name === 'pmid') ids.add(`pmid:${value}`);
    else if (f.name === 'isbn') ids.add(`isbn:${value.replace(/[\s-]/g, '').toUpperCase()}`);
  }
  return ids;
}

/** Every entry of a .bib text, in order (comments, @string and @preamble skipped). */
export function bibEntries(source: string): BibEntryInfo[] {
  const starts = [...source.matchAll(/@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/g)];
  const out: BibEntryInfo[] = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    if (['comment', 'preamble', 'string'].includes(s[1].toLowerCase())) continue;
    const text = source.slice(s.index!, starts[i + 1]?.index ?? source.length);
    out.push(infoFor(s[2], text));
  }
  return out;
}

function infoFor(key: string, text: string): BibEntryInfo {
  const p = parseEntry(text.trim().replace(/[^}]*$/, ''));
  const get = (n: string) => p?.fields.find((f) => f.name === n)?.value ?? (new RegExp(`\\b${n}\\s*=\\s*[{"]([^"}]*)`, 'i').exec(text)?.[1] ?? '');
  const year = Number(p ? yearOf(p.fields) : /\d{4}/.exec(get('year'))?.[0]) || null;
  return { key, text, ids: entryIdentifiers(text), title: get('title'), year, surname: firstSurname(get('author') || get('editor')) };
}

/**
 * The entry in `source` that is the same paper as `entry`: a shared
 * identifier, or a near-identical title with a year within one and the same
 * first-author surname. A matching key alone is never enough (two papers by
 * Smith in 2020 share `smith2020`).
 */
export function findSamePaper(source: string, entry: string): BibEntryInfo | null {
  const me = infoFor(parseEntry(entry.trim())?.key ?? '', entry);
  const all = bibEntries(source);
  if (me.ids.size) {
    const hit = all.find((e) => [...e.ids].some((id) => me.ids.has(id)));
    if (hit) return hit;
  }
  if (!me.title) return null;
  return all.find((e) => {
    // two records with different DOIs are different works, however alike their titles
    const myDoi = [...me.ids].find((i) => i.startsWith('doi:'));
    const theirDoi = [...e.ids].find((i) => i.startsWith('doi:'));
    if (myDoi && theirDoi && myDoi !== theirDoi && !myDoi.startsWith('doi:10.48550/') && !theirDoi.startsWith('doi:10.48550/')) return false;
    return e.title && sameByTitle(me, e);
  }) ?? null;
}
