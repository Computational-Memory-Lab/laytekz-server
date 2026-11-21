import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { signalListeners } from '../branchSignal';
import { FILES_MOVED_SIGNAL } from '../../features/types';
import { PROJECT_SETTINGS_SIGNAL } from '../../settings/types';

afterEach(() => { vi.restoreAllMocks(); });

/** The signal map as the hook wires it: every change goes to the keyed listeners. */
function wired() {
  const doc = new Y.Doc();
  const map = doc.getMap<unknown>('signal');
  const keyed = signalListeners();
  map.observe((e) => keyed.deliver(e.keysChanged, (k) => map.get(k)));
  return { doc, map, keyed };
}

describe('branch signal keys (onSignal)', () => {
  it('delivers each value the server sets on a key to that key listeners only', () => {
    const { map, keyed } = wired();
    const settings = vi.fn();
    const moves = vi.fn();
    keyed.on(PROJECT_SETTINGS_SIGNAL, settings);
    keyed.on(FILES_MOVED_SIGNAL, moves);
    map.set(PROJECT_SETTINGS_SIGNAL, 7);
    map.set('v', 123);
    const moved = { moves: [['a.tex', 'b.tex']], by: 'Ada', at: 1 };
    map.set(FILES_MOVED_SIGNAL, moved);
    expect(settings).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledWith(7);
    expect(moves).toHaveBeenCalledOnce();
    expect(moves).toHaveBeenCalledWith(moved);
  });

  it('counts the same value set again as a new signal', () => {
    const { map, keyed } = wired();
    const fn = vi.fn();
    keyed.on(PROJECT_SETTINGS_SIGNAL, fn);
    map.set(PROJECT_SETTINGS_SIGNAL, 2);
    map.set(PROJECT_SETTINGS_SIGNAL, 2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('delivers keys changed in one transaction (a resync after a reconnect) once each', () => {
    const { doc, map, keyed } = wired();
    const seen: unknown[] = [];
    keyed.on(PROJECT_SETTINGS_SIGNAL, (v) => seen.push(['settings', v]));
    keyed.on(FILES_MOVED_SIGNAL, (v) => seen.push(['moves', v]));
    doc.transact(() => {
      map.set(PROJECT_SETTINGS_SIGNAL, 3);
      map.set(PROJECT_SETTINGS_SIGNAL, 4);
      map.set(FILES_MOVED_SIGNAL, { moves: [] });
    });
    expect(seen).toEqual([['settings', 4], ['moves', { moves: [] }]]);
  });

  it('applies an update from another doc (the server) like a local set', () => {
    const { doc, keyed } = wired();
    const fn = vi.fn();
    keyed.on(PROJECT_SETTINGS_SIGNAL, fn);
    const server = new Y.Doc();
    server.getMap('signal').set(PROJECT_SETTINGS_SIGNAL, 9);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
    expect(fn).toHaveBeenCalledWith(9);
  });

  it('stops after the removal, and a listener that throws does not stop the others', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { map, keyed } = wired();
    const off = keyed.on(PROJECT_SETTINGS_SIGNAL, () => { throw new Error('boom'); });
    const ok = vi.fn();
    keyed.on(PROJECT_SETTINGS_SIGNAL, ok);
    map.set(PROJECT_SETTINGS_SIGNAL, 1);
    expect(ok).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    off();
    map.set(PROJECT_SETTINGS_SIGNAL, 2);
    expect(ok).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
  });
});
