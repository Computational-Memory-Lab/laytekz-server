/**
 * Laytekz V2 (WP16): OpenAlex search and single works. The operator's
 * OPENALEX_API_KEY goes along when set; `mailto` is never sent (OpenAlex
 * ignores it since February 2026). Searches cost budget, single works are
 * free; the budget headers are read on every reply.
 */
import { refsConfig } from '../config.js';
import { markOpenAlexSpent, noteOpenAlexBudget, readCapped, refFetch, UpstreamError } from '../http.js';
import type { CslLike } from '../bibtex.js';
import type { Candidate } from '../merge.js';

export interface OpenAlexWork {
  id?: string; doi?: string | null; title?: string; display_name?: string; publication_year?: number; type?: string;
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: { source?: { display_name?: string } };
  ids?: { pmid?: string };
  biblio?: { volume?: string; issue?: string; first_page?: string; last_page?: string };
  locations?: Array<{ landing_page_url?: string; source?: { display_name?: string } }>;
}

function withKey(url: string): string {
  const key = refsConfig().openalexKey;
  return key ? `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}` : url;
}

async function get(url: string): Promise<Response> {
  const res = await refFetch(withKey(url), { pace: 'openalex', accept: 'application/json', source: 'OpenAlex' }).catch((err) => {
    if (err instanceof UpstreamError && err.status === 429) markOpenAlexSpent();
    throw err;
  });
  noteOpenAlexBudget(res);
  return res;
}

const bareDoi = (d: string | null | undefined) => (d ? String(d).replace(/^https?:\/\/doi\.org\//i, '') : undefined);

export function openAlexToCandidate(w: OpenAlexWork, i: number): Candidate {
  const id = String(w.id || '').split('/').pop() || '';
  const doi = bareDoi(w.doi);
  const arxiv = doi && /^10\.48550\/arxiv\./i.test(doi) ? doi.replace(/^10\.48550\/arxiv\./i, '') : undefined;
  return {
    id: doi ? `doi:${doi}` : `openalex:${id}`,
    source: 'openalex',
    title: String(w.title || w.display_name || 'Untitled'),
    authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean),
    year: w.publication_year ?? null,
    venue: w.primary_location?.source?.display_name ?? '',
    type: w.type,
    doi: arxiv ? undefined : doi,
    arxiv,
    pmid: w.ids?.pmid ? String(w.ids.pmid).split('/').pop() : undefined,
    openalex: id,
    preprint: w.type === 'preprint' || !!arxiv,
    rank: i,
  };
}

export async function searchOpenAlex(q: string, perPage = 10): Promise<Candidate[]> {
  const res = await get(`${refsConfig().bases.openalex}/works?search=${encodeURIComponent(q)}&per_page=${perPage}`);
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new UpstreamError(`OpenAlex search failed (HTTP ${res.status})`, res.status, 'openalex'); }
  const data = JSON.parse(await readCapped(res, 4 * 1024 * 1024)) as { results?: OpenAlexWork[] };
  return (data.results ?? []).map(openAlexToCandidate);
}

/** One work by OpenAlex id (W…) or `doi:10.…`; null when unknown. Free of budget. */
export async function openAlexWork(id: string): Promise<OpenAlexWork | null> {
  const res = await get(`${refsConfig().bases.openalex}/works/${encodeURIComponent(id)}`);
  if (res.status === 404 || res.status === 410) { await res.body?.cancel().catch(() => undefined); return null; }
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new UpstreamError(`OpenAlex lookup failed (HTTP ${res.status})`, res.status, 'openalex'); }
  return JSON.parse(await readCapped(res)) as OpenAlexWork;
}

const OA_TYPE: Record<string, string> = { article: 'article-journal', 'book-chapter': 'chapter', book: 'book', dataset: 'dataset', preprint: 'posted-content', dissertation: 'thesis', report: 'report' };

export function openAlexToCsl(w: OpenAlexWork): CslLike {
  return {
    type: OA_TYPE[w.type ?? ''] ?? 'article-journal',
    title: String(w.title || w.display_name || 'Untitled'),
    author: (w.authorships ?? []).map((a) => {
      const n = (a.author?.display_name ?? '').trim();
      const parts = n.split(/\s+/);
      const family = parts.pop() ?? '';
      return { family, given: parts.join(' ') };
    }).filter((a) => a.family),
    year: w.publication_year ?? null,
    containerTitle: w.primary_location?.source?.display_name ?? '',
    volume: w.biblio?.volume, issue: w.biblio?.issue,
    pages: w.biblio?.first_page ? [w.biblio.first_page, w.biblio.last_page].filter(Boolean).join('--') : undefined,
    url: w.id ? String(w.id) : undefined,
  };
}
