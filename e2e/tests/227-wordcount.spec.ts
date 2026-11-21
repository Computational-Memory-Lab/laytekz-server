import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP27 word count: main text only by default, the breakdown popover changes
 * the project's rule (and it persists), a section can be counted as Not
 * counted, the count shows in the Editor-only layout, and the marker command
 * is one undo step.
 */

const DOC = [
  '\\documentclass{article}',
  '\\title{A Title That Is Not Counted}',
  '\\begin{document}',
  '\\section{Introduction}',
  'Alpha beta gamma delta.',
  '\\begin{table}\\begin{tabular}{ll} one & two \\\\ \\end{tabular}\\caption{A caption here}\\end{table}',
  '\\section{Supplementary Materials}',
  'Extra words that should not count.',
  '\\end{document}',
  '',
].join('\n');

const put = (request: APIRequestContext, id: string, path: string, content: string) =>
  request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });

test.describe('word count (WP27)', () => {
  test('main text by default; the breakdown turns on Supplementary for the project and marks a section Not counted', async ({ page, request }) => {
    const id = await createProject(request, 'Word Count Rule');
    try {
      await put(request, id, 'main.tex', DOC);
      await openProject(page, id);
      const status = page.locator('.pane--preview').getByTestId('word-count');
      // "Introduction" + four words; no title, table, caption or supplement
      await expect(status).toHaveText('5 words', { timeout: 15_000 });

      await status.click();
      const pop = page.getByTestId('word-count-popover');
      await expect(pop).toBeVisible();
      await expect(pop.getByTestId('wc-rule')).toContainText('Main text');
      await pop.getByTestId('wc-part-supplementary').check();
      // + "Supplementary Materials" + six words
      await expect(status).toHaveText('13 words', { timeout: 15_000 });

      await page.reload();
      await expect(page.locator('.pane--preview').getByTestId('word-count')).toHaveText('13 words', { timeout: 15_000 });

      await page.locator('.pane--preview').getByTestId('word-count').click();
      const row = page.getByTestId('word-count-popover').locator('[data-testid^="wc-section-"]', { hasText: 'Introduction' }).first();
      await row.locator('select').selectOption('excluded');
      await expect(page.locator('.pane--preview').getByTestId('word-count')).toHaveText('8 words', { timeout: 15_000 });
    } finally {
      await cleanup(request, id);
    }
  });

  test('the count shows in the Editor-only layout, and a marker is one undo step', async ({ page, request }) => {
    const id = await createProject(request, 'Word Count Marker');
    try {
      await put(request, id, 'main.tex', DOC);
      await page.addInitScript(() => localStorage.setItem('aldine.layout', 'editor'));
      await openProject(page, id);
      const status = page.locator('.pane--editor').getByTestId('word-count');
      await expect(status).toHaveText('5 words', { timeout: 15_000 });

      // the caret on "Alpha beta…", then "Count as supplementary from here"
      await page.locator('.cm-line', { hasText: 'Alpha beta gamma delta.' }).click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
      await page.getByTestId('palette-input').fill('Count as supplementary from here');
      await page.getByTestId('palette-item-wordcount.markSupplementary').click();
      await expect(page.locator('.cm-content')).toContainText('%WC:supplementary');
      // only the heading is left in the main text
      await expect(status).toHaveText('1 word', { timeout: 15_000 });

      await page.locator('.cm-content').focus();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
      await expect(page.locator('.cm-content')).not.toContainText('%WC:supplementary');
      await expect(status).toHaveText('5 words', { timeout: 15_000 });
    } finally {
      await page.evaluate(() => localStorage.removeItem('aldine.layout')).catch(() => {});
      await cleanup(request, id);
    }
  });
});
