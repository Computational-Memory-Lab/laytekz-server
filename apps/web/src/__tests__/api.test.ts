import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, apiRequest, onSessionUser, sessionUser } from '../api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A gateway's answer: an HTML page, no JSON `error` to quote. */
function htmlResponse(status: number): Response {
  return new Response('<html><body>Bad Gateway</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('req() when the server cannot be reached', () => {
  it('turns a rejected fetch into an ApiError that names the remedy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    let caught: unknown;
    try {
      await api.listProjects();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).message).toBe('Could not reach the server. Check your connection and try again.');
    expect((caught as ApiError).status).toBe(0);
  });

  it('turns a 502, 503 or 504 without a JSON error into "The server is not responding."', async () => {
    for (const status of [502, 503, 504]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(status)));
      let caught: unknown;
      try {
        await api.listProjects();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).message).toBe('The server is not responding.');
      expect((caught as ApiError).status).toBe(status);
    }
  });

  it('keeps a JSON error from the server itself, even on a 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(502, { error: 'Upstream timed out' })));
    let caught: unknown;
    try {
      await api.listProjects();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).message).toBe('Upstream timed out');
    expect((caught as ApiError).status).toBe(502);
  });

  it('still returns the parsed body on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, [])));
    await expect(api.listProjects()).resolves.toEqual([]);
  });
});

describe('apiRequest', () => {
  it('is req(): JSON body, base path, ApiError', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetch);
    await expect(apiRequest('/api/x', { method: 'PATCH', body: '{}' })).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls[0][0]).toBe('/api/x');
    expect(fetch.mock.calls[0][1].headers).toEqual({ 'content-type': 'application/json' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(400, { error: 'Bad key', key: 'a.b' })));
    await expect(apiRequest('/api/x')).rejects.toMatchObject({ status: 400, message: 'Bad key', body: { key: 'a.b' } });
  });
});

describe('the session notifier', () => {
  const user = (id: string) => ({ id, email: null, name: id });

  it('follows who the auth routes say is signed in, telling listeners only of changes', async () => {
    const seen: (string | null)[] = [];
    const off = onSessionUser((id) => seen.push(id));
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { authEnabled: true, user: null })));
    await api.me();
    expect(sessionUser()).toBeNull();
    await api.me();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { user: user('u1') })));
    await api.login('a@example.org', 'pw');
    expect(sessionUser()).toBe('u1');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { authEnabled: true, user: user('u1') })));
    await api.me();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: true })));
    await api.logout();
    expect(sessionUser()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { user: user('u2'), awaitingApproval: true })));
    await api.register('b@example.org', 'pw');
    expect(sessionUser()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { user: user('u2') })));
    await api.register('b@example.org', 'pw');
    expect(sessionUser()).toBe('u2');
    // A request refused as signed out ends the session as far as the page knows.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'Sign in' })));
    await expect(api.listProjects()).rejects.toBeInstanceOf(ApiError);
    expect(sessionUser()).toBeNull();
    off();
    expect(seen).toEqual([null, 'u1', null, 'u2', null]);
  });
});
