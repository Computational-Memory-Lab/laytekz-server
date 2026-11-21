import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP03 server foundation, in the real server the suite starts (index.ts →
 * buildApp → registerFeatures): the capabilities route, account preferences
 * without accounts, project settings through the server probe feature
 * (active under ALDINE_TEST_HOOKS=1, which this suite sets), and an editor
 * that still opens on a project that has V2 settings.
 */
test.describe('server foundation', () => {
  test('capabilities name the server', async ({ request }) => {
    const res = await request.get('/api/capabilities');
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('no-store');
    const caps = await res.json();
    expect(caps).toMatchObject({ accounts: false, prefs: false, mcp: true, oauthRegistration: false, probe: true });
    expect(caps.rev).toMatch(/^[0-9a-f]{12}$/);
    expect((await request.get('/api/account/preferences')).status()).toBe(404);
  });

  test('project settings: visible, server-only and refused keys', async ({ page, request }) => {
    const id = await createProject(request, 'Server foundation');
    try {
      expect(await (await request.get(`/api/projects/${id}/settings`)).json()).toEqual({ values: {}, rev: 0 });
      const patched = await request.patch(`/api/projects/${id}/settings`, { data: { set: { '_probe.note': 'from the spec' } } });
      expect(patched.status()).toBe(200);
      expect(await patched.json()).toEqual({ values: { '_probe.note': 'from the spec' }, rev: 1 });

      const unknown = await request.patch(`/api/projects/${id}/settings`, { data: { set: { 'nobody.knows': 1 } } });
      expect(unknown.status()).toBe(400);
      expect((await unknown.json()).key).toBe('nobody.knows');

      const write = await request.post(`/api/projects/${id}/_probe/write`, { data: { set: { '_probe.serverOnly': 'stays on the server' } } });
      expect(write.status()).toBe(200);
      const detail = await (await request.get(`/api/projects/${id}`)).json();
      expect(detail.ext).toEqual({ '_probe.note': 'from the spec' });
      expect(JSON.stringify(detail)).not.toContain('stays on the server');
      expect(JSON.stringify(await (await request.get('/api/projects')).json())).not.toContain('stays on the server');

      // The editor opens as before on a project whose metadata carries ext.
      await openProject(page, id);
      await expect(page.getByTestId('sync-status')).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });
});
