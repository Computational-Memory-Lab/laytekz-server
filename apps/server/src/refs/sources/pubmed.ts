/**
 * Laytekz V2 (WP16): PubMed through NCBI E-utilities (ESearch + ESummary).
 * `tool=Laytekz` is sent; `email` only when the operator set
 * REFERENCES_CONTACT_EMAIL, `api_key` only with NCBI_API_KEY.
 */
import { refsConfig } from '../config.js';
import { readCapped, refFetch, UpstreamError } from '../http.js';
import type { CslLike } from '../bibtex.js';
import type { Candidate } from '../merge.js';

interface Summary {
  uid: string; title?: string; authors?: Array<{ name: string; authtype?: string }>; pubdate?: string;
  fulljournalname?: string; source?: string; volume?: string; issue?: string; pages?: string;
  articleids?: Array<{ idtype: string; value: string }>; pubtype?: string[];
}

function params(): string {
  const c = refsConfig();
  return `&tool=Laytekz${c.contact ? `&email=${encodeURIComponent(c.contact)}` : ''}${c.ncbiKey ? `&api_key=${encodeURIComponent(c.ncbiKey)}` : ''}`;
}

async function json<T>(path: string): Promise<T> {
  const res = await refFetch(`${refsConfig().bases.pubmed}/${path}${params()}`, { pace: 'pubmed', accept: 'application/json', source: 'PubMed' });
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw new UpstreamError(`PubMed failed (HTTP ${res.status})`, res.status, 'pubmed'); }
  return JSON.parse(await readCapped(res, 4 * 1024 * 1024)) as T;
}

async function esearch(term: string, max = 10): Promise<string[]> {
  const r = await json<{ esearchresult?: { idlist?: string[] } }>(`esearch.fcgi?db=pubmed&retmode=json&retmax=${max}&term=${encodeURIComponent(term)}`);
  return r.esearchresult?.idlist ?? [];
}

async function esummary(ids: string[]): Promise<Summary[]> {
  if (!ids.length) return [];
  const r = await json<{ result?: Record<string, Summary> & { uids?: string[] } }>(`esummary.fcgi?db=pubmed&retmode=json&id=${ids.map(encodeURIComponent).join(',')}`);
  const res = r.result;
  if (!res) return [];
  return (res.uids ?? ids).map((u) => res[u] as Summary).filter((s) => s && s.uid && s.title);
}

const doiOf = (s: Summary) => s.articleids?.find((a) => a.idtype === 'doi')?.value;
const yearOf = (s: Summary) => Number(/\d{4}/.exec(s.pubdate ?? '')?.[0]) || null;

function toCandidate(s: Summary, i: number): Candidate {
  const doi = doiOf(s);
  return {
    id: `pmid:${s.uid}`, source: 'pubmed', title: (s.title ?? '').replace(/\.$/, ''),
    authors: (s.authors ?? []).filter((a) => !a.authtype || a.authtype === 'Author').map((a) => a.name),
    year: yearOf(s), venue: s.fulljournalname || s.source || '', doi, pmid: s.uid, rank: i,
  };
}

export async function searchPubmed(q: string): Promise<Candidate[]> {
  return (await esummary(await esearch(q))).map(toCandidate);
}

/** A PMCID's PMID, through ESearch's [pmcid] field. */
export async function pmidForPmcid(pmcid: string): Promise<string | null> {
  return (await esearch(`${pmcid}[pmcid]`, 1))[0] ?? null;
}

export async function pubmedRecord(pmid: string): Promise<{ doi?: string; csl: CslLike; candidate: Candidate } | null> {
  const s = (await esummary([pmid]))[0];
  if (!s) return null;
  const csl: CslLike = {
    type: 'article-journal',
    title: (s.title ?? '').replace(/\.$/, ''),
    // ESummary names are "Smith J": family, then initials
    author: (s.authors ?? []).filter((a) => !a.authtype || a.authtype === 'Author').map((a) => {
      const m = /^(.*\S)\s+([A-Z]{1,4})$/.exec(a.name.trim());
      return m ? { family: m[1], given: m[2].split('').join('. ') + '.' } : { literal: a.name };
    }),
    year: yearOf(s), containerTitle: s.fulljournalname || s.source, volume: s.volume, issue: s.issue, pages: s.pages,
    doi: doiOf(s), pmid: s.uid,
  };
  return { doi: doiOf(s), csl, candidate: toCandidate(s, 0) };
}
