import { afterEach, describe, expect, it, vi } from 'vitest';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function load() {
  vi.resetModules();
  const caps = await import('../capabilities');
  const api = await import('../../api');
  return { caps, api };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the capabilities client', () => {
  it('starts from the defaults and takes the server’s answer, core keys well-typed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { rev: 'abc', accounts: true, prefs: true, mcp: 'yes', pet: true })));
    const { caps } = await load();
    expect(caps.getCapabilities()).toEqual(caps.DEFAULT_CAPABILITIES);
    const seen = vi.fn();
    caps.subscribeCapabilities(seen);
    const c = await caps.loadCapabilities();
    expect(c).toEqual({ rev: 'abc', accounts: true, prefs: true, mcp: false, oauthRegistration: false, pet: true });
    expect(caps.getCapabilities()).toBe(c);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('asks once per tab', async () => {
    const fetch = vi.fn(async () => json(200, { accounts: false }));
    vi.stubGlobal('fetch', fetch);
    const { caps } = await load();
    await Promise.all([caps.loadCapabilities(), caps.loadCapabilities()]);
    await caps.loadCapabilities();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never rejects: an older server (404) or no answer leaves the defaults', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(404, { error: 'Not found' })));
    let { caps } = await load();
    expect(await caps.loadCapabilities()).toEqual(caps.DEFAULT_CAPABILITIES);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    ({ caps } = await load());
    expect(await caps.loadCapabilities()).toEqual(caps.DEFAULT_CAPABILITIES);
    expect(caps.normaliseCapabilities('nonsense')).toEqual(caps.DEFAULT_CAPABILITIES);
  });

  it('asks again after a sign-in or a sign-out, not after the first account answer', async () => {
    let signedIn = false;
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/auth/me') return json(200, { authEnabled: true, user: signedIn ? { id: 'u1', name: 'A', email: null } : null });
      if (url === '/api/auth/login') { signedIn = true; return json(200, { user: { id: 'u1', name: 'A', email: null } }); }
      if (url === '/api/auth/logout') { signedIn = false; return json(200, { ok: true }); }
      return json(200, { accounts: true, prefs: signedIn });
    });
    vi.stubGlobal('fetch', fetch);
    const { caps, api } = await load();
    await caps.loadCapabilities();
    await api.api.me();
    await Promise.resolve();
    expect(caps.getCapabilities().prefs).toBe(false);
    expect(fetch.mock.calls.filter(([u]) => u === '/api/capabilities')).toHaveLength(1);
    await api.api.login('a@example.org', 'pw');
    await vi.waitFor(() => expect(caps.getCapabilities().prefs).toBe(true));
    await api.api.logout();
    await vi.waitFor(() => expect(caps.getCapabilities().prefs).toBe(false));
    expect(fetch.mock.calls.filter(([u]) => u === '/api/capabilities')).toHaveLength(3);
  });
});
