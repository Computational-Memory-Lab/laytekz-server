/**
 * Laytekz V2 (WP16): what a query in the references box is. Pure.
 */

export type QueryKind = 'doi' | 'arxiv' | 'pmid' | 'pmcid' | 'isbn' | 'openalex' | 'bibtex' | 'citation' | 'text';
export interface Identified { kind: QueryKind; value: string }

const DOI_RE = /10\.\d{4,9}\/\S+/;
const ARXIV_NEW = /^(\d{4}\.\d{4,5})(v\d+)?$/i;
const ARXIV_OLD = /^([a-z][a-z.-]*(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/i;

/** ISBN-10 or ISBN-13 with a valid checksum, hyphens and spaces removed; null otherwise. */
export function normalizeIsbn(s: string): string | null {
  const d = s.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(d)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (d[i] === 'X' ? 10 : Number(d[i])) * (10 - i);
    return sum % 11 === 0 ? d : null;
  }
  if (/^97[89]\d{10}$/.test(d)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(d[i]) * (i % 2 ? 3 : 1);
    return sum % 10 === 0 ? d : null;
  }
  return null;
}

/** A DOI as written in prose or a URL, without trailing punctuation. */
export function cleanDoi(s: string): string {
  let d = s.trim().replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, '');
  try { if (/%[0-9a-f]{2}/i.test(d)) d = decodeURIComponent(d); } catch { /* keep as typed */ }
  d = d.replace(/[.,;:]+$/, '');
  // a closing bracket belongs to the DOI only when it opened one
  while (/[)\]}>]$/.test(d)) {
    const close = d.at(-1)!;
    const open = ({ ')': '(', ']': '[', '}': '{', '>': '<' } as Record<string, string>)[close];
    if (d.split(open).length > d.split(close).length - 1) break;
    d = d.slice(0, -1);
  }
  return d;
}

export function identify(raw: string): Identified {
  const q = raw.trim();
  if (!q) return { kind: 'text', value: '' };
  if (/^@\s*[a-z]+\s*[{(]/i.test(q)) return { kind: 'bibtex', value: q };

  // URLs first: they carry the identifier in a known place
  const arxivUrl = /arxiv\.org\/(?:abs|pdf|html)\/([^\s?#]+?)(?:\.pdf)?(?:[?#].*)?$/i.exec(q);
  if (arxivUrl && !/\s/.test(q)) {
    const id = arxivUrl[1].replace(/v\d+$/i, '');
    if (ARXIV_NEW.test(id) || ARXIV_OLD.test(id)) return { kind: 'arxiv', value: id };
  }
  const pubmedUrl = /(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed)\/(\d{1,9})/i.exec(q);
  if (pubmedUrl && !/\s/.test(q)) return { kind: 'pmid', value: pubmedUrl[1] };
  const pmcUrl = /ncbi\.nlm\.nih\.gov\/pmc\/articles\/(PMC\d+)/i.exec(q);
  if (pmcUrl && !/\s/.test(q)) return { kind: 'pmcid', value: pmcUrl[1].toUpperCase() };
  const oaUrl = /^(?:https?:\/\/)?(?:api\.)?openalex\.org\/(?:works\/)?(W\d{2,})$/i.exec(q) || /^openalex:\s*(W\d{2,})$/i.exec(q);
  if (oaUrl) return { kind: 'openalex', value: oaUrl[1].toUpperCase() };

  // a DOI anywhere in a short query (a long one is a citation that happens to carry a DOI)
  const doi = DOI_RE.exec(q);
  if (doi && (q.split(/\s+/).length <= 3 || /^(doi:|https?:\/\/(dx\.)?doi\.org\/)/i.test(q))) {
    return { kind: 'doi', value: cleanDoi(doi[0]) };
  }

  const bare = q.replace(/^arxiv:\s*/i, '');
  const explicitArxiv = /^arxiv:/i.test(q);
  // a bare 2023.12345 is arXiv only as the whole query
  if (ARXIV_NEW.test(bare) || (ARXIV_OLD.test(bare) && (explicitArxiv || /\//.test(bare)))) {
    return { kind: 'arxiv', value: bare.replace(/v\d+$/i, '') };
  }
  const pmid = /^(?:pmid:?\s*)(\d{1,9})$/i.exec(q);
  if (pmid) return { kind: 'pmid', value: pmid[1] };
  if (/^PMC\d{3,9}$/i.test(q)) return { kind: 'pmcid', value: q.toUpperCase() };
  const isbnText = /^(?:isbn(?:-1[03])?:?\s*)?([\dXx][\d\sXx-]{8,16})$/i.exec(q);
  if (isbnText) {
    const isbn = normalizeIsbn(isbnText[1]);
    if (isbn) return { kind: 'isbn', value: isbn };
  }
  // a long run of digits with nothing else is most likely a PubMed id
  if (/^\d{5,9}$/.test(q)) return { kind: 'pmid', value: q };

  // a formatted citation: at least 8 words, a year and some punctuation
  const words = q.split(/\s+/).filter(Boolean).length;
  if (words >= 8 && /\b(1[89]|20)\d{2}\b/.test(q) && /[.,;:()]/.test(q)) {
    if (doi) return { kind: 'doi', value: cleanDoi(doi[0]) };
    return { kind: 'citation', value: q };
  }
  return { kind: 'text', value: q };
}
