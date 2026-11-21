/**
 * Laytekz V2 (WP16): arXiv's Atom API, the fallback when doi.org has no
 * `10.48550/arXiv.<id>` record. One request per 3 s, server-wide.
 */
import { refsConfig } from '../config.js';
import { readCapped, refFetch, UpstreamError } from '../http.js';
import { notRegistered } from './doi.js';

export interface ArxivRecord { id: string; title: string; authors: string[]; published: string; doi?: string; journalRef?: string }

export async function arxivRecord(id: string): Promise<ArxivRecord | null> {
  const res = await refFetch(`${refsConfig().bases.arxiv}/api/query?id_list=${encodeURIComponent(id)}`, { pace: 'arxiv', source: 'arXiv' });
  if (notRegistered(res)) { await res.body?.cancel().catch(() => undefined); return null; }
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new UpstreamError(`arXiv lookup failed (HTTP ${res.status})`, res.status, 'arxiv'); }
  const feed = await readCapped(res);
  // the <entry> element only: the feed has its own <title>
  const xml = (feed.match(/<entry>([\s\S]*?)<\/entry>/) || [])[1];
  if (!xml) return null;
  const pick = (tag: string) => (xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]?.trim();
  const title = pick('title')?.replace(/\s+/g, ' ');
  if (!title) return null;
  return {
    id,
    title,
    authors: Array.from(xml.matchAll(/<name>([^<]+)<\/name>/g)).map((m) => m[1].trim()),
    published: pick('published') || '',
    doi: pick('arxiv:doi'),
    journalRef: pick('arxiv:journal_ref'),
  };
}
