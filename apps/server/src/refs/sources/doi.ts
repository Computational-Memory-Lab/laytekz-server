/**
 * Laytekz V2 (WP16): BibTeX for a DOI through doi.org content negotiation,
 * which answers for Crossref, DataCite, mEDRA and JaLC DOIs alike. A redirect
 * is followed only to DOI_BASE's own origin or, over https, to an agency's
 * metadata service: any other target is the DOI's landing page (or a host the
 * DOI's registrant chose), which is never requested.
 */
import { refsConfig } from '../config.js';
import { readCapped, refFetch, UpstreamError } from '../http.js';

const DOI_METADATA_DOMAINS = ['doi.org', 'crossref.org', 'crosscite.org', 'datacite.org', 'medra.org', 'japanlinkcenter.org'];
const DOI_MAX_REDIRECTS = 5;

/** A DOI lookup goes only to DOI_BASE's own origin, or over https to an agency's metadata service. */
export function doiHopAllowed(url: URL): boolean {
  if (url.origin === new URL(refsConfig().bases.doi).origin) return true;
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return DOI_METADATA_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** 404/410 is a resolver's answer that the id is not registered: a wrong identifier, not an outage. */
export function notRegistered(res: Response): boolean {
  return res.status === 404 || res.status === 410;
}

/** The registration agency's BibTeX for a DOI, as received (trimmed); null when the DOI is unknown or has none. */
export async function fetchDoiBibtex(doi: string): Promise<string | null> {
  let url = new URL(`${refsConfig().bases.doi}/${encodeURIComponent(doi)}`);
  for (let hop = 0; ; hop++) {
    const res = await refFetch(url, { pace: 'doi', accept: 'application/x-bibtex; charset=utf-8', redirect: 'manual', source: 'doi.org' });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const loc = res.headers.get('location');
      if (!loc) throw new UpstreamError(`DOI lookup failed (HTTP ${res.status} without a location)`, res.status, 'doi');
      if (hop >= DOI_MAX_REDIRECTS) throw new UpstreamError(`DOI lookup failed (more than ${DOI_MAX_REDIRECTS} redirects)`, 0, 'doi');
      url = new URL(loc, url);
      if (!doiHopAllowed(url)) return null;
      continue;
    }
    if (notRegistered(res)) { await res.body?.cancel().catch(() => undefined); return null; }
    if (!res.ok) throw new UpstreamError(`DOI lookup failed (HTTP ${res.status})`, res.status, 'doi');
    const bib = (await readCapped(res)).trim();
    return bib.startsWith('@') ? bib : null;
  }
}
