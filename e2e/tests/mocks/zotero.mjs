/**
 * Mock Zotero Web API (ZOTERO_API_BASE). It runs last and answers every path
 * the other mocks left: 403 without the test key, 404 for an unknown path
 * with it (spec 05 depends on both).
 */

export const order = 1000;

const KEY = 'test-key-123';
const USER = 777;

const BIB = `@article{turing1950,
  author = {Turing, Alan M.},
  title = {Computing Machinery and Intelligence},
  journaltitle = {Mind},
  year = {1950},
}

@book{shannon1948,
  author = {Shannon, Claude E.},
  title = {A Mathematical Theory of Communication},
  year = {1948},
}
`;

/** The same library as Zotero's BibTeX export: `journal` and `year`, which BibTeX styles read. */
const BIB_BIBTEX = `@article{turing1950,
  author = {Turing, Alan M.},
  title = {Computing Machinery and Intelligence},
  journal = {Mind},
  year = {1950},
}

@book{shannon1948,
  author = {Shannon, Claude E.},
  title = {A Mathematical Theory of Communication},
  year = {1948},
}
`;

/** Galley: V2 (WP35) the same two items with their Zotero item keys and collections, for JSON exports. */
const JSON_ITEMS = [
  {
    key: 'ITEMTUR1', collections: ['COLL1'], title: 'Computing Machinery and Intelligence', date: '1950',
    creators: [{ firstName: 'Alan M.', lastName: 'Turing' }],
    biblatex: '\n@article{turing1950,\n\ttitle = {Computing Machinery and Intelligence},\n\tauthor = {Turing, Alan M.},\n\tjournaltitle = {Mind},\n\tdate = {1950},\n\tabstract = {Can machines think?},\n\tkeywords = {ai},\n}\n',
    bibtex: '\n@article{turing1950,\n\ttitle = {Computing Machinery and Intelligence},\n\tauthor = {Turing, Alan M.},\n\tjournal = {Mind},\n\tyear = {1950},\n\tabstract = {Can machines think?},\n\tkeywords = {ai},\n}\n',
  },
  {
    key: 'ITEMSHA1', collections: ['COLL2'], title: 'A Mathematical Theory of Communication', date: '1948',
    creators: [{ firstName: 'Claude E.', lastName: 'Shannon' }],
    biblatex: '\n@book{shannon1948,\n\ttitle = {A Mathematical Theory of Communication},\n\tauthor = {Shannon, Claude E.},\n\tdate = {1948},\n}\n',
    bibtex: '\n@book{shannon1948,\n\ttitle = {A Mathematical Theory of Communication},\n\tauthor = {Shannon, Claude E.},\n\tyear = {1948},\n}\n',
  },
];

export function handle(req, res, { url, send }) {
  const auth = req.headers['zotero-api-key'];
  if (auth !== KEY) { send(403, { error: 'bad key' }); return true; }

  if (url.pathname === '/keys/current') {
    send(200, { userID: USER, username: 'testuser', access: { user: { library: true } } });
    return true;
  }
  if (url.pathname === `/users/${USER}/groups`) {
    send(200, [{ id: 4242, data: { name: 'Space Lab' } }]);
    return true;
  }
  if (url.pathname.endsWith('/collections')) {
    send(200, [
      { key: 'COLL1', data: { name: 'CRDT Research', parentCollection: false } },
      { key: 'COLL2', data: { name: 'Sync', parentCollection: 'COLL1' } },
      { key: 'COLL3', data: { name: 'Drafts', parentCollection: false } },
      { key: 'COLL4', data: { name: 'Sync', parentCollection: 'COLL3' } },
    ]);
    return true;
  }
  if (url.pathname.includes('/items/top')) {
    if (req.headers['if-modified-since-version'] && Number(req.headers['if-modified-since-version']) >= 42) {
      res.writeHead(304); res.end(); return true;
    }
    // Galley: V2 (WP35) library links ask for JSON with the export included
    // per item (`format=json&include=biblatex`), per collection; COLL2 sits
    // inside COLL1, so a link to COLL1 with subcollections gets both items.
    const format = url.searchParams.get('format');
    if (format === 'versions') { send(200, {}, { 'Last-Modified-Version': '42' }); return true; }
    if (format === 'json') {
      const include = (url.searchParams.get('include') || '').split(',');
      const which = include.includes('bibtex') && !include.includes('biblatex') ? 'bibtex' : 'biblatex';
      const coll = /\/collections\/([A-Z0-9]+)\/items\/top$/.exec(url.pathname)?.[1];
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const items = JSON_ITEMS
        .filter((it) => !coll || it.collections.includes(coll))
        .filter((it) => !q || it.title.toLowerCase().includes(q))
        .map((it) => ({ key: it.key, version: 42, [which]: which === 'bibtex' ? it.bibtex : it.biblatex, ...(include.includes('data') ? { data: { title: it.title, date: it.date, creators: it.creators } } : {}) }));
      send(200, items, { 'Last-Modified-Version': '42', 'Total-Results': String(items.length) });
      return true;
    }
    if (url.searchParams.get('format') === 'biblatex') {
      send(200, BIB, { 'Last-Modified-Version': '42', 'Total-Results': '2' });
      return true;
    }
    if (url.searchParams.get('format') === 'bibtex') {
      send(200, BIB_BIBTEX, { 'Last-Modified-Version': '42', 'Total-Results': '2' });
      return true;
    }
    send(200, { items: [] }, { 'Last-Modified-Version': '42', 'Total-Results': '0' });
    return true;
  }
  send(404, { error: 'not found' });
  return true;
}
