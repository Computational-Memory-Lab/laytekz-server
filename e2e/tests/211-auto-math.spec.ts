import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP11 automatic math mode (feature 2): a math word becomes inline math when
 * it ends, a name gets `\_`, one Undo takes back only the automatic change,
 * and the switch turns it off. The rules themselves are unit-tested in
 * apps/web/src/features/automath/__tests__.
 */
test.use({ settingsTestDefaults: null });

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const DOC = '\\documentclass{article}\n\\begin{document}\nSome text.\n\\end{document}\n';

async function seed(request: APIRequestContext, name: string): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
  return id;
}

const stored = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();

async function typeAfterText(page: Page, text: string): Promise<void> {
  await page.locator('.cm-line').filter({ hasText: /^Some text\.$/ }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}

test.describe('automatic math mode', () => {
  test('wraps a math word, escapes a name, and one Undo takes back only the wrap', async ({ page, request }) => {
    const id = await seed(request, 'Auto Math On');
    try {
      await openProject(page, id);
      await typeAfterText(page, 'the my_var flag and p < .05, where x_i ');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('the my\\_var flag and $p < .05$, where $x_i$ \n');
      await page.keyboard.press(`${mod}+z`);
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('$p < .05$, where x_i \n');
    } finally {
      await cleanup(request, id);
    }
  });

  test('with the switch off, typing is stored exactly as typed', async ({ page, request }) => {
    const id = await seed(request, 'Auto Math Off');
    try {
      await page.addInitScript(() => {
        localStorage.setItem('aldine.automath.wrap', 'false');
        localStorage.setItem('aldine.automath.identifiers', 'false');
      });
      await openProject(page, id);
      await typeAfterText(page, 'the my_var flag where x_i is ');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('the my_var flag where x_i is \n');
    } finally {
      await cleanup(request, id);
    }
  });
});
