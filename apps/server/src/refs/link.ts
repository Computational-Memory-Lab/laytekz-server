/**
 * Laytekz V2 (WP35): library links. Each editor of a project may link their
 * own reference-manager library (Zotero, Mendeley, or a .bib on their
 * computer pushed by the desktop app) to a .bib file of their own, at most 5
 * per project. The server writes that file on every sync; clients keep it
 * read-only.
 *
 * Where things live:
 *  - the link definitions: `ProjectMeta.ext['libraries.links']`
 *    (server only, never a secret: credentials stay in `connections`);
 *  - sync state (last sync, version cursor, item id → citation key map):
 *    `META_DIR/links/<projectId>/<linkId>.json`;
 *  - V1's `meta.zotero` (which holds the owner's key) stays where it is and
 *    is presented as the link `zotero`, synced by V1's own code.
 *
 * A sync runs as a background job (at most 2 server-wide, one per link), so
 * a large library never holds an HTTP request open past a proxy's timeout.
 * It keeps V1's write path: flush the open docs, write the file, refresh the
 * open docs from disk, commit only that file.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import * as store from '../store.js';
import * as zotero from '../zotero.js';
import { applyEditsToDoc, flushBranchDocs, openDocContent, refreshBranchDocsFromDisk, signalBranch } from '../collab.js';
import { commitPaths, ensureWorktree, type CommitAuthor } from '../gitops.js';
import { maskComments, paperBibFormat, type BibFormat } from '../bibload.js';
import { noteEdit, type Editor } from '../activity.js';
import { AUTH_ENABLED, getUser, pubFull } from '../auth.js';
import { isMember } from '../authz.js';
import { isHiddenPath } from '../util.js';
import { zoteroProvider } from './providers/zotero.js';
import { mendeleyProvider } from './providers/mendeley.js';
import {
  LibraryAccessError, NotConnectedError, PROVIDER_IDS, PROVIDER_LABEL, uniqueItemKeys,
  type ExportedItem, type LibraryProvider, type ProviderId,
} from './providers/types.js';

export const LINKS_KEY = 'libraries.links';
/** The id V1's `meta.zotero` link is presented under. */
export const LEGACY_ID = 'zotero';
export const LINK_ID_RE = /^[a-z0-9]{1,24}$/;
/** Branch signal key: open editors refetch the links (read-only files, the panel). */
export const LIBRARIES_SIGNAL = 'libraries';

export const OMIT_GROUPS = ['abstract', 'files', 'tags', 'extra'] as const;
export type OmitGroup = typeof OMIT_GROUPS[number];
/** Left out unless the linker keeps them: everyone who can open the project reads the file. */
export const DEFAULT_OMIT: readonly OmitGroup[] = ['abstract', 'files', 'tags'];
const OMIT_FIELDS: Record<OmitGroup, readonly string[]> = {
  abstract: ['abstract'],
  files: ['file', 'annote', 'annotation'],
  tags: ['keywords', 'mendeley-tags'],
  extra: ['note', 'extra'],
};

export interface LibraryLink {
  id: string;
  provider: ProviderId;
  /** The account whose credentials the link syncs with ('local' without accounts). */
  linkedBy: string;
  /** Zotero `users/<id>` or `groups/<id>`; Mendeley `me` or `group:<id>`; desktop: '' */
  library: string;
  collection?: string;
  recursive: boolean;
  libraryName?: string;
  collectionName?: string;
  bibFile: string;
  omitFields: OmitGroup[];
  createdAt: string;
  /** V1's meta.zotero, read through (not stored in ext). */
  legacy?: true;
}

const isStr = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length <= max;

export function validLink(v: unknown): v is LibraryLink {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const l = v as Record<string, unknown>;
  return isStr(l.id, 24) && LINK_ID_RE.test(l.id) && l.id !== LEGACY_ID
    && (PROVIDER_IDS as readonly unknown[]).includes(l.provider)
    && isStr(l.linkedBy, 128) && !!l.linkedBy && isStr(l.library, 128)
    && (l.collection === undefined || isStr(l.collection, 128))
    && typeof l.recursive === 'boolean'
    && (l.libraryName === undefined || isStr(l.libraryName, 300))
    && (l.collectionName === undefined || isStr(l.collectionName, 600))
    && isStr(l.bibFile, 400) && /\.bib$/i.test(l.bibFile) && !isHiddenPath(l.bibFile)
    && Array.isArray(l.omitFields) && l.omitFields.every((g) => (OMIT_GROUPS as readonly unknown[]).includes(g))
    && isStr(l.createdAt, 40) && l.legacy === undefined;
}

