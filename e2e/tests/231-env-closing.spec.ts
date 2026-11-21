import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP31 env-closing (feature 12): the `}` of \begin{itemize} adds one \end,
 * Enter on an existing \begin line adds none, renaming the \begin renames
 * the \end, one Undo takes back only the \end block; with the switch off,
 * nothing is added.
 */
test.use({ settingsTestDefaults: null });

const DOC = ['\\documentclass{article}', '\\begin{document}', 'First line.', '\\end{document}', ''].join('\n');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function seed(request: APIRequestContext, name: string): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
  return id;
}

const stored = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();

async function caretAfter(page: Page, text: string) {
  await page.locator('.cm-line').filter({ hasText: new RegExp(`^\\s*${text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`) }).first().click();
  await page.keyboard.press('End');
}

test.describe('closing environments', () => {
  test('closes once, renames the partner, and one Undo removes only the \\end block', async ({ page, request }) => {
    const id = await seed(request, 'Env Closing');
    try {
      await openProject(page, id);
      await caretAfter(page, 'First line.');
      await page.keyboard.press('Enter');
      await page.keyboard.type('\\begin{itemize}', { delay: 40 });
      await page.keyboard.type('\\item a', { delay: 20 });
      await expect.poll(() => stored(request, id), { timeout: 20_000 })
        .toContain('First line.\n\\begin{itemize}\n  \\item a\n\\end{itemize}\n\\end{document}');

      // Enter at the end of the existing \begin line adds no second \end
      await caretAfter(page, '\\begin{itemize}');
      await page.keyboard.press('Enter');
      await page.keyboard.type('\\item b', { delay: 20 });
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('\\item b');
      expect((await stored(request, id)).split('\\end{itemize}').length - 1).toBe(1);

      // renaming the \begin renames the \end
      await caretAfter(page, '\\begin{itemize}');
      await page.keyboard.press('ArrowLeft');
      for (let i = 0; i < 'itemize'.length; i++) await page.keyboard.press('Backspace');
      await page.keyboard.type('enumerate', { delay: 40 });
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toMatch(/\\begin\{enumerate\}[\s\S]*\\end\{enumerate\}\n\\end\{document\}/);
      await expect(page.getByTestId('env-partner')).toHaveText('enumerate');

      // one Undo takes back only the \end block
      await caretAfter(page, 'First line.');
      await page.keyboard.press('Enter');
      await page.keyboard.type('\\begin{center}', { delay: 40 });
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('\\end{center}');
      await page.keyboard.press(`${MOD}+z`);
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('First line.\n\\begin{center}\n\\begin{enumerate}');
      expect(await stored(request, id)).not.toContain('\\end{center}');
    } finally {
      await cleanup(request, id);
    }
  });

  test('with the switch off, no \\end is added', async ({ page, request }) => {
    await page.addInitScript(() => localStorage.setItem('aldine.envclose.close', 'false'));
    const id = await seed(request, 'Env Closing Off');
    try {
      await openProject(page, id);
      await caretAfter(page, 'First line.');
      await page.keyboard.press('Enter');
      await page.keyboard.type('\\begin{itemize} x', { delay: 40 });
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('First line.\n\\begin{itemize} x\n\\end{document}');
    } finally {
      await cleanup(request, id);
    }
  });
});
