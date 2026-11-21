/**
 * Laytekz V2 (WP16): a book by ISBN from Open Library (one request, no key).
 */
import { refsConfig } from '../config.js';
import { readCapped, refFetch, UpstreamError } from '../http.js';
import type { CslLike } from '../bibtex.js';

interface OlBook {
  title?: string; subtitle?: string; authors?: Array<{ name?: string }>; publishers?: Array<{ name?: string }>;
  publish_date?: string; publish_places?: Array<{ name?: string }>; url?: string; number_of_pages?: number;
}

export async function bookByIsbn(isbn: string): Promise<CslLike | null> {
  const res = await refFetch(`${refsConfig().bases.openlibrary}/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`, { pace: 'openlibrary', accept: 'application/json', source: 'Open Library' });
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new UpstreamError(`Open Library lookup failed (HTTP ${res.status})`, res.status, 'openlibrary'); }
  const data = JSON.parse(await readCapped(res)) as Record<string, OlBook>;
  const b = data[`ISBN:${isbn}`];
  if (!b || !b.title) return null;
  return {
    type: 'book',
    title: b.subtitle ? `${b.title}: ${b.subtitle}` : b.title,
    author: (b.authors ?? []).map((a) => {
      const parts = (a.name ?? '').trim().split(/\s+/);
      const family = parts.pop() ?? '';
      return { family, given: parts.join(' ') };
    }).filter((a) => a.family),
    year: Number(/\d{4}/.exec(b.publish_date ?? '')?.[0]) || null,
    publisher: b.publishers?.[0]?.name,
    place: b.publish_places?.[0]?.name,
    isbn,
  };
}