export function validLinks(v: unknown): boolean {
  return Array.isArray(v) && v.length <= 5 && v.every(validLink) && new Set(v.map((l) => (l as LibraryLink).id)).size === v.length;
}

/** The links stored in `ext` (an invalid value reads as none). */
export function storedLinks(meta: store.ProjectMeta): LibraryLink[] {
  const v = meta.ext?.[LINKS_KEY];
  return validLinks(v) ? (v as LibraryLink[]).map((l) => ({ ...l })) : [];
}

/** V1's link as a link. */
export function legacyLink(meta: store.ProjectMeta): LibraryLink | null {
  const z = meta.zotero;
  if (!z) return null;
  return {
    id: LEGACY_ID, provider: 'zotero', linkedBy: meta.ownerId ?? 'local', library: z.libraryPrefix,
    ...(z.collectionKey ? { collection: z.collectionKey } : {}), recursive: false,
    libraryName: z.libraryName ?? (z.libraryPrefix.startsWith('users/') ? 'My Library' : undefined),
    ...(z.collectionName ? { collectionName: z.collectionName } : {}),
    bibFile: z.bibFile, omitFields: [], createdAt: meta.createdAt, legacy: true,
  };
}

export function projectLinks(meta: store.ProjectMeta): LibraryLink[] {
  const legacy = legacyLink(meta);
  return [...(legacy ? [legacy] : []), ...storedLinks(meta)];
}

/** Transferring a project: the previous owner's links go (they run on that account), so does V1's link. */
export function withoutLinksBy(meta: store.ProjectMeta, accountId: string): void {
  delete meta.zotero;
  const kept = storedLinks(meta).filter((l) => l.linkedBy !== accountId);
  if (!meta.ext || !(LINKS_KEY in meta.ext)) return;
  if (kept.length) meta.ext[LINKS_KEY] = kept;
  else delete meta.ext[LINKS_KEY];
}

// ---- who may change a link, and when a link is paused ----

export function providerFor(id: ProviderId): LibraryProvider | null {
  return id === 'zotero' ? zoteroProvider : id === 'mendeley' ? mendeleyProvider : null;
}

/** The linker's name for display, or null when the account is gone. */
export async function accountName(accountId: string): Promise<string | null> {
  if (!AUTH_ENABLED && accountId === 'local') return 'You';
  const u = await getUser(accountId).catch(() => null);
  return u ? u.name || 'Someone' : null;
}

/**
 * Why a link cannot sync now, as a sentence, or null. The linker lost their
 * account, was disabled, is no longer a member, or disconnected the
 * provider; a sync that the provider refused is remembered in the state.
 */
export async function pausedReason(meta: store.ProjectMeta, link: LibraryLink): Promise<string | null> {
  const p = providerFor(link.provider);
  if (link.provider === 'mendeley' && !mendeleyProvider.enabled()) return 'Paused: Mendeley is not set up on this server any more.';
  let name = 'You';
  if (AUTH_ENABLED || link.linkedBy !== 'local') {
    const u = await getUser(link.linkedBy).catch(() => null);
    if (!u) return 'Paused: the person who linked this library no longer has an account. Link your own library or unlink.';
    name = u.name || 'The person who linked it';
    if (u.disabledAt) return `Paused: ${name}'s account is disabled. Link your own library or unlink.`;
    if (!isMember(meta, await pubFull(u))) return `Paused: ${name} no longer has access. Link your own library or unlink.`;
  }
  if (p && !link.legacy && !(await p.connection(link.linkedBy).catch(() => ({ connected: false }))).connected) {
    return `Paused: ${name === 'You' ? 'you' : name} disconnected ${PROVIDER_LABEL[link.provider]}. Link your own library or unlink.`;
  }
  return null;
}

// ---- sync state (META_DIR/links/<projectId>/<linkId>.json) ----

export interface LinkState {
  lastSyncedAt?: string;
  version?: number | string;
  format?: BibFormat;
  /** Item id → citation key at the last sync (rename detection). */
  items?: Record<string, string>;
  /** The last sync the provider refused, as a sentence; cleared by the next one that works. */
  pausedReason?: string;
}

