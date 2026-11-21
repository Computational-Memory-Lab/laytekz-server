/**
 * Laytekz V2 (WP16): Crossref search (titles and pasted citations through
 * query.bibliographic). The operator's contact address, when set, rides in
 * the User-Agent (Crossref's polite pool); otherwise nothing personal is sent.
 */
import { refsConfig } from '../config.js';
import { contactUA, readCapped, refFetch, UpstreamError } from '../http.js';
import type { Candidate } from '../merge.js';

interface CrossrefWork {
  DOI?: string; title?: string[]; author?: Array<{ family?: string; given?: string; name?: string }>;
  issued?: { 'date-parts'?: number[][] }; 'container-title'?: string[]; type?: string; score?: number;
}

export function crossrefYear(w: CrossrefWork): number | null {
  return w.issued?.['date-parts']?.[0]?.[0] ?? null;
}

export async function searchCrossref(q: string, rows = 10): Promise<Candidate[]> {
  const base = refsConfig().bases.crossref;
  const url = `${base}/works?query.bibliographic=${encodeURIComponent(q)}&rows=${rows}&select=DOI,title,author,issued,container-title,type,score`;
  const res = await refFetch(url, { pace: 'crossref-list', userAgent: contactUA(), accept: 'application/json', source: 'Crossref' });
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new UpstreamError(`Crossref search failed (HTTP ${res.status})`, res.status, 'crossref'); }
  const data = JSON.parse(await readCapped(res, 4 * 1024 * 1024)) as { message?: { items?: CrossrefWork[] } };
  return (data.message?.items ?? []).map((w, i) => ({
    id: `doi:${w.DOI ?? ''}`,
    source: 'crossref',
    title: (w.title?.[0] ?? 'Untitled').replace(/\s+/g, ' ').trim(),
    authors: (w.author ?? []).map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
    year: crossrefYear(w),
    venue: w['container-title']?.[0] ?? '',
    type: w.type,
    doi: w.DOI,
    score: w.score,
    preprint: w.type === 'posted-content',
    rank: i,
  })).filter((c) => c.doi);
}
