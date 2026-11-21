/**
 * Laytekz V2 (WP35): Mendeley as a library provider, only when the operator
 * registered an app (MENDELEY_CLIENT_ID and MENDELEY_CLIENT_SECRET).
 *
 * OAuth 2 authorization code: the access token lasts about an hour and the
 * refresh token may rotate, so every refresh saves the new pair at once,
 * before the token is used. Tokens live only in the account's `connections`
 * row ('mendeley'), never in a project.
 *
 * Entries are built from the documents' JSON (`view=bib`, 500 per page,
 * pages followed through `Link: rel=next`), not from Mendeley's own BibTeX,
 * which escapes the underscores in DOIs. A document's `citation_key` is kept
 * when it has one.
 */
import { db } from '../../db/index.js';
import { librariesConfig } from '../config-libraries.js';
import { applyFieldStyle, bibField, cslToEntry, formatEntry, parseEntry, withKey, type BibFormat, type CslLike } from '../bibtex.js';
import { keyForEntry, validKey } from '../keys.js';
import {
  LibraryAccessError, NotConnectedError, descendants, pathOf,
  type CollectionInfo, type ExportedItem, type LibraryInfo, type LibraryProvider, type SearchHit,
} from './types.js';

const PROVIDER = 'mendeley';
export const MENDELEY_LIBRARY_RE = /^(me|group:[A-Za-z0-9-]{1,64})$/;
export const MENDELEY_FOLDER_RE = /^[A-Za-z0-9-]{1,64}$/;

export interface MendeleyConnection { accessToken: string; refreshToken: string; expiresAt: number; profileId?: string; name?: string }

function asConnection(c: Record<string, unknown> | null): MendeleyConnection | null {
  if (!c || typeof c.accessToken !== 'string' || typeof c.refreshToken !== 'string') return null;
  return {
    accessToken: c.accessToken, refreshToken: c.refreshToken,
    expiresAt: typeof c.expiresAt === 'number' ? c.expiresAt : 0,
    profileId: typeof c.profileId === 'string' ? c.profileId : undefined,
    name: typeof c.name === 'string' ? c.name : undefined,
  };
}

export async function readConnection(accountId: string): Promise<MendeleyConnection | null> {
  return asConnection(await db().getConnection(accountId, PROVIDER));
}

async function saveConnection(accountId: string, c: MendeleyConnection): Promise<void> {
  await db().setConnection(accountId, PROVIDER, { ...c });
}

function clientAuth(): string {
  const m = librariesConfig().mendeley;
  if (!m) throw new Error('Mendeley is not set up on this server');
  return 'Basic ' + Buffer.from(`${m.id}:${m.secret}`).toString('base64');
}

interface TokenAnswer { access_token?: string; refresh_token?: string; expires_in?: number }