const stateFile = (projectId: string, linkId: string) => path.join(config.metaRoot, 'links', projectId, `${linkId}.json`);

export function readState(projectId: string, linkId: string): LinkState {
  try { return JSON.parse(fs.readFileSync(stateFile(projectId, linkId), 'utf8')) as LinkState; } catch { return {}; }
}

export function writeState(projectId: string, linkId: string, s: LinkState): void {
  const f = stateFile(projectId, linkId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, f);
}

export function dropState(projectId: string, linkId: string): void {
  fs.rmSync(stateFile(projectId, linkId), { force: true });
}

/** The state as GET …/libraries shows it; V1's link keeps its own in meta.zotero. */
export function linkStatus(meta: store.ProjectMeta, link: LibraryLink): { lastSyncedAt: string | null; storedPause?: string } {
  if (link.legacy) return { lastSyncedAt: meta.zotero?.lastSyncedAt ?? null };
  const s = readState(meta.id, link.id);
  return { lastSyncedAt: s.lastSyncedAt ?? null, ...(s.pausedReason ? { storedPause: s.pausedReason } : {}) };
}

// ---- the field filter ----

export function omitFieldNames(groups: readonly OmitGroup[]): Set<string> {
  return new Set(groups.flatMap((g) => OMIT_FIELDS[g] ?? []));
}

/**
 * The .bib text without the named fields, everything else byte for byte.
 * Scans entries at brace depth 1 (values in braces, quotes or bare), so a
 * field name inside another field's value is never touched.
 */
