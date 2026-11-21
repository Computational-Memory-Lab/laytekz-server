/**
 * Laytekz V2 (WP16): reference lookup configuration, read from the
 * environment each time it is asked for (tests set variables before calling).
 * Every variable is optional; with none set, lookup works with the public
 * limits and sends no contact address and no key anywhere.
 */

export type SourceId = 'crossref' | 'openalex' | 'arxiv' | 'pubmed' | 'datacite' | 'openlibrary' | 'semanticscholar';
export const ALL_SOURCES: readonly SourceId[] = ['crossref', 'openalex', 'arxiv', 'pubmed', 'datacite', 'openlibrary', 'semanticscholar'];

const env = (name: string): string => (process.env[name] || '').trim();
const base = (name: string, fallback: string): string => (env(name) || fallback).replace(/\/+$/, '');

export interface RefsConfig {
  /** REFERENCES_ONLINE=0 turns online lookup off (search and identifier lookups). */
  online: boolean;
  /** REFERENCES_CONTACT_EMAIL: the operator's own address, sent only to Crossref, NCBI and DataCite. Empty by default. */
  contact: string;
  openalexKey: string;
  ncbiKey: string;
  s2Key: string;
  sources: Set<SourceId>;
  bases: { doi: string; arxiv: string; openalex: string; crossref: string; datacite: string; pubmed: string; openlibrary: string; s2: string };
}

export function refsConfig(): RefsConfig {
  const listed = env('REFERENCES_SOURCES').split(/[\s,]+/).filter(Boolean) as SourceId[];
  const sources = new Set<SourceId>(listed.length ? listed.filter((s) => ALL_SOURCES.includes(s)) : ALL_SOURCES);
  const s2Key = env('S2_API_KEY');
  if (!s2Key) sources.delete('semanticscholar');
  return {
    online: env('REFERENCES_ONLINE') !== '0',
    contact: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env('REFERENCES_CONTACT_EMAIL')) ? env('REFERENCES_CONTACT_EMAIL') : '',
    openalexKey: env('OPENALEX_API_KEY'),
    ncbiKey: env('NCBI_API_KEY'),
    s2Key,
    sources,
    bases: {
      doi: base('DOI_API_BASE', 'https://doi.org'),
      arxiv: base('ARXIV_API_BASE', 'https://export.arxiv.org'),
      openalex: base('OPENALEX_API_BASE', 'https://api.openalex.org'),
      crossref: base('CROSSREF_API_BASE', 'https://api.crossref.org'),
      datacite: base('DATACITE_API_BASE', 'https://api.datacite.org'),
      pubmed: base('PUBMED_API_BASE', 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'),
      openlibrary: base('OPENLIBRARY_API_BASE', 'https://openlibrary.org'),
      s2: base('S2_API_BASE', 'https://api.semanticscholar.org'),
    },
  };
}