async function tokenRequest(body: Record<string, string>): Promise<TokenAnswer> {
  const res = await fetch(`${librariesConfig().mendeleyOAuthBase}/token`, {
    method: 'POST',
    headers: { Authorization: clientAuth(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 400 || res.status === 401) throw new LibraryAccessError('Mendeley signed this account out. Connect Mendeley again.', 401);
  if (!res.ok) throw new Error(`Mendeley sign-in failed (HTTP ${res.status})`);
  const t = (await res.json()) as TokenAnswer;
  if (!t.access_token) throw new Error('Mendeley sent no access token');
  return t;
}

/** The page the person approves the connection on. */
export function mendeleyAuthorizeUrl(state: string, redirectUri: string): string {
  const cfg = librariesConfig();
  if (!cfg.mendeley) throw new Error('Mendeley is not set up on this server');
  const q = new URLSearchParams({ client_id: cfg.mendeley.id, redirect_uri: redirectUri, response_type: 'code', scope: 'all', state });
  return `${cfg.mendeleyOAuthBase}/authorize?${q}`;
}

/** The callback's code for tokens, then the profile's name; saved as the account's connection. */
export async function mendeleyConnect(accountId: string, code: string, redirectUri: string): Promise<MendeleyConnection> {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  let conn: MendeleyConnection = { accessToken: t.access_token!, refreshToken: t.refresh_token ?? '', expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
  await saveConnection(accountId, conn);
  try {
    const res = await fetch(`${librariesConfig().mendeleyApi}/profiles/me`, { headers: { Authorization: `Bearer ${conn.accessToken}`, Accept: 'application/vnd.mendeley-profiles.1+json' }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const p = (await res.json()) as { id?: string; display_name?: string; first_name?: string; last_name?: string };
      conn = { ...conn, profileId: p.id, name: p.display_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || undefined };
      await saveConnection(accountId, conn);
    }
  } catch { /* the name is for display only */ }
  return conn;
}

/** One refresh at a time per account: a rotated refresh token is single-use. */
const refreshing = new Map<string, Promise<string>>();

async function accessToken(accountId: string, force = false): Promise<string> {
  const c = await readConnection(accountId);
  if (!c) throw new NotConnectedError('mendeley');
  if (!force && c.expiresAt - 60_000 > Date.now()) return c.accessToken;
  const pending = refreshing.get(accountId);
  if (pending) return pending;
  const run = (async () => {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: c.refreshToken, redirect_uri: '' });
    // Saved before use: Mendeley may have retired the old refresh token already.
    await saveConnection(accountId, { ...c, accessToken: t.access_token!, refreshToken: t.refresh_token || c.refreshToken, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 });
    return t.access_token!;
  })();
  refreshing.set(accountId, run);
  try { return await run; } finally { refreshing.delete(accountId); }
}

/** A GET on the API: an expired or refused token is refreshed once. `url` may be a Link URL the API gave, which must stay on the API's origin. */
async function mget(accountId: string, url: string, accept: string): Promise<Response> {
  const apiBase = librariesConfig().mendeleyApi;
  const full = /^https?:/i.test(url) ? new URL(url) : new URL(url.replace(/^\/+/, ''), apiBase + '/');
  if (full.origin !== new URL(apiBase).origin) throw new Error('Mendeley sent a link to another site');
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(accountId, attempt > 0);
    const res = await fetch(full, { headers: { Authorization: `Bearer ${token}`, Accept: accept }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 401 && attempt === 0) { await res.body?.cancel().catch(() => undefined); continue; }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      throw new LibraryAccessError('Mendeley refused access to that library. Connect Mendeley again, then sync.', res.status);
    }
    if (!res.ok) throw new Error(`Mendeley answered HTTP ${res.status}`);
    return res;
  }
}

/** The `rel="next"` URL of a Link header, or null. */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
    if (m) return m[1];
  }
  return null;
}

async function allPages<T>(accountId: string, first: string, accept: string, cap = 200): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = first;
  for (let i = 0; url && i < cap; i++) {
    const res = await mget(accountId, url, accept);
    const page = (await res.json()) as T[];
    if (Array.isArray(page)) out.push(...page);
    url = nextLink(res.headers.get('link'));
  }
  return out;
}

const DOC_ACCEPT = 'application/vnd.mendeley-document.1+json';
const FOLDER_ACCEPT = 'application/vnd.mendeley-folder.1+json';
const GROUP_ACCEPT = 'application/vnd.mendeley-group.1+json';

const groupOf = (library: string) => (library.startsWith('group:') ? library.slice(6) : null);

async function folders(accountId: string, library: string): Promise<CollectionInfo[]> {
  const g = groupOf(library);
  const raw = await allPages<{ id: string; name: string; parent_id?: string }>(accountId, `/folders?limit=500${g ? `&group_id=${encodeURIComponent(g)}` : ''}`, FOLDER_ACCEPT);
  const list = raw.filter((f) => typeof f.id === 'string').map((f) => ({ id: f.id, name: String(f.name ?? ''), parent: f.parent_id || null }));
  return list.map((f) => ({ ...f, path: pathOf(list, f.id) ?? f.name }));
}

/** A Mendeley document (`view=bib`). */
export interface MendeleyDoc {
  id: string; type?: string; title?: string; year?: number; month?: number; source?: string;
  authors?: Array<{ first_name?: string; last_name?: string }>; editors?: Array<{ first_name?: string; last_name?: string }>;
  volume?: string; issue?: string; pages?: string; publisher?: string; city?: string; edition?: string; institution?: string;
  identifiers?: { doi?: string; isbn?: string; pmid?: string; arxiv?: string; issn?: string };
  websites?: string[]; keywords?: string[]; tags?: string[]; abstract?: string; citation_key?: string;
}

const CSL_TYPE: Record<string, string> = {
  journal: 'article-journal', magazine_article: 'article-journal', newspaper_article: 'article-journal',
  book: 'book', book_section: 'chapter', conference_proceedings: 'paper-conference', thesis: 'thesis',
  report: 'report', working_paper: 'preprint', web_page: 'webpage',
};

