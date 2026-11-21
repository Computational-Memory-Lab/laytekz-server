/**
 * F14 desk pet: the runtime's pure parts (WP44 pet-runtime; PET2), so they
 * are tested without a DOM: who is in the roster, which comments are news,
 * and the pet's single timer. The controller (controller.ts) feeds these.
 */
import type { Comment } from '../../api';

/** A person in the roster: name and colour, the way the presence list tells people apart. */
export const personKey = (p: { name: string; color: string }) => `${p.name}\u0000${p.color}`;

/** The branch roster as the brain wants it: you (in another tab) flagged. Agents are not in it (their session is the server's own state). */
export function rosterPeople(peers: readonly { name: string; color: string }[], self: { name: string; color: string }): { id: string; self?: boolean }[] {
  const me = personKey(self);
  const seen = new Set<string>();
  const out: { id: string; self?: boolean }[] = [];
  for (const p of peers) {
    const id = personKey(p);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id === me ? { id, self: true } : { id });
  }
  return out;
}

/** Who wrote something, as far as telling "me" from "someone else" goes. */
export interface Me { id: string | null; name: string }

const mine = (author: string, authorId: string | undefined, me: Me) => (authorId && me.id ? authorId === me.id : author === me.name);

/**
 * Comments and replies that arrived since `seen`, written by someone else.
 * The first call (seen null) only records what is there: comments already
 * on the page when it opens are not news.
 */
export function newFromOthers(seen: ReadonlySet<string> | null, comments: readonly Comment[], me: Me): { seen: Set<string>; fresh: number } {
  const next = new Set<string>();
  let fresh = 0;
  for (const c of comments) {
    const key = c.id;
    next.add(key);
    if (seen && !seen.has(key) && !mine(c.author, c.authorId, me)) fresh++;
    (c.replies ?? []).forEach((r, i) => {
      const rk = `${c.id}#${i}`;
      next.add(rk);
      if (seen && !seen.has(rk) && !mine(r.author, undefined, me)) fresh++;
    });
  }
  return { seen: next, fresh };
}

export interface TimerApi { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

/**
 * Named deadlines run by one timer: the pet's single setTimeout while it is
 * still (animation frames run only while it moves; no interval). Setting a
 * key again moves it; due callbacks run in time order.
 */
export class Deadlines {
  private readonly due = new Map<string, { at: number; fn: () => void }>();
  private handle: unknown = null;
  private armedAt = Number.POSITIVE_INFINITY;

  constructor(private readonly timer: TimerApi, private readonly now: () => number = Date.now) {}

  set(key: string, at: number | null, fn: () => void): void {
    if (at === null || !Number.isFinite(at)) this.due.delete(key);
    else this.due.set(key, { at, fn });
    this.arm();
  }

  clear(key: string): void {
    this.due.delete(key);
    this.arm();
  }

  has(key: string): boolean {
    return this.due.has(key);
  }

  stop(): void {
    this.due.clear();
    this.arm();
  }

  private arm(): void {
    let next = Number.POSITIVE_INFINITY;
    for (const d of this.due.values()) next = Math.min(next, d.at);
    if (next === this.armedAt && this.handle !== null) return;
    if (this.handle !== null) this.timer.clear(this.handle);
    this.handle = null;
    this.armedAt = next;
    if (!Number.isFinite(next)) return;
    this.handle = this.timer.set(() => this.fire(), Math.max(0, next - this.now()));
  }

  private fire(): void {
    this.handle = null;
    this.armedAt = Number.POSITIVE_INFINITY;
    const now = this.now();
    const ready = [...this.due.entries()].filter(([, d]) => d.at <= now).sort((a, b) => a[1].at - b[1].at);
    for (const [key] of ready) this.due.delete(key);
    for (const [, d] of ready) {
      try { d.fn(); } catch (err) { console.warn('[laytekz] desk pet timer failed', err); }
    }
    this.arm();
  }
}
