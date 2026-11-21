import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../components/Icons', () => ({ IconBookmark: () => null }));
vi.mock('../RenamedNotice', () => ({ default: () => null }));

import feature from '../index';
import { parseConnection, providerConfigured } from '../connection';
import { settings } from '../settings';
import { addRenames, dismissNotice, LIBRARIES_EVENT, linksFor, noticeFor, refreshLinks, setLinksForTest } from '../store';
import type { Capabilities, EditorPageCtx, PageEvents } from '../../types';

type Handler = (p: unknown) => void;
function fakePage(projectId = 'p1', branch = 'main', active: string | null = 'mendeley.bib') {
  const handlers = new Map<string, Set<Handler>>();
  const page = {
    projectId, branch,
    activeFile: () => active,
    refreshProject: vi.fn(async () => {}),
    events: {
      on: (e: keyof PageEvents, fn: Handler) => { (handlers.get(e) ?? handlers.set(e, new Set()).get(e)!).add(fn); return () => handlers.get(e)!.delete(fn); },
      emit: (e: keyof PageEvents, p: unknown) => { for (const fn of handlers.get(e) ?? []) fn(p); },
    },
  };
  return page as unknown as EditorPageCtx & { refreshProject: ReturnType<typeof vi.fn> };
}

const linksBody = [{ id: 'm1', provider: 'mendeley', linkedBy: 'u1', libraryName: 'My library', collectionName: 'Thesis', bibFile: 'mendeley.bib', recursive: true, lastSyncedAt: null }];
const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as Response;

// The unit tests run in Node: an EventTarget stands in for the window.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.unstubAllGlobals(); setLinksForTest('p1', null); setLinksForTest('p2', null); });

describe('the libraries feature', () => {
  it('pins the Mendeley plugin panel after Zotero', () => {
    expect(feature.pinnedPanels).toEqual([expect.objectContaining({ id: 'plugin:mendeley', title: 'Mendeley', order: 210 })]);
  });

  it('makes a linked .bib read-only with a banner, and only that file', async () => {
    const page = fakePage();
    const rule = feature.readOnlyRules![0];
    expect(rule.reason('mendeley.bib', page)).toBeNull();
    const fetchMock = vi.fn(async (_url: string) => ok(linksBody));
    vi.stubGlobal('fetch', fetchMock);
    const stop = feature.activate!(page) as () => void;
    await vi.waitFor(() => expect(page.refreshProject).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toContain('/api/projects/p1/libraries');
    expect(rule.reason('mendeley.bib', page)).toMatch(/^Synced from Mendeley \(My library › Thesis\)/);
    expect(rule.reason('main.tex', page)).toBeNull();
    stop();
  });

  it('re-reads the links when a plugin panel says they changed, and records renamed keys for its branch', async () => {
    const page = fakePage('p1', 'main', 'main.tex');
    vi.stubGlobal('fetch', vi.fn(async () => ok([])));
    const stop = feature.activate!(page) as () => void;
    await Promise.resolve();
    vi.stubGlobal('fetch', vi.fn(async () => ok(linksBody)));
    window.dispatchEvent(new CustomEvent(LIBRARIES_EVENT, { detail: { type: 'renamed', projectId: 'p1', branch: 'main', provider: 'mendeley', linkId: 'm1', renames: [{ from: 'a', to: 'b' }] } }));
    await vi.waitFor(() => expect(linksFor('p1')).toHaveLength(1));
    expect(noticeFor('p1', 'main')).toEqual({ provider: 'mendeley', linkId: 'm1', renames: [{ from: 'a', to: 'b' }] });
    expect(noticeFor('p1', 'other')).toBeNull();
    // The open file is not a linked .bib, so the page need not re-render for the rule.
    expect(page.refreshProject).not.toHaveBeenCalled();
    dismissNotice('p1', 'main');
    expect(noticeFor('p1', 'main')).toBeNull();
    stop();
  });

  it('ignores another project’s events and stops listening when the page closes', async () => {
    const page = fakePage('p2');
    const fetchMock = vi.fn(async () => ok([]));
    vi.stubGlobal('fetch', fetchMock);
    const stop = feature.activate!(page) as () => void;
    await Promise.resolve();
    const calls = fetchMock.mock.calls.length;
    window.dispatchEvent(new CustomEvent(LIBRARIES_EVENT, { detail: { type: 'changed', projectId: 'other' } }));
    stop();
    window.dispatchEvent(new CustomEvent(LIBRARIES_EVENT, { detail: { type: 'changed', projectId: 'p2' } }));
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});

describe('the links store', () => {
  it('keeps the last list on errors and stops asking a server without the route', async () => {
    setLinksForTest('p1', null);
    expect(await refreshLinks('p1', (async () => ok(linksBody)) as typeof fetch)).toBe(true);
    expect(await refreshLinks('p1', (async () => ok(linksBody)) as typeof fetch)).toBe(false);
    expect(await refreshLinks('p1', (async () => ok({ error: 'x' }, 500)) as typeof fetch)).toBe(false);
    expect(linksFor('p1')).toHaveLength(1);
    const f = vi.fn(async () => ok({}, 404));
    expect(await refreshLinks('p2', f as unknown as typeof fetch)).toBe(false);
    await refreshLinks('p2', f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('merges a later sync’s renames into the open notice', () => {
    addRenames('p1', 'main', 'zotero', 'zotero', [{ from: 'a', to: 'b' }]);
    addRenames('p1', 'main', 'zotero', 'zotero', { c: 'd', a: 'e' });
    expect(noticeFor('p1', 'main')?.renames).toEqual([{ from: 'a', to: 'e' }, { from: 'c', to: 'd' }]);
    addRenames('p1', 'main', 'zotero', 'zotero', []);
    dismissNotice('p1', 'main');
  });
});

describe('connections', () => {
  it('reads a connection, and a 404 as a server that cannot connect', () => {
    expect(parseConnection(200, { connected: true, name: 'Ana' })).toEqual({ kind: 'connected', name: 'Ana' });
    expect(parseConnection(200, { connected: true, username: 'ana' })).toEqual({ kind: 'connected', name: 'ana' });
    expect(parseConnection(200, { connected: false })).toEqual({ kind: 'disconnected' });
    expect(parseConnection(404, null)).toEqual({ kind: 'unsupported' });
    expect(parseConnection(500, {})).toEqual({ kind: 'error' });
  });
  it('reads the capability flat or nested', () => {
    const base: Capabilities = { rev: '', accounts: false, prefs: false, mcp: false, oauthRegistration: false };
    expect(providerConfigured({ ...base, 'libraries.mendeley': true }, 'mendeley')).toBe(true);
    expect(providerConfigured({ ...base, libraries: { mendeley: true } }, 'mendeley')).toBe(true);
    expect(providerConfigured(base, 'mendeley')).toBe(false);
  });
});

describe('settings', () => {
  it('registers the sync-on-open off switch as an automatic change, on by default', () => {
    const s = settings.find((d) => d.id === 'libraries.syncOnOpen')!;
    expect(s).toMatchObject({ automatic: true, default: true, control: { kind: 'switch' } });
    expect(s.validate(false)).toBe(true);
    expect(s.validate('yes')).toBe(false);
  });
});
