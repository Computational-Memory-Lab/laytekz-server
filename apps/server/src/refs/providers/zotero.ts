/**
 * Laytekz V2 (WP35): Zotero as a library provider. The account's key is the
 * V1 `connections` row (zotero.ts savedKey), whether it was pasted or came
 * from "Sign in with Zotero" (OAuth 1.0a, only when the operator registered
 * an app). Exports ask for JSON with the BibTeX or biblatex export included
 * per item (`format=json&include=biblatex`), so every entry arrives with its
 * Zotero item key: that is what rename detection and subcollections
 * (de-duplicated by item key) rest on.
 */
import crypto from 'node:crypto';
import * as zotero from '../../zotero.js';
import { librariesConfig } from '../config-libraries.js';
import type { BibFormat } from '../bibtex.js';
import {
  LibraryAccessError, NotConnectedError, descendants, entryKeyOf, pathOf,
  type CollectionInfo, type ExportResult, type ExportedItem, type LibraryInfo, type LibraryProvider, type SearchHit,
} from './types.js';

export const LIBRARY_RE = /^(users|groups)\/\d{1,12}$/;
export const COLLECTION_RE = /^[A-Za-z0-9]{1,16}$/;

const api = () => librariesConfig().zoteroApi;
const headers = (key: string) => ({ 'Zotero-API-Version': '3', 'Zotero-API-Key': key });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function keyOf(accountId: string): Promise<zotero.SavedKey> {
  const k = await zotero.savedKey(accountId);
  if (!k) throw new NotConnectedError('zotero');
  return k;
}

/** One GET with Zotero's rate rules: 429 and Retry-After waited out (at most 3 times), 401/403 as an access error. */
async function zget(apiKey: string, url: string, extra: Record<string, string> = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { ...headers(apiKey), ...extra }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 429 && attempt < 3) {
      await res.body?.cancel().catch(() => undefined);
      await sleep(Math.min(30, Number(res.headers.get('Retry-After') || 5)) * 1000);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      throw new LibraryAccessError('This Zotero key can\'t read that library. In Zotero, give the key read access to it, then sync again.', res.status);
    }
    return res;
  }
}

interface ZItem { key: string; data?: { title?: string; date?: string; creators?: Array<{ lastName?: string; firstName?: string; name?: string }> }; biblatex?: string; bibtex?: string }

/** Every page of a multi-item request, 100 at a time, honouring Backoff. */
async function allItems(apiKey: string, base: string, format: BibFormat): Promise<{ items: ZItem[]; version: number }> {
  const out: ZItem[] = [];
  let version = 0;
  for (let start = 0; ; start += 100) {
    const res = await zget(apiKey, `${base}?format=json&include=${format}&itemType=-attachment&limit=100&start=${start}`);
    if (!res.ok) throw new Error(`Zotero export failed (HTTP ${res.status})`);
    version = Number(res.headers.get('Last-Modified-Version') || version);
    const total = Number(res.headers.get('Total-Results') || 0);
    const page = (await res.json()) as ZItem[];
    if (!Array.isArray(page)) break;
    out.push(...page);
    if (!page.length || start + 100 >= total) break;
    const backoff = Number(res.headers.get('Backoff') || 0);
    if (backoff) await sleep(Math.min(60, backoff) * 1000);
  }
  return { items: out, version };
}

function toExported(items: ZItem[], format: BibFormat): ExportedItem[] {
  const out: ExportedItem[] = [];
  for (const it of items) {
    const bib = (format === 'bibtex' ? it.bibtex : it.biblatex) ?? it.biblatex ?? it.bibtex;
    if (typeof bib !== 'string' || typeof it.key !== 'string') continue;
    const key = entryKeyOf(bib);
    if (!key) continue;
    out.push({ itemId: it.key, key, bibtex: bib.trim() });
  }
  return out;
}

async function collections(apiKey: string, library: string): Promise<CollectionInfo[]> {
  const list = (await zotero.listCollections(apiKey, library)).map((c) => ({ id: c.key, name: c.name, parent: c.parent || null }));
  return list.map((c) => ({ ...c, path: pathOf(list, c.id) ?? c.name }));
}

export const zoteroProvider: LibraryProvider = {
  id: 'zotero',
  enabled: () => true,
  async connection(accountId) {
    const k = await zotero.savedKey(accountId);
    return k ? { connected: true, name: k.username } : { connected: false };
  },
  forget: (accountId) => zotero.forgetKey(accountId),
  async listLibraries(accountId) {
    const k = await keyOf(accountId);
    const groups = await zotero.listGroups(k.apiKey, k.userID);
    return [{ id: `users/${k.userID}`, name: 'My Library', kind: 'user' as const }, ...groups.map((g) => ({ id: `groups/${g.id}`, name: g.name, kind: 'group' as const }))] satisfies LibraryInfo[];
  },
  async listCollections(accountId, library) {
    const k = await keyOf(accountId);
    return collections(k.apiKey, library);
  },
  async names(accountId, library, collection) {
    const out: { libraryName?: string; collectionName?: string } = {};
    const k = await zotero.savedKey(accountId).catch(() => null);
    if (library.startsWith('users/')) out.libraryName = 'My Library';
    if (!k) return out;
    if (library.startsWith('groups/')) out.libraryName = (await zotero.listGroups(k.apiKey, k.userID).catch(() => [])).find((g) => `groups/${g.id}` === library)?.name;
    if (collection) out.collectionName = pathOf(await collections(k.apiKey, library).catch(() => []), collection);
    return out;
  },
  async exportItems(accountId, library, collection, o) {
    const k = await keyOf(accountId);
    return exportWithKey(k.apiKey, library, collection, o);
  },
  async search(accountId, library, q, format) {
    const k = await keyOf(accountId);
    const res = await zget(k.apiKey, `${api()}/${library}/items/top?q=${encodeURIComponent(q)}&qmode=titleCreatorYear&format=json&include=data,${format}&itemType=-attachment&limit=20`);
    if (!res.ok) throw new Error(`Zotero search failed (HTTP ${res.status})`);
    const items = (await res.json()) as ZItem[];
    const hits: SearchHit[] = [];
    for (const it of Array.isArray(items) ? items : []) {
      const [e] = toExported([it], format);
      if (!e) continue;
      hits.push({
        itemId: e.itemId, key: e.key, bibtex: e.bibtex,
        title: it.data?.title ?? '',
        authors: (it.data?.creators ?? []).map((c) => c.name || [c.firstName, c.lastName].filter(Boolean).join(' ')).filter(Boolean),
        year: /\d{4}/.exec(it.data?.date ?? '')?.[0] ?? '',
      });
    }
    return hits;
  },
};

