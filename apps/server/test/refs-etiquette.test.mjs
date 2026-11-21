/**
 * WP16 reference lookup, what goes out: with no operator variables, no
 * request carries an address (no `@` in the User-Agent, no mailto or email
 * parameter) or a key; with REFERENCES_CONTACT_EMAIL only Crossref, NCBI and
 * DataCite receive it, and OPENALEX_API_KEY goes only to OpenAlex. arXiv
 * requests are at least 3 s apart (injected clock), a 429's Retry-After is
 * waited out, and once OpenAlex's budget headers fall under 10% free text is
 * searched on Crossref alone.
 */
import http from 'node:http';
import { check, eq } from './assert.mjs';

let t = 1_700_000_000_000;
const seen = [];
let busyOnce = true;
let budget = null;
const mock = http.createServer((req, res) => {
  seen.push({ url: req.url, ua: req.headers['user-agent'] || '', at: t, headers: req.headers });
  const json = (v, extra = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(v)); };
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/crossref/works') {
    if (u.searchParams.get('query.bibliographic') === 'busy' && busyOnce) { busyOnce = false; res.writeHead(429, { 'retry-after': '2' }); return res.end(); }
    return json({ message: { items: [{ DOI: '10.1000/cr', title: ['Crossref Hit'], author: [{ family: 'Roe', given: 'Jane' }], issued: { 'date-parts': [[2021]] }, 'container-title': ['J'], type: 'journal-article', score: 80 }] } });
  }
  if (u.pathname === '/openalex/works') {
    return json({ results: [{ id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/oa', title: 'OpenAlex Hit', publication_year: 2020, authorships: [{ author: { display_name: 'Ann Lee' } }] }] },
      budget ? { 'x-ratelimit-remaining-usd': String(budget.remaining), 'x-ratelimit-limit-usd': String(budget.limit) } : {});
  }
  if (u.pathname === '/pubmed/esearch.fcgi') return json({ esearchresult: { idlist: ['123'] } });
  if (u.pathname === '/pubmed/esummary.fcgi') return json({ result: { uids: ['123'], 123: { uid: '123', title: 'A PubMed Paper.', authors: [{ name: 'Smith J' }], pubdate: '2019 Jan', fulljournalname: 'Med J' } } });
  if (u.pathname === '/datacite/dois') return json({ data: [{ id: '10.5281/zenodo.1', attributes: { doi: '10.5281/zenodo.1', titles: [{ title: 'A Dataset' }], publicationYear: 2022, creators: [{ name: 'Kim, D.' }], types: { resourceTypeGeneral: 'Dataset' } } }] });
  if (u.pathname === '/openlibrary/api/books') return json({ 'ISBN:9780262033848': { title: 'Introduction to Algorithms', authors: [{ name: 'Thomas H. Cormen' }], publishers: [{ name: 'MIT Press' }], publish_date: '2009' } });
  if (u.pathname === '/arxiv/api/query') { res.writeHead(200, { 'content-type': 'application/atom+xml' }); return res.end('<feed><entry><title>An arXiv Paper</title><published>2017-06-12T00:00:00Z</published><author><name>Ann Lee</name></author></entry></feed>'); }
  if (u.pathname.startsWith('/doi/')) { res.writeHead(200, { 'content-type': 'application/x-bibtex' }); return res.end('@article{Lee_2020, title={T}, author={Lee, Ann}, year={2020}}'); }
  res.writeHead(404); res.end();
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}`;
Object.assign(process.env, {
  CROSSREF_API_BASE: `${base}/crossref`, OPENALEX_API_BASE: `${base}/openalex`, PUBMED_API_BASE: `${base}/pubmed`,
  DATACITE_API_BASE: `${base}/datacite`, OPENLIBRARY_API_BASE: `${base}/openlibrary`, ARXIV_API_BASE: `${base}/arxiv`, DOI_API_BASE: `${base}/doi`,
});
for (const k of ['REFERENCES_CONTACT_EMAIL', 'OPENALEX_API_KEY', 'NCBI_API_KEY', 'S2_API_KEY', 'REFERENCES_SOURCES', 'REFERENCES_ONLINE']) delete process.env[k];

const httpMod = await import('../src/refs/http.ts');
const { setClock, resetPacers, resetOpenAlexBudget, openAlexLow, USER_AGENT, queryCache, idCache } = httpMod;
const sleeps = [];
setClock({ now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
const { searchCrossref } = await import('../src/refs/sources/crossref.ts');
const { searchOpenAlex } = await import('../src/refs/sources/openalex.ts');
const { searchPubmed } = await import('../src/refs/sources/pubmed.ts');
const { searchDatacite } = await import('../src/refs/sources/datacite.ts');
const { bookByIsbn } = await import('../src/refs/sources/openlibrary.ts');
const { arxivRecord } = await import('../src/refs/sources/arxiv.ts');
const { fetchDoiBibtex } = await import('../src/refs/sources/doi.ts');
const { lookup, searchWorks } = await import('../src/references.ts');

const everySource = async () => {
  await searchCrossref('graph methods');
  await searchOpenAlex('graph methods');
  await searchPubmed('graph methods');
  await searchDatacite('graph methods');
  await bookByIsbn('9780262033848');
  await arxivRecord('1706.03762');
  await fetchDoiBibtex('10.1000/x');
};

// ---- no operator variables: nothing personal, no keys ----
check(/^Laytekz\/[\w.-]+$/.test(USER_AGENT), `the User-Agent is product/version only (got ${USER_AGENT})`);
await everySource();
eq(seen.length >= 8, true, `every source was called (${seen.length} requests)`);
for (const r of seen) {
  check(!r.ua.includes('@') && r.ua === USER_AGENT, `no address in the User-Agent: ${r.url} (${r.ua})`);
  check(!/[?&](mailto|email)=/i.test(r.url), `no mailto or email parameter: ${r.url}`);
  check(!/[?&]api_key=/i.test(r.url), `no key: ${r.url}`);
}

// ---- with the operator's contact and OpenAlex key ----
seen.length = 0;
process.env.REFERENCES_CONTACT_EMAIL = 'ops@example.org';
process.env.OPENALEX_API_KEY = 'oa-key';
resetPacers();
await everySource();
const by = (prefix) => seen.filter((r) => r.url.startsWith(prefix));
check(by('/crossref/').every((r) => r.ua === `${USER_AGENT} (mailto:ops@example.org)`), 'Crossref gets the contact in its User-Agent');
check(by('/pubmed/').every((r) => r.url.includes('email=ops%40example.org') && r.url.includes('tool=Laytekz')), 'NCBI gets email=');
check(by('/datacite/').every((r) => r.url.includes('mailto=ops%40example.org')), 'DataCite gets mailto=');
check(by('/openalex/').every((r) => r.url.includes('api_key=oa-key') && !r.url.includes('mailto')), 'OpenAlex gets its key and never mailto');
for (const r of seen.filter((x) => !/^\/(crossref|pubmed|datacite)\//.test(x.url))) {
  check(!r.ua.includes('@') && !/(mailto|email)=/.test(r.url), `no address to ${r.url}`);
}
for (const r of seen.filter((x) => !x.url.startsWith('/openalex/'))) check(!r.url.includes('api_key'), `the OpenAlex key stays with OpenAlex: ${r.url}`);
delete process.env.REFERENCES_CONTACT_EMAIL;
delete process.env.OPENALEX_API_KEY;
resetPacers();

// ---- arXiv: one request per 3 s ----
seen.length = 0;
await arxivRecord('1'); await arxivRecord('2'); await arxivRecord('3');
const times = by('/arxiv/').map((r) => r.at);
eq(times.length, 3, 'three arXiv requests');
check(times[1] - times[0] >= 3000 && times[2] - times[1] >= 3000, `arXiv requests are at least 3 s apart (got ${times.map((x) => x - times[0])})`);
// at once: the waits chain, so the second waits 3 s and the third 6 s from the first
sleeps.length = 0;
t += 10_000;
await Promise.all([arxivRecord('4'), arxivRecord('5'), arxivRecord('6')]);
eq(sleeps.filter((ms) => ms > 0), [3000, 3000], `three requests at once are spaced 3 s apart (waits ${sleeps})`);

// ---- a 429 with Retry-After is waited out and retried ----
seen.length = 0; sleeps.length = 0;
const busy = await searchCrossref('busy');
eq(busy.length, 1, 'the retry succeeds');
eq(by('/crossref/').length, 2, 'one 429, one retry');
check(by('/crossref/')[1].at - by('/crossref/')[0].at >= 2000, `the retry waits the 2 s Retry-After (got ${by('/crossref/')[1].at - by('/crossref/')[0].at} ms)`);

// ---- the OpenAlex budget: under 10% left, free text goes to Crossref ----
resetOpenAlexBudget(); queryCache.clear(); idCache.clear();
seen.length = 0;
let r = await lookup('sparse graph methods');
check(by('/openalex/works').length === 1 && by('/crossref/works').length === 1, 'a title searches OpenAlex and Crossref');
eq(r.results.map((x) => x.title).sort(), ['Crossref Hit', 'OpenAlex Hit'], 'both results come back');
budget = { remaining: 0.005, limit: 0.1 };
await lookup('another query to read the headers');
check(openAlexLow(), 'under 10% of the allowance is low');
seen.length = 0;
r = await lookup('yet another title');
eq(by('/openalex/works').length, 0, 'OpenAlex is not searched');
eq(by('/crossref/works').length, 1, 'Crossref carries the search');
check(/busy until 00:00 UTC/.test(r.notice || ''), `the panel is told (got ${r.notice})`);
seen.length = 0;
const v1 = await searchWorks('the V1 panel search');
eq([by('/openalex/works').length, by('/crossref/works').length, v1[0]?.doi], [0, 1, '10.1000/cr'], 'V1\'s /api/references/search falls back to Crossref too');
t += 24 * 3600_000;
check(!openAlexLow(), 'the budget resets at 00:00 UTC');

mock.close();
console.log('refs-etiquette tests passed');
