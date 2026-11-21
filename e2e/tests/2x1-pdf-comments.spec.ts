import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, expectTypesetOk, cleanup } from './helpers';

/**
 * WPX1 pdf-comments (feature 19): text selected in the PDF preview gets a
 * Comment button; choosing it finds the words in the source through SyncTeX
 * and opens the page's comment composer on them, and the comment is an
 * ordinary one (Review panel, marked range in the source, comments API).
 */

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  'The \\emph{quick} brown fox jumps over the lazy dog.',
  '',
  'Another paragraph that stays where it is.',
  '\\end{document}',
  '',
].join('\n');

/** Drags across `needle` in the first page's text layer. */
async function selectInPdf(page: Page, needle: string): Promise<void> {
  const box = await page.waitForFunction((n) => {
    const layer = document.querySelector('canvas[data-page="1"]')?.parentElement?.querySelector('.pdf-text');
    if (!layer) return null;
    const nodes: Text[] = [];
    const walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) nodes.push(t as Text);
    const all = nodes.map((t) => t.data).join('');
    const at = all.indexOf(n);
    if (at < 0) return null;
    const rect = (i: number) => {
      let k = 0;
      for (const t of nodes) {
        if (i < k + t.data.length) {
          const r = document.createRange();
          r.setStart(t, i - k);
          r.setEnd(t, i - k + 1);
          const b = r.getBoundingClientRect();
          return { x: b.left, y: b.top, w: b.width, h: b.height };
        }
        k += t.data.length;
      }
      return null;
    };
    return { first: rect(at), last: rect(at + n.length - 1) };
  }, needle, { timeout: 60_000 }).then((h) => h.jsonValue());
  const { first, last } = box as { first: { x: number; y: number; w: number; h: number }; last: { x: number; y: number; w: number; h: number } };
  await page.mouse.move(first.x + 1, first.y + first.h / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.w - 1, last.y + last.h / 2, { steps: 12 });
  await page.mouse.up();
}

test.describe('comments on the PDF', () => {
  test('a comment on text selected in the PDF lands on the matching source and shows in Review', async ({ page, request }) => {
    const id = await createProject(request, 'PDF Comments');
    await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
    try {
      await openProject(page, id);
      await expectTypesetOk(page);
      await selectInPdf(page, 'brown fox jumps over');

      const button = page.getByTestId('pdf-comment-button');
      await expect(button).toBeVisible();
      await button.click();

      const composer = page.getByTestId('comment-composer');
      await expect(composer).toBeVisible({ timeout: 20_000 });
      await expect(composer.locator('.composer__quote')).toHaveText('brown fox jumps over');
      await page.getByTestId('comment-body').fill('Is the fox quick enough?');
      await page.getByTestId('comment-submit').click();

      await expect(page.getByTestId('review-panel')).toContainText('Is the fox quick enough?');
      await expect(page.locator('.cm-comment-range').first()).toContainText('brown fox');
      const list = await (await request.get(`/api/projects/${id}/comments?branch=main`)).json() as { file: string; anchor: { from: number; to: number; quote: string } }[];
      expect(list).toHaveLength(1);
      expect(list[0].file).toBe('main.tex');
      expect(list[0].anchor.quote).toBe('brown fox jumps over');
      expect(DOC.slice(list[0].anchor.from, list[0].anchor.to)).toBe('brown fox jumps over');
      // the source is unchanged
      expect(await (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text()).toBe(DOC);
    } finally {
      await cleanup(request, id);
    }
  });

  test('the comment shortcut comments on the PDF selection, not on the editor\'s', async ({ page, request }) => {
    const id = await createProject(request, 'PDF Comments Keys');
    await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
    try {
      await openProject(page, id);
      await expectTypesetOk(page);
      // An old selection in the editor that the shortcut must not use.
      await page.locator('.cm-line').filter({ hasText: /^Another paragraph/ }).click();
      await page.keyboard.press('Shift+End');
      await selectInPdf(page, 'brown fox jumps over');
      await expect(page.getByTestId('pdf-comment-button')).toBeVisible();
      await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+C`);
      const composer = page.getByTestId('comment-composer');
      await expect(composer).toBeVisible({ timeout: 20_000 });
      await expect(composer.locator('.composer__quote')).toHaveText('brown fox jumps over');
    } finally {
      await cleanup(request, id);
    }
  });

  test('the switch turns the button off', async ({ page, request }) => {
    const id = await createProject(request, 'PDF Comments Off');
    await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
    try {
      await page.addInitScript(() => localStorage.setItem('aldine.pdfComments.enabled', 'false'));
      await openProject(page, id);
      await expectTypesetOk(page);
      await selectInPdf(page, 'brown fox jumps over');
      await page.waitForTimeout(500);
      await expect(page.getByTestId('pdf-comment-button')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });
});