/** One document as an entry: the document's own key when it has a usable one, else surname and year. */
export function mendeleyEntry(doc: MendeleyDoc, format: BibFormat): ExportedItem {
  const names = (l?: MendeleyDoc['authors']) => (l ?? []).map((a) => ({ family: a.last_name, given: a.first_name })).filter((a) => a.family || a.given);
  const csl: CslLike = {
    type: CSL_TYPE[doc.type ?? ''] ?? (doc.type ? 'other' : 'article-journal'),
    title: doc.title, author: names(doc.authors), editor: names(doc.editors),
    year: doc.year ?? null, month: doc.month ?? null, containerTitle: doc.source,
    publisher: doc.publisher || doc.institution, place: doc.city, volume: doc.volume, issue: doc.issue, pages: doc.pages,
    edition: doc.edition, doi: doc.identifiers?.doi, isbn: doc.identifiers?.isbn, pmid: doc.identifiers?.pmid,
    eprint: doc.identifiers?.arxiv, url: doc.identifiers?.doi ? undefined : doc.websites?.[0],
  };
  let entry = cslToEntry(csl, format, 'ref');
  const p = parseEntry(entry);
  if (p) {
    const fields = [...p.fields];
    const kw = [...(doc.keywords ?? []), ...(doc.tags ?? [])].filter((k) => typeof k === 'string' && k.trim());
    if (kw.length) fields.push({ name: 'keywords', value: bibField(kw.join(', ')), bare: false });
    if (doc.abstract) fields.push({ name: 'abstract', value: bibField(doc.abstract.replace(/\s+/g, ' ')), bare: false });
    entry = formatEntry(p.type, p.key, fields);
  }
  entry = applyFieldStyle(entry, format);
  const own = doc.citation_key?.trim();
  const key = own && validKey(own) ? own : keyForEntry(entry, 'authoryear') || `mendeley${doc.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`;
  return { itemId: doc.id, key, bibtex: withKey(entry, key) };
}

async function documents(accountId: string, query: string): Promise<MendeleyDoc[]> {
  return (await allPages<MendeleyDoc>(accountId, `/documents?view=bib&limit=500${query}`, DOC_ACCEPT)).filter((d) => d && typeof d.id === 'string');
}

export const mendeleyProvider: LibraryProvider = {
  id: 'mendeley',
  enabled: () => !!librariesConfig().mendeley,
  async connection(accountId) {
    const c = await readConnection(accountId);
    return c ? { connected: true, name: c.name } : { connected: false };
  },
  forget: (accountId) => db().deleteConnection(accountId, PROVIDER),
  async listLibraries(accountId) {
    const groups = await allPages<{ id: string; name: string }>(accountId, '/groups?limit=500', GROUP_ACCEPT).catch(() => []);
    return [{ id: 'me', name: 'My library', kind: 'user' as const }, ...groups.filter((g) => typeof g.id === 'string').map((g) => ({ id: `group:${g.id}`, name: String(g.name ?? ''), kind: 'group' as const }))] satisfies LibraryInfo[];
  },
  listCollections: (accountId, library) => folders(accountId, library),
  async names(accountId, library, collection) {
    const out: { libraryName?: string; collectionName?: string } = {};
    if (library === 'me') out.libraryName = 'My library';
    else out.libraryName = (await this.listLibraries(accountId).catch(() => [])).find((l) => l.id === library)?.name;
    if (collection) out.collectionName = pathOf(await folders(accountId, library).catch(() => []), collection);
    return out;
  },
  async exportItems(accountId, library, collection, o) {
    const g = groupOf(library);
    const ids = collection ? (o.recursive ? descendants(await folders(accountId, library), collection) : [collection]) : [null];
    const seen = new Set<string>();
    const items: ExportedItem[] = [];
    for (const f of ids) {
      const q = f ? `&folder_id=${encodeURIComponent(f)}` : g ? `&group_id=${encodeURIComponent(g)}` : '';
      for (const d of await documents(accountId, q)) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        items.push(mendeleyEntry(d, o.format));
      }
    }
    return { items };
  },
  async search(accountId, _library, q, format) {
    const res = await mget(accountId, `/search/documents?query=${encodeURIComponent(q)}&view=bib&limit=20`, DOC_ACCEPT);
    const docs = (await res.json()) as MendeleyDoc[];
    return (Array.isArray(docs) ? docs : []).filter((d) => d && typeof d.id === 'string').map((d): SearchHit => {
      const e = mendeleyEntry(d, format);
      return { ...e, title: d.title ?? '', authors: (d.authors ?? []).map((a) => [a.first_name, a.last_name].filter(Boolean).join(' ')), year: d.year ? String(d.year) : '' };
    });
  },
};
