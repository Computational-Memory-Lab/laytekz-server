import { describe, expect, it, vi } from 'vitest';
import type { Comment } from '../../../api';
import { Deadlines, newFromOthers, personKey, rosterPeople } from '../runtime';
import { __setAwayStore, awayUntil, comeBack, goAway, sendPetAway, subscribeAway } from '../away';
import { settings } from '../settings';

describe('roster and comments', () => {
  it('tells you apart in another tab and drops duplicates', () => {
    const me = { name: 'Ada', color: '#123' };
    const people = rosterPeople([{ name: 'Ada', color: '#123' }, { name: 'Bo', color: '#456' }, { name: 'Bo', color: '#456' }], me);
    expect(people).toEqual([{ id: personKey(me), self: true }, { id: personKey({ name: 'Bo', color: '#456' }) }]);
  });

  it('counts only comments and replies by others that arrived after the first look', () => {
    const c = (id: string, author: string, replies: string[] = [], authorId?: string): Comment => ({
      id, branch: 'main', file: 'main.tex', anchor: { from: 0, to: 1, quote: 'x' }, author, ...(authorId ? { authorId } : {}),
      body: 'b', resolved: false, createdAt: '', replies: replies.map((a) => ({ author: a, body: 'r', createdAt: '' })),
    });
    const me = { id: 'u1', name: 'Ada' };
    const first = newFromOthers(null, [c('1', 'Bo')], me);
    expect(first.fresh).toBe(0);
    const mine = newFromOthers(first.seen, [c('1', 'Bo'), c('2', 'Ada', [], 'u1')], me);
    expect(mine.fresh).toBe(0);
    const theirs = newFromOthers(mine.seen, [c('1', 'Bo', ['Cy']), c('2', 'Ada', [], 'u1'), c('3', 'Ada2', [], 'u2')], me);
    expect(theirs.fresh).toBe(2);
    // Without accounts the name decides.
    expect(newFromOthers(new Set(), [c('4', 'Ada')], { id: null, name: 'Ada' }).fresh).toBe(0);
  });
});

describe('one timer', () => {
  it('runs due callbacks in time order and keeps a single timeout armed', () => {
    let now = 0;
    const pending: { fn: () => void; at: number; id: number }[] = [];
    let ids = 0;
    const timer = {
      set: vi.fn((fn: () => void, ms: number) => { const id = ++ids; pending.push({ fn, at: now + ms, id }); return id; }),
      clear: vi.fn((h: unknown) => { const i = pending.findIndex((p) => p.id === h); if (i >= 0) pending.splice(i, 1); }),
    };
    const d = new Deadlines(timer, () => now);
    const log: string[] = [];
    d.set('b', 200, () => log.push('b'));
    d.set('a', 100, () => log.push('a'));
    expect(pending).toHaveLength(1);
    expect(pending[0].at).toBe(100);
    d.set('c', 100, () => { log.push('c'); d.set('d', 300, () => log.push('d')); });
    now = 200;
    pending.shift()!.fn();
    expect(log).toEqual(['a', 'c', 'b']);
    expect(pending).toHaveLength(1);
    expect(d.has('d')).toBe(true);
    d.clear('d');
    expect(pending).toHaveLength(0);
    d.set('e', null, () => log.push('e'));
    expect(d.has('e')).toBe(false);
  });
});

describe('away for an hour', () => {
  it('is stored on this device, announced with a toast, and undone by Bring back', () => {
    const mem = new Map<string, string>();
    __setAwayStore({ get: (k) => mem.get(k) ?? null, set: (k, v) => { mem.set(k, v); return true; }, remove: (k) => { mem.delete(k); } });
    const heard = vi.fn();
    const off = subscribeAway(heard);
    const now = Date.now();
    expect(awayUntil(now)).toBeNull();
    const toast = vi.fn();
    const until = sendPetAway(toast, now);
    expect(until).toBe(now + 3_600_000);
    expect(awayUntil(now + 1000)).toBe(until);
    expect(toast.mock.calls[0][0]).toMatch(/^The desk pet is away until /);
    expect(toast.mock.calls[0][2].label).toBe('Bring back');
    toast.mock.calls[0][2].run();
    expect(awayUntil(now + 1000)).toBeNull();
    expect(heard).toHaveBeenCalledTimes(2);
    goAway(now);
    expect(awayUntil(now + 3_600_001)).toBeNull();
    comeBack();
    off();
  });
});

describe('settings', () => {
  it('keeps the engine definitions, off by default, with no generic palette toggle', () => {
    const on = settings.find((d) => d.id === 'pet.on')!;
    expect(on.default).toBe(false);
    expect(on.palette).toBe(false);
    expect(typeof on.hint === 'function' ? on.hint(false) : on.hint).toMatch(/Only you see it/);
    expect(settings.every((d) => d.section === 'pet' && typeof d.visible === 'function')).toBe(true);
    expect(settings.find((d) => d.id === 'pet.activity')!.default).toBe('calm');
    expect(settings.find((d) => d.id === 'pet.squeak')!.default).toBe(true);
    const env = { accounts: true, signedIn: true, desktop: false, phone: false, project: null };
    expect(on.visible!({ ...env, capabilities: { rev: '', accounts: true, prefs: true, mcp: false, oauthRegistration: false } })).toBe(false);
    expect(on.visible!({ ...env, capabilities: { rev: '', accounts: true, prefs: true, mcp: false, oauthRegistration: false, pet: { v: 'abcdefabcdef' } } })).toBe(true);
  });
});
