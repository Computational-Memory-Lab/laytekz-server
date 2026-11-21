/**
 * Galley: addresses that skip the wait for approval.
 *
 * Under ALDINE_SIGNUP=approval a new account waits until an administrator
 * approves it on /admin. An address on this list, or an address whose domain
 * is on it (written "@example.org"), is approved the moment it signs in, and
 * an account that was already waiting is approved at its next sign-in. A
 * listed account is an ordinary account, not an administrator, and an account
 * an administrator disabled stays disabled.
 *
 * Only a confirmed address counts (auth.ts checks emailPending; a single
 * sign-on address is one the provider verified), so nobody is approved by
 * typing an address they do not own.
 *
 * Kept in <meta>/preapproved.json and edited on /admin. The file is read
 * again whenever it changes, so an edit made on the server itself (or by a
 * script that fills it from a mailing list) applies without a restart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { metaDir } from './config.js';

export const MAX_PREAPPROVED = 5000;
const EMAIL = /^[^\s@,;<>"'()]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const DOMAIN = /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export interface PreApproved { entries: string[]; updatedAt: string | null; updatedBy: string | null }

const file = () => path.join(metaDir, 'preapproved.json');

/**
 * The addresses and "@domain" entries in a pasted text, lower-cased, without
 * repeats, in first-seen order. Anything without an "@" is skipped, so a
 * member list exported as CSV (names, dates, roles beside the addresses) can
 * be pasted as it is. `invalid` holds what has an "@" but is neither.
 */
export function parseEntries(raw: unknown): { entries: string[]; invalid: string[] } {
  const entries: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const part of String(raw ?? '').split(/[\s,;]+/)) {
    const token = part.replace(/^[<"'(]+|[>"'):.]+$/g, '').toLowerCase();
    if (!token.includes('@') || seen.has(token)) continue;
    seen.add(token);
    if (EMAIL.test(token) || DOMAIN.test(token)) entries.push(token);
    else invalid.push(token.slice(0, 80));
  }
  return { entries, invalid };
}

let cache: { mtimeMs: number; value: PreApproved; set: Set<string> } | null = null;

function load(): { value: PreApproved; set: Set<string> } {
  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(file()).mtimeMs; } catch { /* no list yet */ }
  if (cache && cache.mtimeMs === mtimeMs) return cache;
  let value: PreApproved = { entries: [], updatedAt: null, updatedBy: null };
  if (mtimeMs >= 0) {
    try {
      const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
      const list = Array.isArray(j) ? j : j?.entries;
      value = {
        entries: parseEntries(Array.isArray(list) ? list.join('\n') : '').entries.slice(0, MAX_PREAPPROVED),
        updatedAt: typeof j?.updatedAt === 'string' ? j.updatedAt : null,
        updatedBy: typeof j?.updatedBy === 'string' ? j.updatedBy : null,
      };
    } catch (err: any) {
      // An unreadable list approves nobody: the stricter outcome.
      console.warn(`[laytekz] ${file()} could not be read (${err?.message ?? err}); nobody is approved automatically until it is fixed`);
    }
  }
  cache = { mtimeMs, value, set: new Set(value.entries) };
  return cache;
}

export const preApproved = (): PreApproved => load().value;

/** Whether this address, or its domain, is on the list. */
export function isPreApproved(email: string | null | undefined): boolean {
  const e = String(email ?? '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return false;
  const { set } = load();
  return set.has(e) || set.has(e.slice(at));
}

/** Replaces the list. Throws, saving nothing, when an entry is neither an address nor "@domain". */
export function setPreApproved(raw: unknown, by: string, now = new Date()): PreApproved {
  const { entries, invalid } = parseEntries(Array.isArray(raw) ? raw.join('\n') : raw);
  if (invalid.length) throw new Error(`Not an email address or an @domain: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? ` and ${invalid.length - 5} more` : ''}`);
  if (entries.length > MAX_PREAPPROVED) throw new Error(`The list holds at most ${MAX_PREAPPROVED} entries; this one has ${entries.length}`);
  const value: PreApproved = { entries, updatedAt: now.toISOString(), updatedBy: by };
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file());
  cache = null;
  return load().value;
}
