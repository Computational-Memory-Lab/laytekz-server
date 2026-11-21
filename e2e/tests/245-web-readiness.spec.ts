import { test, expect } from '../fixtures';

/**
 * Web readiness (V2 WP45, feature 6): the app page's caching and headers,
 * the manifest and icons, JSON 404s for missing files, the unsupported-
 * browser notice, the "Laytekz was updated" toast, and /about.
 */

test('the app page, the manifest and the icons are served for the web', async ({ page, request }) => {
  const res = await page.goto('/');
  expect(res!.headers()['cache-control']).toBe('no-cache');
  expect(res!.headers()['x-robots-tag']).toBe('noindex, nofollow');
  expect(res!.headers()['content-security-policy-report-only']).toContain("'sha256-");
  const manifest = await page.locator('link[rel=manifest]').getAttribute('href');
  const m = await request.get(manifest!);
  expect(m.status()).toBe(200);
  expect((await m.json()).name).toBe('Laytekz');
  const ico = await request.get('/favicon.ico');
  expect(ico.status()).toBe(200);
  expect(ico.headers()['content-type']).toMatch(/^image\//);
  const missing = await request.get('/assets/gone-from-an-old-deploy.js');
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type']).toMatch(/^application\/json/);
  const asset = await page.locator('script[type=module][src*="/assets/"]').getAttribute('src');
  expect((await request.get(asset!)).headers()['cache-control']).toContain('immutable');
});

test('an old browser gets the notice, and Continue anyway opens the app', async ({ page }) => {
  await page.addInitScript(() => { delete (Promise as unknown as { withResolvers?: unknown }).withResolvers; });
  await page.goto('/');
  await expect(page.getByTestId('unsupported-browser')).toContainText('Laytekz needs a newer browser');
  await expect(page.locator('#root > *')).toHaveCount(0);
  await page.getByTestId('unsupported-continue').click();
  await expect(page.getByTestId('unsupported-browser')).toHaveCount(0);
  await expect(page.locator('#root > *').first()).toBeVisible();
});

test('a new version on the server shows the reload toast once', async ({ page }) => {
  await page.goto('/');
  const own = await page.locator('meta[name="laytekz-rev"]').getAttribute('content');
  expect(own).toMatch(/^[0-9a-f]{12}$/);
  await page.route('**/api/capabilities', async (route) => {
    const r = await route.fetch();
    await route.fulfill({ response: r, json: { ...(await r.json()), rev: 'feedfacecafe' } });
  });
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText('Laytekz was updated. Reload to get the new version.')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(500);
  await expect(page.getByText('Laytekz was updated. Reload to get the new version.')).toHaveCount(1);
});

test('/about is a public page', async ({ request }) => {
  const r = await request.get('/about');
  expect(r.status()).toBe(200);
  const body = await r.text();
  expect(body).toContain('About Laytekz');
  expect(body).not.toMatch(/<script/i);
});
