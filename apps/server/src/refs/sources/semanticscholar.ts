/**
 * Laytekz V2 (WP16): Semantic Scholar search, only when the operator set
 * S2_API_KEY (the keyless pool is shared by every caller and mostly answers 429).
 */
import { refsConfig } from '../config.js';
import { readCapped, refFetch, UpstreamError } from '../http.js';
import type { Candidate } from '../merge.js';

interface S2Paper { paperId?: string; title?: string; year?: number; venue?: string; authors?: Array<{ name?: string }>; externalIds?: { DOI?: string; ArXiv?: string; PubMed?: string } }

export async function searchSemanticScholar(q: string): Promise<Candidate[]> {
  const c = refsConfig();
  if (!c.s2Key) return [];
  const url = `${c.bases.s2}/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=10&fields=title,year,venue,authors,externalIds`;
  const res = await refFetch(url, { pace: 'semanticscholar', accept: 'application/json', source: 'Semantic Scholar', headers: { 'x-api-key': c.s2Key } });
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new UpstreamError(`Semantic Scholar search failed (HTTP ${res.status})`, res.status, 'semanticscholar'); }
  const data = JSON.parse(await readCapped(res, 4 * 1024 * 1024)) as { data?: S2Paper[] };
  return (data.data ?? []).map((p, i) => {
    const doi = p.externalIds?.DOI;
    const arxiv = p.externalIds?.ArXiv;
    return {
      id: doi ? `doi:${doi}` : arxiv ? `arxiv:${arxiv}` : `s2:${p.paperId}`,
      source: 'semanticscholar', title: p.title ?? 'Untitled',
      authors: (p.authors ?? []).map((a) => a.name ?? '').filter(Boolean),
      year: p.year ?? null, venue: p.venue ?? '', doi, arxiv, pmid: p.externalIds?.PubMed, rank: i,
    } as Candidate;
  }).filter((x) => x.doi || x.arxiv);
}
