import { test, expect } from '../fixtures';

/**
 * WP39 pet engine, in the real server the suite starts: the config points
 * ALDINE_INSTANCE_PET at e2e/fixtures/operator/pet-test.png (a grey test
 * shape, never artwork). This suite has no accounts, so every caller may see
 * the pet; the signed-out 401 is covered by apps/server/test/pet-asset.test.mjs.
 */
test.describe('desk pet engine', () => {
  test('the capability announces the image and the route serves it privately', async ({ request }) => {
    const caps = await (await request.get('/api/capabilities')).json();
    expect(caps.pet).toMatchObject({ w: 96, h: 90, s: null });
    expect(caps.pet.v).toMatch(/^[0-9a-f]{12}$/);

    const img = await request.get(`/api/instance/pet?v=${caps.pet.v}`);
    expect(img.status()).toBe(200);
    expect(img.headers()['content-type']).toBe('image/png');
    expect(img.headers()['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(img.headers()['cross-origin-resource-policy']).toBe('same-origin');
    expect((await img.body()).subarray(1, 4).toString('latin1')).toBe('PNG');

    expect((await request.get('/api/instance/pet/silhouette')).status()).toBe(404);
  });
});