/**
 * The library or collection as items. With `since`, a cheap probe first:
 * Zotero answers 304 when nothing in the library changed since that version
 * (library-wide, so it is safe for a collection too).
 */
export async function exportWithKey(apiKey: string, library: string, collection: string | undefined, o: { since?: number | string; format: BibFormat; recursive: boolean }): Promise<ExportResult | 'unchanged'> {
  if (o.since !== undefined && o.since !== '') {
    const probe = await zget(apiKey, `${api()}/${library}/items/top?format=versions&limit=1`, { 'If-Modified-Since-Version': String(o.since) });
    await probe.body?.cancel().catch(() => undefined);
    if (probe.status === 304) return 'unchanged';
  }
  const ids = collection ? (o.recursive ? descendants(await collections(apiKey, library), collection) : [collection]) : [null];
  const seen = new Set<string>();
  const items: ExportedItem[] = [];
  let version = 0;
  for (const c of ids) {
    const base = c ? `${api()}/${library}/collections/${c}/items/top` : `${api()}/${library}/items/top`;
    const page = await allItems(apiKey, base, o.format);
    version = Math.max(version, page.version);
    for (const it of toExported(page.items, o.format)) {
      if (seen.has(it.itemId)) continue;
      seen.add(it.itemId);
      items.push(it);
    }
  }
  return { items, version };
}

// ---- Sign in with Zotero (OAuth 1.0a, HMAC-SHA1) ----

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The Authorization header for one OAuth 1.0a request (RFC 5849, section 3.4.2). */
export function oauthHeader(method: string, url: string, consumer: { key: string; secret: string }, token: { key?: string; secret?: string }, extra: Record<string, string> = {}, nonce = crypto.randomBytes(12).toString('hex'), timestamp = String(Math.floor(Date.now() / 1000))): string {
  const params: Record<string, string> = {
    oauth_consumer_key: consumer.key, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp, oauth_version: '1.0', ...(token.key ? { oauth_token: token.key } : {}), ...extra,
  };
  const u = new URL(url);
  const all: [string, string][] = [...Object.entries(params), ...[...u.searchParams.entries()]];
  const norm = all.map(([k, v]) => [enc(k), enc(v)] as const).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const base = `${method.toUpperCase()}&${enc(baseUrl)}&${enc(norm)}`;
  const sig = crypto.createHmac('sha1', `${enc(consumer.secret)}&${enc(token.secret ?? '')}`).update(base).digest('base64');
  return 'OAuth ' + Object.entries({ ...params, oauth_signature: sig }).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(', ');
}

/** Step 1: a request token, and the page the person approves it on. */
export async function zoteroOAuthStart(callback: string): Promise<{ token: string; secret: string; authorizeUrl: string }> {
  const cfg = librariesConfig();
  if (!cfg.zoteroOAuth) throw new Error('Sign in with Zotero is not set up on this server');
  const url = `${cfg.zoteroOAuthBase}/request`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: oauthHeader('POST', url, cfg.zoteroOAuth, {}, { oauth_callback: callback }) }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Zotero refused the sign-in (HTTP ${res.status})`);
  const p = new URLSearchParams(await res.text());
  const token = p.get('oauth_token');
  const secret = p.get('oauth_token_secret');
  if (!token || !secret) throw new Error('Zotero sent no request token');
  const q = new URLSearchParams({ oauth_token: token, library_access: '1', notes_access: '0', write_access: '0', all_groups: 'read' });
  return { token, secret, authorizeUrl: `${cfg.zoteroOAuthBase}/authorize?${q}` };
}

/** Step 3: the verifier for an API key (Zotero returns it as the token secret) and the account. */
export async function zoteroOAuthFinish(token: string, secret: string, verifier: string): Promise<zotero.SavedKey> {
  const cfg = librariesConfig();
  if (!cfg.zoteroOAuth) throw new Error('Sign in with Zotero is not set up on this server');
  const url = `${cfg.zoteroOAuthBase}/access`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: oauthHeader('POST', url, cfg.zoteroOAuth, { key: token, secret }, { oauth_verifier: verifier }) }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Zotero refused the sign-in (HTTP ${res.status})`);
  const p = new URLSearchParams(await res.text());
  const apiKey = p.get('oauth_token_secret');
  const userID = Number(p.get('userID'));
  if (!apiKey || !Number.isSafeInteger(userID)) throw new Error('Zotero sent no key');
  return { apiKey, userID, username: p.get('username') || undefined };
}
