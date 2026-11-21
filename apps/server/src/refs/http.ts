/**
 * Laytekz V2 (WP16): outbound requests to bibliographic services. One place
 * sets the User-Agent (product and version only: no URL, no address), the
 * timeout, the size cap, per-host pacing shared by the whole server, 429
 * handling, a small cache, and the OpenAlex budget reading. A contact address
 * goes out only when the operator set REFERENCES_CONTACT_EMAIL, and only to
 * the services that ask for one (the callers add it; see contactUA).
 */
import { readFileSync } from 'node:fs';
import { refsConfig } from './config.js';

const VERSION = (() => {
  try { return String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '2'); } catch { return '2'; }
})();
export const USER_AGENT = `Laytekz/${VERSION}`;

/** Crossref's polite pool reads the address from the User-Agent; without one the UA carries nothing personal. */
export function contactUA(): string {
  const c = refsConfig().contact;
  return c ? `${USER_AGENT} (mailto:${c})` : USER_AGENT;
}

export class UpstreamError extends Error {
  constructor(message: string, public status = 0, public source = '') { super(message); }
}

/** Stream a response body and abort as soon as it exceeds the cap (a chunked/
 *  unknown-length upstream can't OOM us by omitting content-length). */
export async function readCapped(res: Response, cap = 2 * 1024 * 1024): Promise<string> {
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > cap) throw new Error('reference response too large');
  if (!res.body) return (await res.text()).slice(0, cap);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { await reader.cancel(); throw new Error('reference response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---- clock (tests inject one) ----
export interface Clock { now(): number; sleep(ms: number): Promise<void> }
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
let clock: Clock = realClock;
export function setClock(c: Clock | null): void { clock = c ?? realClock; }

/**
 * Requests to one host, at least `intervalMs` apart, server-wide. Waiters are
 * chained, so arXiv's one-request-per-3-s rule holds with one connection.
 */
export class Pacer {
  private next = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(public intervalMs: number) {}
  wait(): Promise<void> {
    const turn = this.chain.then(async () => {
      const now = clock.now();
      const at = Math.max(now, this.next);
      this.next = at + this.intervalMs;
      if (at > now) await clock.sleep(at - now);
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }
  /** A 429's Retry-After: nobody goes before it. */
  holdUntil(t: number): void { this.next = Math.max(this.next, t); }
  reset(): void { this.next = 0; this.chain = Promise.resolve(); }
}

/** The published limits, without a contact or key (the faster ones with). */
function pacerIntervals(): Record<string, number> {
  const c = refsConfig();
  return {
    'crossref-list': c.contact ? 334 : 1000,
    'crossref-single': c.contact ? 100 : 200,
    arxiv: 3000,
    pubmed: c.ncbiKey ? 100 : 334,
    openalex: c.openalexKey ? 34 : 100,
    datacite: 100,
    openlibrary: 200,
    doi: 100,
    semanticscholar: 1000,
  };
}
const pacers = new Map<string, Pacer>();
export function pacer(name: string): Pacer {
  let p = pacers.get(name);
  if (!p) { p = new Pacer(pacerIntervals()[name] ?? 200); pacers.set(name, p); }
  return p;
}
export function resetPacers(): void { pacers.clear(); }

// ---- a small TTL cache with LRU eviction ----
export class TtlCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(private ttlMs: number, private max = 500) {}
  get(k: string): V | undefined {
    const hit = this.map.get(k);
    if (!hit) return undefined;
    if (hit.exp < clock.now()) { this.map.delete(k); return undefined; }
    this.map.delete(k); this.map.set(k, hit);
    return hit.v;
  }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, { v, exp: clock.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  clear(): void { this.map.clear(); }
}
/** identifier → BibTeX for a day; query → results for ten minutes. */
export const idCache = new TtlCache<string | null>(24 * 3600_000, 2000);
export const queryCache = new TtlCache<unknown>(10 * 60_000, 500);

// ---- the OpenAlex budget, read from its response headers ----
let oaBudget: { remaining: number; limit: number; until: number } | null = null;
export function noteOpenAlexBudget(res: Response): void {
  const remaining = Number(res.headers.get('x-ratelimit-remaining-usd'));
  const limit = Number(res.headers.get('x-ratelimit-limit-usd'));
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return;
  const d = new Date(clock.now());
  const until = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  oaBudget = { remaining, limit, until };
}
/** Under 10% of the day's allowance left (or a 429): free text goes to Crossref until 00:00 UTC. */
export function openAlexLow(): boolean {
  if (!oaBudget) return false;
  if (clock.now() >= oaBudget.until) { oaBudget = null; return false; }
  return oaBudget.remaining < oaBudget.limit * 0.1;
}
export function markOpenAlexSpent(): void {
  const d = new Date(clock.now());
  oaBudget = { remaining: 0, limit: 1, until: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) };
}
export function resetOpenAlexBudget(): void { oaBudget = null; }

export interface RefFetchOptions {
  /** Pacer name (see pacerIntervals). */
  pace: string;
  accept?: string;
  userAgent?: string;
  timeoutMs?: number;
  redirect?: RequestRedirect;
  source?: string;
  /** Extra headers (an operator's API key). */
  headers?: Record<string, string>;
}

/**
 * One paced request. A 429 with Retry-After of at most 5 s is waited out and
 * retried once; a longer one holds the host and throws (the caller reports
 * that source as busy).
 */
export async function refFetch(url: string | URL, o: RefFetchOptions): Promise<Response> {
  const p = pacer(o.pace);
  for (let attempt = 0; ; attempt++) {
    await p.wait();
    const res = await fetch(url, {
      headers: { 'User-Agent': o.userAgent ?? USER_AGENT, ...(o.accept ? { Accept: o.accept } : {}), ...(o.headers ?? {}) },
      redirect: o.redirect ?? 'follow',
      signal: AbortSignal.timeout(o.timeoutMs ?? 6000),
    });
    if (res.status !== 429) return res;
    await res.body?.cancel().catch(() => undefined);
    const ra = res.headers.get('retry-after');
    const secs = ra && /^\d+$/.test(ra.trim()) ? Number(ra) : ra ? Math.max(0, (Date.parse(ra) - clock.now()) / 1000) : 2;
    p.holdUntil(clock.now() + secs * 1000);
    if (attempt > 0 || secs > 5) throw new UpstreamError(`${o.source || 'The service'} is busy (HTTP 429)`, 429, o.source);
  }
}
