import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP40 inline suggestions (feature 12): typing the start of a long word the
 * project already uses shows the rest in grey; a collaborator never sees it;
 * Tab stores the whole word; turned off, nothing shows and Tab indents.
 */
test.use({ settingsTestDefaults: null });

const DOC = ['\\documentclass{article}', '\\begin{document}', 'The measurement was careful. A second measurement agreed.', '', 'End.', '\\end{document}', ''].join('\n');

async function seed(request: APIRequestContext, name: string): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
  return id;
}

const stored = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();

async function caretAfter(page: Page, text: string) {
  await page.locator('.cm-line').filter({ hasText: new RegExp(`^${text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`) }).first().click();
  await page.keyboard.press('End');
}

test.describe('inline suggestions', () => {
  test('a project word shows in grey, only here, and Tab stores it', async ({ page, request, browser }) => {
    const id = await seed(request, 'Inline Suggest');
    const other = await browser.newContext();
    try {
      await openProject(page, id);
      const peer = await other.newPage();
      await openProject(peer, id);
      await caretAfter(page, 'End.');
      await page.keyboard.type(' The meas', { delay: 40 });
      await expect(page.getByTestId('ghost-text')).toHaveText('urement');
      // the collaborator sees the typed letters, never the suggestion
      await expect(peer.locator('.cm-content')).toContainText('End. The meas');
      await expect(peer.getByTestId('ghost-text')).toHaveCount(0);
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('ghost-text')).toHaveCount(0);
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('End. The measurement\n');
    } finally {
      await other.close();
      await cleanup(request, id);
    }
  });

  test('turned off, nothing shows', async ({ page, request }) => {
    await page.addInitScript(() => { localStorage.setItem('aldine.suggest.words', 'false'); });
    const id = await seed(request, 'Inline Suggest Off');
    try {
      await openProject(page, id);
      await caretAfter(page, 'End.');
      await page.keyboard.type(' The meas', { delay: 40 });
      await page.waitForTimeout(300);
      await expect(page.getByTestId('ghost-text')).toHaveCount(0);
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('End. The meas\n');
    } finally {
      await cleanup(request, id);
    }
  });
});
