/**
 * Mock Mendeley API and OAuth pages, under /mendeley (MENDELEY_API_BASE) and
 * /mendeley/oauth (MENDELEY_OAUTH_BASE). WP35.
 *
 * The authorize page approves at once: it redirects to the app's callback
 * with a code and the state it was given. The token endpoint wants the e2e
 * app's Basic auth (MENDELEY_CLIENT_ID/SECRET in playwright.config.ts) and
 * rotates the refresh token on every refresh. The library holds two folders
 * (Thesis, and Chapter inside it) and three documents.
 */

export const order = 400;

const CLIENT = `Basic ${Buffer.from('e2e-mendeley:e2e-mendeley-secret').toString('base64')}`;
let tokenSeq = 0;
const tokens = new Set();

const DOCS = [
  { id: 'md-1', type: 'journal', title: 'Collaborative Editing with CRDTs', authors: [{ first_name: 'Mia', last_name: 'Ross' }], year: 2021, source: 'Journal of Shared Work', volume: '4', pages: '1-20', identifiers: { doi: '10.5555/crdt_2021' }, citation_key: 'ross2021crdt', abstract: 'Private notes.', tags: ['to-read'] },
  { id: 'md-2', type: 'book_section', title: 'Operational Transformation Revisited', authors: [{ first_name: 'Li', last_name: 'Chen' }], year: 2019, source: 'Handbook of Groupware', publisher: 'Example Press' },
  { id: 'md-3', type: 'conference_proceedings', title: 'Typesetting at Scale', authors: [{ first_name: 'Ana', last_name: 'Silva' }], year: 2023, source: 'Proceedings of DocEng' },
];
const IN_FOLDER = { 'mf-thesis': ['md-1'], 'mf-chapter': ['md-2', 'md-1'] };

async function body(req) {
  let s = '';
  for await (const c of req) s += c;
  return new URLSearchParams(s);
}

export async function handle(req, res, { url, send }) {
  if (!url.pathname.startsWith('/mendeley/')) return false;
  const p = url.pathname.slice('/mendeley'.length);

  if (p === '/oauth/authorize') {
    const back = url.searchParams.get('redirect_uri') || '';
    const state = url.searchParams.get('state') || '';
    if (url.searchParams.get('client_id') !== 'e2e-mendeley' || !/^https?:\/\//.test(back)) { send(400, 'bad client'); return true; }
    res.writeHead(302, { Location: `${back}${back.includes('?') ? '&' : '?'}code=e2e-code&state=${encodeURIComponent(state)}` });
    res.end();
    return true;
  }
  if (p === '/oauth/token' && req.method === 'POST') {
    if (req.headers.authorization !== CLIENT) { send(401, { error: 'invalid_client' }); return true; }
    const form = await body(req);
    const grant = form.get('grant_type');
    if ((grant === 'authorization_code' && form.get('code') === 'e2e-code') || (grant === 'refresh_token' && /^mr-\d+$/.test(form.get('refresh_token') || ''))) {
      const n = ++tokenSeq;
      tokens.add(`ma-${n}`);
      send(200, { access_token: `ma-${n}`, refresh_token: `mr-${n}`, expires_in: 3600, token_type: 'bearer' });
      return true;
    }
    send(400, { error: 'invalid_grant' });
    return true;
  }

  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!tokens.has(token)) { send(401, { message: 'Could not access resource because: Token has expired' }); return true; }
  if (p === '/profiles/me') { send(200, { id: 'mp-1', display_name: 'Mia Ross', first_name: 'Mia', last_name: 'Ross' }); return true; }
  if (p === '/groups') { send(200, [{ id: 'mg-1', name: 'Reading group' }]); return true; }
  if (p === '/folders') {
    if (url.searchParams.get('group_id')) { send(200, []); return true; }
    send(200, [{ id: 'mf-thesis', name: 'Thesis' }, { id: 'mf-chapter', name: 'Chapter 2', parent_id: 'mf-thesis' }]);
    return true;
  }
  if (p === '/documents') {
    const folder = url.searchParams.get('folder_id');
    const ids = folder ? IN_FOLDER[folder] ?? [] : url.searchParams.get('group_id') ? [] : DOCS.map((d) => d.id);
    send(200, DOCS.filter((d) => ids.includes(d.id)));
    return true;
  }
  if (p === '/search/documents') {
    const q = (url.searchParams.get('query') || '').toLowerCase();
    send(200, DOCS.filter((d) => d.title.toLowerCase().includes(q)));
    return true;
  }
  send(404, { message: 'not found' });
  return true;
}
