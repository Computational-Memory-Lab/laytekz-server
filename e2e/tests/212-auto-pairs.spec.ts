import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP12 auto-pairs (feature 12): `$` pairs and types over its closer, a
 * completion's brace is stepped over (`\textbf{old}` gets no second `}`),
 * `$5 ` becomes `\$5 `, `\left(` gets `\right)` and Tab steps out of it; with
 * the switches off, input is stored exactly as typed.
 */
test.use({ settingsTestDefaults: null });

const DOC = ['\\documentclass{article}', '\\begin{document}', 'First line.', '\\end{document}', ''].join('\n');

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

test.describe('auto-pairs', () => {
  test('pairs $, steps over a completion brace, escapes a price, closes \\left( and Tab steps out', async ({ page, request }) => {
    const id = await seed(request, 'Auto Pairs');
    try {
      await openProject(page, id);
      await caretAfter(page, 'First line.');
      await page.keyboard.type(' $x$ and \\textb', { delay: 40 });
      await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
      await page.waitForTimeout(150);
      await page.keyboard.press('Tab');
      await page.keyboard.type('old} cost $5 then $\\left(y', { delay: 40 });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Tab');
      await page.keyboard.type('$.', { delay: 40 });
      await expect.poll(() => stored(request, id), { timeout: 20_000 })
        .toContain('First line. $x$ and \\textbf{old} cost \\$5 then $\\left(y\\right)$.\n');
    } finally {
      await cleanup(request, id);
    }
  });

  test('with the switches off, input is stored exactly as typed', async ({ page, request }) => {
    await page.addInitScript(() => {
      for (const id of ['pairs.brackets', 'pairs.math', 'pairs.quotes', 'pairs.tabOut', 'pairs.currency']) localStorage.setItem(`aldine.${id}`, 'false');
    });
    const id = await seed(request, 'Auto Pairs Off');
    try {
      await openProject(page, id);
      await caretAfter(page, 'First line.');
      await page.keyboard.type(' $x$ cost $5 ok', { delay: 40 });
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('First line. $x$ cost $5 ok\n');
    } finally {
      await cleanup(request, id);
    }
  });
});
