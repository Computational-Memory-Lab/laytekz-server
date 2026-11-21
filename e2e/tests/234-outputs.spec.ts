import fs from 'node:fs';
import { test, expect } from '../fixtures';
import { cleanup, createPaperProject, expectTypesetOk, openProject, typeset } from './helpers';

/**
 * WP34 outputs-web (F11, F10's download names): the generated-files list,
 * the confirmed Add, and the Download menu's arXiv ZIP. The list reads the
 * real server (WP30's route, or the probe beside the PDF without it); Add and
 * the arXiv export are answered by page.route here, so the web side is proved
 * whether or not WP30's routes are in this tree.
 */
test.describe('generated files and downloads', () => {
  test('the list shows main.bbl after a typeset; Add asks first; downloads are named after the project', async ({ page, request }) => {
    test.setTimeout(240_000);
    const id = await createPaperProject(request, 'Outputs Smoke');
    try {
      // automatic settings are off in the suites; this spec turns its own on
      await page.addInitScript(() => localStorage.setItem('aldine.outputs.generatedList', 'true'));
      await openProject(page, id);
      await expectTypesetOk(page);

      const row = (name: string) => page.locator(`[data-testid="generated-file"][data-name="${name}"]`);
      await page.getByTestId('generated-files-toggle').click();
      await expect(row('main.bbl')).toBeVisible({ timeout: 20_000 });
      await expect(row('main.log')).toBeVisible();
      await expect(row('main.bbl').getByTestId('generated-file-download')).toHaveAttribute('download', 'main.bbl');

      await row('main.log').getByTestId('generated-file-view').click();
      await expect(page.getByTestId('generated-file-text')).toContainText('This is');
      await page.getByTestId('generated-file-viewer-close').click();
      await expect(page.getByTestId('generated-file-viewer')).toHaveCount(0);

      // Add, through the confirmation
      let kept: unknown = null;
      const now = Date.now();
      await page.route(/\/output\/list\?/, (route) => route.fulfill({ json: { dir: '.aldine-out', files: [
        { name: 'main.bbl', size: 912, mtime: now, fromLastRun: true, tracked: null },
        { name: 'main.log', size: 40_000, mtime: now, fromLastRun: true },
      ] } }));
      await page.route(/\/output\/keep$/, async (route) => { kept = route.request().postDataJSON(); await route.fulfill({ json: { ok: true, path: 'main.bbl' } }); });
      await typeset(page);
      await expect(row('main.bbl').getByTestId('generated-file-add')).toBeVisible({ timeout: 120_000 });
      await row('main.bbl').getByTestId('generated-file-add').click();
      await expect(page.getByTestId('dialog-title')).toHaveText('Add main.bbl to the project?');
      await page.getByTestId('dialog-cancel').click();
      expect(kept).toBeNull();
      await row('main.bbl').getByTestId('generated-file-add').click();
      await page.getByTestId('dialog-confirm').click();
      await expect.poll(() => kept).toEqual({ branch: 'main', name: 'main.bbl' });

      // the Download menu: the PDF and the arXiv ZIP, both named after the project
      const pdf = page.waitForEvent('download');
      await page.getByTestId('pdf-download-menu').click();
      await page.getByTestId('download-menu-pdf').click();
      expect((await pdf).suggestedFilename()).toBe('Outputs Smoke.pdf');

      await page.route(/\/export\/arxiv\?/, (route) => route.fulfill({
        status: 200,
        contentType: 'application/zip',
        headers: { 'x-laytekz-warnings': encodeURIComponent(JSON.stringify(['main.tex is typeset with LuaLaTeX, which arXiv does not offer.'])) },
        body: Buffer.from('504b0506000000000000000000000000000000000000', 'hex'),
      }));
      await page.getByTestId('pdf-download-menu').click();
      await page.getByTestId('download-menu-arxiv').click();
      await expect(page.getByTestId('dialog-title')).toHaveText('Download for arXiv anyway?', { timeout: 120_000 });
      const zip = page.waitForEvent('download');
      await page.getByTestId('dialog-confirm').click();
      expect((await zip).suggestedFilename()).toBe('Outputs Smoke (arXiv).zip');
    } finally { await cleanup(request, id); }
  });

  test('against the server’s own routes, Add puts main.bbl in the tree and the arXiv ZIP carries it', async ({ page, request }) => {
    test.setTimeout(240_000);
    const caps = await (await request.get('/api/capabilities')).json().catch(() => ({}));
    test.skip(!caps?.outputs?.keep, 'this server has no output routes (WP30)');
    const id = await createPaperProject(request, 'Outputs Real');
    try {
      await page.addInitScript(() => localStorage.setItem('aldine.outputs.generatedList', 'true'));
      await openProject(page, id);
      await expectTypesetOk(page);
      const row = (name: string) => page.locator(`[data-testid="generated-file"][data-name="${name}"]`);
      await page.getByTestId('generated-files-toggle').click();
      await expect(row('main.bbl').getByTestId('generated-file-meta')).toContainText('this typeset', { timeout: 20_000 });
      await row('main.bbl').getByTestId('generated-file-add').click();
      await expect(page.getByTestId('dialog-title')).toHaveText('Add main.bbl to the project?');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.getByTestId('file-main.bbl')).toBeVisible({ timeout: 20_000 });
      await expect(row('main.bbl').getByTestId('generated-file-tracked')).toBeVisible();

      const zip = page.waitForEvent('download');
      await page.getByTestId('generated-files-arxiv').click();
      const file = await zip;
      expect(file.suggestedFilename()).toBe('Outputs Real (arXiv).zip');
      const bytes = fs.readFileSync((await file.path())!).toString('latin1');
      expect(bytes).toContain('main.tex');
      expect(bytes).toContain('main.bbl');
      expect(bytes).not.toContain('.gitignore');
    } finally { await cleanup(request, id); }
  });

  test('the list has an off switch', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Outputs Off');
    try {
      await page.addInitScript(() => localStorage.setItem('aldine.outputs.generatedList', 'false'));
      await openProject(page, id);
      await expect(page.getByTestId('pdf-download-menu')).toBeVisible();
      await expect(page.getByTestId('generated-files')).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });
});
