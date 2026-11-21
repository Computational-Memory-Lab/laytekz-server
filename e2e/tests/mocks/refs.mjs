/**
 * Mock reference sources: OpenAlex (OPENALEX_API_BASE), DOI content
 * negotiation (DOI_API_BASE) and the arXiv Atom API (ARXIV_API_BASE), all at
 * the mock's root. WP16 adds the V2 sources under their own path prefixes
 * (/crossref, /datacite, /pubmed, /openlibrary, /s2; playwright.config.ts
 * points each *_API_BASE there), so no two upstreams share a path.
 */

export const order = 200;

export function handle(req, res, { url, send }) {
  // --- Mock OpenAlex (search + single work) ---
  if (url.pathname === '/works') {
    send(200, { meta: { count: 2 }, results: [
      { id: 'https://openalex.org/W111', doi: 'https://doi.org/10.1145/mock.search1', title: 'A Searchable Mock Paper', publication_year: 2021,
        authorships: [{ author: { display_name: 'Jane Roe' } }, { author: { display_name: 'John Doe' } }],
        primary_location: { source: { display_name: 'Mock Journal' } } },
      { id: 'https://openalex.org/W222', doi: null, title: 'A DOI-less Mock Paper', publication_year: 2019,
        authorships: [{ author: { display_name: 'Alice Smith' } }], primary_location: { source: { display_name: 'Mock Proc.' } } },
    ] });
    return true;
  }
  if (url.pathname.startsWith('/works/W')) {
    const id = url.pathname.split('/').pop();
    if (id === 'W222') {
      send(200, { id: 'https://openalex.org/W222', doi: null, title: 'A DOI-less Mock Paper', publication_year: 2019,
        authorships: [{ author: { display_name: 'Alice Smith' } }], primary_location: { source: { display_name: 'Mock Proc.' } } });
      return true;
    }
    send(200, { id: 'https://openalex.org/W111', doi: 'https://doi.org/10.1145/mock.search1', title: 'A Searchable Mock Paper', publication_year: 2021,
      authorships: [{ author: { display_name: 'Jane Roe' } }], primary_location: { source: { display_name: 'Mock Journal' } } });
    return true;
  }

  // Galley: V2 (WP16) arXiv through doi.org's DataCite record (10.48550/arXiv.<id>), before the catch-all below
  if (url.pathname.toLowerCase().startsWith('/10.48550%2farxiv.')) {
    const id = decodeURIComponent(url.pathname.slice(1)).replace(/^10\.48550\/arxiv\./i, '');
    send(200, `@misc{https://doi.org/10.48550/arxiv.${id},\n  doi = {10.48550/ARXIV.${id}},\n  url = {https://arxiv.org/abs/${id}},\n  author = {Smith, Alice and Jones, Bob},\n  title = {A Mock arXiv Paper},\n  publisher = {arXiv},\n  year = {2019},\n}`);
    return true;
  }
  // --- DOI content negotiation (any 10.x path) ---
  // Title carries an HTML &amp; like real CrossRef output — the server must
  // decode + LaTeX-escape it so the .bib compiles (regression: a bare & is an
  // alignment tab and breaks the whole document).
  if (url.pathname === '/10.1145%2Fmock.parrot') {
    // real Crossref shape: single line, `month = June`, an emoji and a Greek letter in the title
    send(200, '@article{Bender_2021, title={On the Dangers of Stochastic Parrots 🦜: α Models}, url={http://dx.doi.org/10.1145/mock.parrot}, DOI={10.1145/mock.parrot}, journal={FAccT}, author={Bender, Emily M. and Gebru, Timnit}, year={2021}, month=June }');
    return true;
  }
  if (url.pathname === '/10.1145%2Fmock.unregistered') { send(404, 'DOI not found'); return true; }
  if (url.pathname.startsWith('/10.')) {
    send(200, `@article{doe2020,\n  title = {Knowledge Discovery &amp; Data Mining},\n  author = {Doe, Jane},\n  year = {2020},\n  doi = {${url.pathname.slice(1)}},\n}`);
    return true;
  }
  // --- Galley: V2 (WP16) sources, each under its own prefix ---
  if (url.pathname === '/crossref/works') {
    const q = url.searchParams.get('query.bibliographic') || '';
    send(200, { message: { items: [
      { DOI: '10.1145/mock.search1', title: ['A Searchable Mock Paper'], author: [{ family: 'Roe', given: 'Jane' }, { family: 'Doe', given: 'John' }],
        issued: { 'date-parts': [[2021]] }, 'container-title': ['Mock Journal'], type: 'journal-article', score: /searchable mock paper/i.test(q) ? 95 : 40 },
      { DOI: '10.1145/mock.crossref2', title: ['A Crossref-only Mock Paper'], author: [{ family: 'Lee', given: 'Ann' }],
        issued: { 'date-parts': [[2018]] }, 'container-title': ['Proc. of Mock'], type: 'proceedings-article', score: 30 },
    ] } });
    return true;
  }
  if (url.pathname === '/datacite/dois') {
    send(200, { data: [{ id: '10.5281/mock.data1', attributes: { doi: '10.5281/mock.data1', titles: [{ title: 'A Mock Dataset' }], publicationYear: 2022,
      creators: [{ name: 'Kim, Dana', familyName: 'Kim', givenName: 'Dana' }], publisher: 'Zenodo', types: { resourceTypeGeneral: 'Dataset' } } }] });
    return true;
  }
  if (url.pathname === '/pubmed/esearch.fcgi') { send(200, { esearchresult: { idlist: ['31452104'] } }); return true; }
  if (url.pathname === '/pubmed/esummary.fcgi') {
    send(200, { result: { uids: ['31452104'], 31452104: { uid: '31452104', title: 'A Mock PubMed Paper.', authors: [{ name: 'Nguyen T', authtype: 'Author' }],
      pubdate: '2019 Aug', fulljournalname: 'Mock Medicine', volume: '12', issue: '3', pages: '100-110', articleids: [{ idtype: 'pubmed', value: '31452104' }] } } });
    return true;
  }
  if (url.pathname === '/openlibrary/api/books') {
    send(200, { 'ISBN:9780262033848': { title: 'Introduction to Mock Algorithms', authors: [{ name: 'Thomas Cormen' }], publishers: [{ name: 'MIT Press' }], publish_date: '2009' } });
    return true;
  }
  if (url.pathname === '/s2/graph/v1/paper/search') { send(200, { data: [] }); return true; }
  // --- arXiv Atom feed ---
  if (url.pathname === '/api/query') {
    send(200, `<?xml version="1.0"?>\n<feed><title>arXiv Query</title><entry><title>A Mock arXiv Paper</title><published>2019-01-01T00:00:00Z</published><author><name>Alice Smith</name></author><author><name>Bob Jones</name></author></entry></feed>`);
    return true;
  }
  return false;
}
