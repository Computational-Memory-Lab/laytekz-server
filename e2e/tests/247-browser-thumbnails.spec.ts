import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * Galley: page-1 thumbnails drawn by the editor. After a successful typeset
 * has stayed on screen a few seconds, the editor draws page 1 with pdf.js and
 * stores it (PUT /api/projects/:id/thumbnail); the Projects page then shows
 * that image instead of the drawn title page. Run with ALDINE_THUMBNAILS=0 on
 * the compiler to be sure the image is the browser's.
 */

const DOC = '\\documentclass{article}\n\\begin{document}\n\\begin{center}\\Huge A THUMBNAIL FROM THE BROWSER\\end{center}\nSome text on page one.\n\\newpage\nPage two.\n\\end{document}\n';

test('a typeset in the editor becomes the thumbnail on the Projects page', async ({ page, request }) => {
  const id = await createProject(request, 'Browser Thumbnail');
  try {
    expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } })).ok()).toBeTruthy();
    const stored = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes(`/api/projects/${id}/thumbnail`), { timeout: 60_000 });
    await openProject(page, id);
    await expect(page.getByTestId('pdf-status-log')).toContainText('Typeset in', { timeout: 60_000 });
    await expect(page.locator('canvas.pdf-page').first()).toBeVisible();
    const res = await stored;
    expect([200, 204]).toContain(res.status());
    expect(res.request().headers()['content-type']).toBe('image/jpeg');

    const row = ((await (await request.get('/api/projects')).json()) as Array<{ id: string; thumb?: { branch: string; w: number; h: number; v: string } | null }>).find((p) => p.id === id);
    expect(row?.thumb?.branch).toBe('main');
    expect(row?.thumb?.w).toBe(512);
    expect(row!.thumb!.h).toBeGreaterThan(512);

    const image = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().includes(`/api/projects/${id}/thumbnail?`));
    await page.goto('/');
    const card = page.getByTestId(`project-card-${id}`);
    await expect(card.locator('img.sheet__img')).toBeVisible();
    await expect(card.locator('.tpage')).toHaveCount(0);
    const got = await image;
    expect(got.status()).toBe(200);
    expect(got.headers()['content-type']).toBe('image/jpeg');
    await expect(card.locator('img.sheet__img')).toHaveClass(/is-shown/);
    expect(await card.locator('img.sheet__img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(512);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('projects-page.png') });
  } finally {
    await cleanup(request, id);
  }
});
