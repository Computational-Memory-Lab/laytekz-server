import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, openPluginTab, cleanup } from './helpers';

/**
 * WP22 references panel: search, preview, choose refs/extra.bib, Add cites
 * and appends, and the toast's Undo takes both back; pasted Scholar BibTeX
 * keeps its key; "Search online for …" in \cite completion opens the panel
 * with the typed text. The upstream services are the e2e mocks (mocks/refs.mjs).
 */

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  'As shown by .',
  '\\end{document}',
  '',
].join('\n');
const EXTRA = '@misc{other2001,\n  title = {Another Paper},\n  author = {Other, Ann},\n  year = {2001},\n}\n';

async function seed(request: APIRequestContext, name: string): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'refs/extra.bib', content: EXTRA } });
  return id;
}

const fileText = async (request: APIRequestContext, id: string, path: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=${encodeURIComponent(path)}`)).text();

/** Put the caret right before the full stop of "As shown by ." */
async function caretInSentence(page: Page): Promise<void> {
  await page.locator('.cm-line', { hasText: 'As shown by .' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
}

test.describe('References panel (WP22)', () => {
  test('search, preview, add to refs/extra.bib and cite; Undo removes both', async ({ page, request }) => {
    const id = await seed(request, 'References Panel');
    try {
      await openProject(page, id);
      await caretInSentence(page);
      await openPluginTab(page, 'references');
      const box = page.getByTestId('reference-search');
      await box.fill('searchable mock paper');
      await box.press('Enter');
      const hit = page.locator('[data-testid^="search-hit-"]', { hasText: 'A Searchable Mock Paper' }).first();
      await expect(hit).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('reference-scholar')).toHaveAttribute('href', /^https:\/\/scholar\.google\.com\//);
      await hit.click();

      const sheet = page.getByTestId('reference-preview');
      await expect(sheet).toBeVisible();
      const keyInput = page.getByTestId('reference-preview-key');
      await expect(keyInput).not.toHaveValue('', { timeout: 15_000 });
      const key = await keyInput.inputValue();
      await expect(page.getByTestId('reference-preview-bibtex')).toHaveValue(new RegExp(`@\\w+\\{${key},`));
      await page.getByTestId('reference-preview-target').selectOption('refs/extra.bib');
      await page.getByTestId('reference-preview-add').click();

      await expect(page.locator('.cm-content')).toContainText(`As shown by \\cite{${key}}.`, { timeout: 15_000 });
      await expect.poll(() => fileText(request, id, 'refs/extra.bib'), { timeout: 15_000 }).toContain(`{${key},`);
      expect(await fileText(request, id, 'refs/extra.bib')).toContain('@misc{other2001,');

      await page.getByTestId('toast-actions').getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator('.cm-content')).toContainText('As shown by .');
      await expect(page.locator('.cm-content')).not.toContainText(`\\cite{${key}}`);
      await expect.poll(() => fileText(request, id, 'refs/extra.bib'), { timeout: 15_000 }).not.toContain(`{${key},`);
      expect(await fileText(request, id, 'refs/extra.bib')).toBe(EXTRA);
    } finally {
      await cleanup(request, id);
    }
  });

  test('pasted Scholar BibTeX keeps its key', async ({ page, request }) => {
    const id = await seed(request, 'References Paste');
    try {
      await openProject(page, id);
      await openPluginTab(page, 'references');
      await page.getByTestId('reference-search').fill('@article{scholar2019keep,\n  title={A Pasted Paper},\n  author={Smith, Alice},\n  journal={Mock Letters},\n  year={2019}\n}');
      await expect(page.getByTestId('reference-preview')).toBeVisible();
      await expect(page.getByTestId('reference-preview-key')).toHaveValue('scholar2019keep', { timeout: 15_000 });
      await expect(page.getByTestId('reference-hits')).toBeHidden();
    } finally {
      await cleanup(request, id);
    }
  });

  test('"Search online for …" in \\cite completion opens the panel with the typed key', async ({ page, request }) => {
    const id = await seed(request, 'References Completion');
    try {
      await openProject(page, id);
      await caretInSentence(page);
      await page.keyboard.type('\\cite{searchable');
      const option = page.locator('.cm-tooltip-autocomplete li', { hasText: 'Search online for “searchable”' });
      await expect(option).toBeVisible({ timeout: 10_000 });
      await option.click();
      await expect(page.getByTestId('reference-search')).toHaveValue('searchable');
      await expect(page.locator('.cm-content')).not.toContainText('\\cite{searchable');
      await expect(page.locator('[data-testid^="search-hit-"]').first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await cleanup(request, id);
    }
  });
});