export function stripFields(bib: string, names: ReadonlySet<string>): string {
  if (!names.size) return bib;
  let out = '';
  let i = 0;
  const n = bib.length;
  while (i < n) {
    const at = bib.indexOf('@', i);
    if (at < 0) { out += bib.slice(i); break; }
    const head = /^@\s*([A-Za-z]+)\s*([{(])/.exec(bib.slice(at));
    if (!head || ['comment', 'preamble', 'string'].includes(head[1].toLowerCase())) { out += bib.slice(i, at + 1); i = at + 1; continue; }
    const close = head[2] === '{' ? '}' : ')';
    let j = at + head[0].length;
    // the key, up to the first comma
    const comma = bib.indexOf(',', j);
    const end = bib.indexOf(close, j);
    if (comma < 0 || (end >= 0 && end < comma)) { out += bib.slice(i, at + 1); i = at + 1; continue; }
    out += bib.slice(i, comma + 1);
    j = comma + 1;
    for (;;) {
      const fieldStart = j;
      while (j < n && /\s/.test(bib[j])) j++;
      if (j >= n) { out += bib.slice(fieldStart); i = n; break; }
      if (bib[j] === close) { out += bib.slice(fieldStart, j + 1); i = j + 1; break; }
      const nm = /^([A-Za-z][\w:.+-]*)\s*=\s*/.exec(bib.slice(j, j + 200));
      if (!nm) { out += bib.slice(fieldStart, j + 1); j++; continue; }
      let k = j + nm[0].length;
      // value: one or more parts joined with #
      for (;;) {
        if (bib[k] === '{') {
          for (let depth = 0; k < n; k++) { if (bib[k] === '{') depth++; else if (bib[k] === '}' && --depth === 0) { k++; break; } }
        } else if (bib[k] === '"') {
          k++;
          for (let depth = 0; k < n; k++) { if (bib[k] === '{') depth++; else if (bib[k] === '}') depth--; else if (bib[k] === '"' && depth <= 0) { k++; break; } }
        } else {
          while (k < n && !/[,#\s]/.test(bib[k]) && bib[k] !== close) k++;
        }
        let m = k;
        while (m < n && /\s/.test(bib[m])) m++;
        if (bib[m] === '#') { k = m + 1; while (k < n && /\s/.test(bib[k])) k++; continue; }
        break;
      }
      let after = k;
      while (after < n && /[ \t]/.test(bib[after])) after++;
      const hasComma = bib[after] === ',';
      if (names.has(nm[1].toLowerCase())) {
        j = hasComma ? after + 1 : k;
      } else {
        out += bib.slice(fieldStart, hasComma ? after + 1 : k);
        j = hasComma ? after + 1 : k;
      }
    }
  }
  return out;
}

// ---- citations in the paper ----

const CITE_RE = /\\(?:[A-Za-z]*cite[A-Za-z]*|bibentry)\*?((?:(?:\s*(?:\[[^\]]*\]|\([^)]*\)))*\s*\{[^{}]*\})+)/g;
const KEYS_RE = /\{([^{}]*)\}/g;

/** Every key the text cites (comments left out), with the offsets of each occurrence. */
export function citeOccurrences(text: string): Array<{ key: string; from: number; to: number }> {
  const masked = maskComments(text);
  const out: Array<{ key: string; from: number; to: number }> = [];
  for (const m of masked.matchAll(CITE_RE)) {
    const groupsAt = m.index! + m[0].length - m[1].length;
    for (const g of m[1].matchAll(KEYS_RE)) {
      const inner = g.index! + 1;
      let pos = 0;
      for (const part of g[1].split(',')) {
        const lead = part.length - part.trimStart().length;
        const key = part.trim();
        if (key) out.push({ key, from: groupsAt + inner + pos + lead, to: groupsAt + inner + pos + lead + key.length });
        pos += part.length + 1;
      }
    }
  }
  return out;
}

export function citedKeys(text: string): Set<string> {
  return new Set(citeOccurrences(text).map((o) => o.key));
}

/** The edits that rename cited keys (`renames`: old → new). */
export function renameEdits(text: string, renames: ReadonlyMap<string, string>): Array<{ from: number; to: number; insert: string }> {
  return citeOccurrences(text).filter((o) => renames.has(o.key)).map((o) => ({ from: o.from, to: o.to, insert: renames.get(o.key)! }));
}

const texFiles = (projectId: string, branch: string) => store.listFiles(projectId, branch).filter((e) => e.type === 'file' && /\.(tex|ltx)$/i.test(e.path)).map((e) => e.path);

function currentText(projectId: string, branch: string, file: string): string | null {
  const open = openDocContent(projectId, branch, file);
  if (open !== null) return open;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(store.readFile(projectId, branch, file)); } catch { return null; }
}

export function branchCitedKeys(projectId: string, branch: string): Set<string> {
  const out = new Set<string>();
  for (const f of texFiles(projectId, branch)) {
    const t = currentText(projectId, branch, f);
    if (t) for (const k of citedKeys(t)) out.add(k);
  }
  return out;
}

export interface RenamedKey { from: string; to: string }

/** Items whose key changed since the last sync, when the old key is gone and the paper cites it. */
export function detectRenames(before: Record<string, string> | undefined, items: readonly ExportedItem[], cited: ReadonlySet<string>): RenamedKey[] {
  if (!before) return [];
  const now = new Set(items.map((i) => i.key));
  const out: RenamedKey[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const old = before[it.itemId];
    if (!old || old === it.key || now.has(old) || !cited.has(old) || seen.has(old)) continue;
    seen.add(old);
    out.push({ from: old, to: it.key });
  }
  return out;
}

/** "Update citations": every cite of an old key becomes the new key, as one edit per file and one commit. */
export async function updateCitations(projectId: string, branch: string, renames: readonly RenamedKey[], by: Editor | null, author?: CommitAuthor): Promise<{ files: string[]; replaced: number }> {
  await ensureWorktree(projectId, branch);
  const map = new Map(renames.map((r) => [r.from, r.to]));
  const files: string[] = [];
  let replaced = 0;
  for (const f of texFiles(projectId, branch)) {
    // Read and edit in one tick: the offsets stay true for the live doc.
    const open = openDocContent(projectId, branch, f);
    const text = open ?? currentText(projectId, branch, f);
    if (text === null) continue;
    const edits = renameEdits(text, map);
    if (!edits.length) continue;
    if (open === null || applyEditsToDoc(projectId, branch, f, edits) === 'no-doc') {
      let next = text;
      for (const e of [...edits].sort((a, b) => b.from - a.from)) next = next.slice(0, e.from) + e.insert + next.slice(e.to);
      store.writeFile(projectId, branch, f, next);
    }
    files.push(f);
    replaced += edits.length;
  }
  if (files.length) {
    await commitPaths(projectId, branch, files, `aldine: update ${replaced} citation${replaced === 1 ? '' : 's'} renamed in the reference manager`, author).catch(() => {});
    noteEdit(projectId, branch, by);
  }
  return { files, replaced };
}

// ---- writing the linked file ----

function header(link: LibraryLink, who: string): string {
  if (link.provider === 'desktop-file') {
    return `% Pushed by the Laytekz desktop app from a .bib file on ${who}'s computer.\n% Each change to that file replaces this one: edit the file there.\n\n`;
  }
  const label = PROVIDER_LABEL[link.provider];
  const where = [link.libraryName ? `${who}'s ${link.libraryName}` : `${who}'s library`, link.collectionName].filter(Boolean).join(' > ');
  return `% Synced from ${label} (${where}) by Laytekz.\n% Each sync replaces this file: change entries in ${label}, then sync.\n\n`;
}

/** Writes the file when its text changed; true when it did. */
async function writeLinkedFile(projectId: string, branch: string, link: LibraryLink, text: string, by: Editor | null): Promise<boolean> {
  await ensureWorktree(projectId, branch);
  let existing: string | null = null;
  try { existing = store.readFile(projectId, branch, link.bibFile).toString('utf8'); } catch { existing = null; }
  if (existing === text) return false;
  // The refresh resets every open doc that differs from its file: what was typed but not saved must be on disk first.
  flushBranchDocs(projectId, branch);
  store.writeFile(projectId, branch, link.bibFile, text);
  refreshBranchDocsFromDisk(projectId, branch, [link.bibFile]);
  // The file only: other changes stay in the working tree for the autosave (V1's rule).
  await commitPaths(projectId, branch, [link.bibFile], `aldine: sync ${PROVIDER_LABEL[link.provider] === 'a file on a computer' ? 'a local .bib' : `${PROVIDER_LABEL[link.provider]} library`} into ${link.bibFile}`).catch(() => {});
  noteEdit(projectId, branch, by);
  return true;
}

export interface SyncOutcome {
  synced: boolean; unchanged?: boolean; fresh?: boolean; itemCount?: number; bibFile: string; format: BibFormat;
  renamedKeys?: RenamedKey[];
}

/**
 * Syncs one link into its file on `branch`. `olderThan` (seconds): skip when
 * the last sync is newer and still fits the paper's format (`fresh`).
 */
export async function syncLink(projectId: string, branch: string, link: LibraryLink, o: { force?: boolean; olderThan?: number; by?: Editor | null } = {}): Promise<SyncOutcome> {
  await ensureWorktree(projectId, branch);
  if (link.legacy) {
    const r = await zotero.syncProject(projectId, branch, !!o.force, undefined, o.olderThan);
    if (r.synced) noteEdit(projectId, branch, o.by ?? null);
    return { synced: r.synced, ...(r.unchanged ? { unchanged: true } : {}), ...(r.fresh ? { fresh: true } : {}), ...(r.itemCount !== undefined ? { itemCount: r.itemCount } : {}), bibFile: link.bibFile, format: r.format ?? 'biblatex' };
  }
  const provider = providerFor(link.provider);
  if (!provider) throw new Error('A file on a computer syncs from the desktop app');
  const format = paperBibFormat(projectId, branch);
  const state = readState(projectId, link.id);
  const exists = store.fileExists(projectId, branch, link.bibFile);
  if (o.olderThan !== undefined && !o.force && exists && state.format === format) {
    const at = Date.parse(state.lastSyncedAt || '');
    if (!Number.isNaN(at) && Date.now() - at < o.olderThan * 1000) return { synced: false, fresh: true, bibFile: link.bibFile, format };
  }
  const since = !o.force && exists && state.format === format ? state.version : undefined;
  let result;
  try {
    result = await provider.exportItems(link.linkedBy, link.library, link.collection, { since, format, recursive: link.recursive });
  } catch (err) {
    if (err instanceof LibraryAccessError) writeState(projectId, link.id, { ...state, pausedReason: `Paused: ${err.message}` });
    throw err;
  }
  const now = new Date().toISOString();
  if (result === 'unchanged') {
    writeState(projectId, link.id, { ...state, lastSyncedAt: now, pausedReason: undefined });
    return { synced: false, unchanged: true, bibFile: link.bibFile, format };
  }
  const items = uniqueItemKeys(result.items);
  const who = (await accountName(link.linkedBy)) ?? 'Someone';
  const body = stripFields(items.map((i) => i.bibtex).join('\n\n'), omitFieldNames(link.omitFields));
  const renamedKeys = detectRenames(state.items, items, branchCitedKeys(projectId, branch));
  const synced = await writeLinkedFile(projectId, branch, link, header(link, who) + body.trim() + '\n', o.by ?? null);
  writeState(projectId, link.id, { lastSyncedAt: now, version: result.version, format, items: Object.fromEntries(items.map((i) => [i.itemId, i.key])) });
  return { synced, itemCount: items.length, bibFile: link.bibFile, format, ...(renamedKeys.length ? { renamedKeys } : {}) };
}

/** A desktop push: the file's content as it is on the linker's computer (filtered if they asked). */
export async function pushContent(projectId: string, branch: string, link: LibraryLink, content: string, by: Editor | null): Promise<SyncOutcome> {
  const who = (await accountName(link.linkedBy)) ?? 'Someone';
  const body = stripFields(content.replace(/\r\n?/g, '\n'), omitFieldNames(link.omitFields));
  const synced = await writeLinkedFile(projectId, branch, link, header(link, who) + body.trim() + '\n', by);
  const state = readState(projectId, link.id);
  writeState(projectId, link.id, { ...state, lastSyncedAt: new Date().toISOString(), pausedReason: undefined });
  const itemCount = (body.match(/^\s*@(?!comment|string|preamble)\w+\s*[{(]/gim) || []).length;
  return { synced, itemCount, bibFile: link.bibFile, format: paperBibFormat(projectId, branch) };
}

// ---- background jobs ----

export type JobState = 'queued' | 'running' | 'done' | 'error';
export interface SyncJob {
  id: string; projectId: string; linkId: string; branch: string; state: JobState; createdAt: number;
  result?: SyncOutcome; error?: string; code?: string;
}

const jobs = new Map<string, SyncJob>();
const activeByLink = new Map<string, string>();
const queue: Array<() => void> = [];
let running = 0;
export const MAX_RUNNING = 2;
const JOB_TTL_MS = 60 * 60_000;

function pump(): void {
  while (running < MAX_RUNNING && queue.length) {
    const next = queue.shift()!;
    running++;
    next();
  }
}

function sweep(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) if (j.createdAt < cutoff && (j.state === 'done' || j.state === 'error')) jobs.delete(id);
}

/**
 * Queues a sync of the link and returns the job; a sync of the same link
 * that has not finished is returned instead of starting another. `onFail`
 * runs when the job fails (a first sync removes the link it was creating).
 */
export function startSyncJob(projectId: string, branch: string, linkId: string, run: () => Promise<SyncOutcome>, onFail?: (err: unknown) => Promise<void>): SyncJob {
  sweep();
  const linkKey = `${projectId}/${linkId}`;
  const active = activeByLink.get(linkKey);
  const existing = active ? jobs.get(active) : undefined;
  if (existing && (existing.state === 'queued' || existing.state === 'running')) return existing;
  const job: SyncJob = { id: crypto.randomBytes(9).toString('base64url'), projectId, linkId, branch, state: 'queued', createdAt: Date.now() };
  jobs.set(job.id, job);
  activeByLink.set(linkKey, job.id);
  queue.push(() => {
    job.state = 'running';
    run().then((result) => {
      job.result = result;
      job.state = 'done';
      try { signalBranch(projectId, branch, LIBRARIES_SIGNAL, `${linkId}:${Date.now()}`); } catch { /* no open branch */ }
    }, async (err: unknown) => {
      job.state = 'error';
      job.error = err instanceof Error ? err.message : String(err);
      job.code = err instanceof LibraryAccessError ? 'access' : err instanceof NotConnectedError ? 'not-connected' : 'failed';
      if (onFail) await onFail(err).catch(() => undefined);
    }).finally(() => {
      running--;
      if (activeByLink.get(linkKey) === job.id) activeByLink.delete(linkKey);
      pump();
    });
  });
  pump();
  return job;
}

export function getJob(id: string): SyncJob | undefined {
  return jobs.get(id);
}

/** Resolves when the job settles (tests, and a route that may wait briefly). */
export async function settled(id: string, timeoutMs = 30_000): Promise<SyncJob | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const j = jobs.get(id);
    if (!j || j.state === 'done' || j.state === 'error' || Date.now() > end) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
}
