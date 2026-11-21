/**
 * Laytekz V2 (WP16): DataCite search (datasets, software, theses; the
 * "Datasets" filter). `mailto` only when the operator set
 * REFERENCES_CONTACT_EMAIL. BibTeX for a result comes from its DOI.
 */
import { refsConfig } from '../config.js';
import { readCapped, refFetch, UpstreamError } from '../http.js';
import type { Candidate } from '../merge.js';

interface DataCiteItem {
  id?: string;
  attributes?: {
    doi?: string; titles?: Array<{ title?: string }>; publicationYear?: number; publisher?: string | { name?: string };
    creators?: Array<{ name?: string; familyName?: string; givenName?: string }>; types?: { resourceTypeGeneral?: string };
  };
}

export async function searchDatacite(q: string): Promise<Candidate[]> {
  const c = refsConfig();
  const url = `${c.bases.datacite}/dois?query=${encodeURIComponent(q)}&page[size]=10${c.contact ? `&mailto=${encodeURIComponent(c.contact)}` : ''}`;
  const res = await refFetch(url, { pace: 'datacite', accept: 'application/vnd.api+json', source: 'DataCite' });
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new UpstreamError(`DataCite search failed (HTTP ${res.status})`, res.status, 'datacite'); }
  const data = JSON.parse(await readCapped(res, 4 * 1024 * 1024)) as { data?: DataCiteItem[] };
  return (data.data ?? []).map((d, i) => {
    const a = d.attributes ?? {};
    const doi = a.doi || d.id;
    const type = (a.types?.resourceTypeGeneral || '').toLowerCase();
    return {
      id: `doi:${doi}`, source: 'datacite', title: a.titles?.[0]?.title ?? 'Untitled',
      authors: (a.creators ?? []).map((cr) => cr.name || [cr.givenName, cr.familyName].filter(Boolean).join(' ')).filter(Boolean),
      year: a.publicationYear ?? null,
      venue: typeof a.publisher === 'string' ? a.publisher : a.publisher?.name ?? '',
      type: type === 'dataset' ? 'dataset' : type === 'preprint' ? 'posted-content' : type || undefined,
      doi, preprint: type === 'preprint', rank: i,
    } as Candidate;
  }).filter((x) => x.doi);
}
