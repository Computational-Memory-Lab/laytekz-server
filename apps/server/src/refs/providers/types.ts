/**
 * Laytekz V2 (WP35): what every reference-manager provider offers the link
 * engine (refs/link.ts) and the library routes (features/libraries).
 * Credentials live only in the datastore's `connections` table, per account
 * (provider row 'zotero' or 'mendeley'), never in project metadata.
 */
import type { BibFormat } from '../bibtex.js';

export type ProviderId = 'zotero' | 'mendeley' | 'desktop-file';
export const PROVIDER_IDS: readonly ProviderId[] = ['zotero', 'mendeley', 'desktop-file'];
export const PROVIDER_LABEL: Record<ProviderId, string> = { zotero: 'Zotero', mendeley: 'Mendeley', 'desktop-file': 'a file on a computer' };

/** One exported item: the manager's own id (Zotero item key, Mendeley document id) and its entry. */
export interface ExportedItem { itemId: string; key: string; bibtex: string }

export interface ExportResult { items: ExportedItem[]; version?: number | string }

export interface LibraryInfo { id: string; name: string; kind: 'user' | 'group' }
export interface CollectionInfo { id: string; name: string; parent: string | null; path: string }
export interface SearchHit { itemId: string; key: string; title: string; authors: string[]; year: string; bibtex: string }

/** The library answered 401/403 for this account: the link pauses until the person reconnects. */
export class LibraryAccessError extends Error {
  constructor(message: string, readonly status = 403) { super(message); this.name = 'LibraryAccessError'; }
}

/** The account has no connection to the provider. */
export class NotConnectedError extends Error {
  constructor(readonly provider: ProviderId) { super(`Connect ${PROVIDER_LABEL[provider]} first`); this.name = 'NotConnectedError'; }
}

export interface ConnectionInfo { connected: boolean; name?: string }

export interface LibraryProvider {
  id: Exclude<ProviderId, 'desktop-file'>;
  /** Shown in Settings and the panel. */
  enabled(): boolean;
  connection(accountId: string): Promise<ConnectionInfo>;
  forget(accountId: string): Promise<void>;
  listLibraries(accountId: string): Promise<LibraryInfo[]>;
  listCollections(accountId: string, library: string): Promise<CollectionInfo[]>;
  /** Display names for a link (best effort, never throws). */
  names(accountId: string, library: string, collection?: string): Promise<{ libraryName?: string; collectionName?: string }>;
  /** 'unchanged' when the provider can tell nothing changed since `since`. */
  exportItems(accountId: string, library: string, collection: string | undefined, o: { since?: number | string; format: BibFormat; recursive: boolean }): Promise<ExportResult | 'unchanged'>;
  search(accountId: string, library: string, q: string, format: BibFormat): Promise<SearchHit[]>;
}

/** "CRDT Research / Sync": a collection under the ones it sits in. A loop or a missing parent ends the path. */
export function pathOf(list: ReadonlyArray<{ id: string; name: string; parent: string | null }>, id: string): string | undefined {
  const byId = new Map(list.map((c) => [c.id, c]));
  const names: string[] = [];
  const seen = new Set<string>();
  for (let c = byId.get(id); c && !seen.has(c.id); c = c.parent ? byId.get(c.parent) : undefined) {
    seen.add(c.id);
    names.unshift(c.name);
  }
  return names.length ? names.join(' / ') : undefined;
}

/** The collection and every collection below it (subcollections included). */
export function descendants(list: ReadonlyArray<{ id: string; parent: string | null }>, root: string): string[] {
  const out = [root];
  const seen = new Set(out);
  for (let i = 0; i < out.length; i++) {
    for (const c of list) if (c.parent === out[i] && !seen.has(c.id)) { seen.add(c.id); out.push(c.id); }
  }
  return out;
}

/** The citation key at the head of an entry, or null. */
export function entryKeyOf(bibtex: string): string | null {
  return /^\s*@\w+\s*[{(]\s*([^,\s]+)\s*,/.exec(bibtex)?.[1] ?? null;
}

/**
 * Keys made unique across one export: the first item (by item id, so the
 * order is stable between syncs) keeps a repeated key, the next get a, b, …
 */
export function uniqueItemKeys(items: ExportedItem[]): ExportedItem[] {
  const seen = new Set<string>();
  const sorted = [...items].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  const renamed = new Map<string, string>();
  for (const it of sorted) {
    let key = it.key;
    for (let i = 0; seen.has(key); i++) key = it.key + (i < 26 ? String.fromCharCode(97 + i) : String(i));
    seen.add(key);
    if (key !== it.key) renamed.set(it.itemId, key);
  }
  return items.map((it) => {
    const key = renamed.get(it.itemId);
    return key ? { ...it, key, bibtex: it.bibtex.replace(/^(\s*@\w+\s*[{(]\s*)[^,\s]+/, `$1${key}`) } : it;
  });
}
