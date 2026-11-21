import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP20 link-follow (feature 18): ⌘/Ctrl-click on \url opens the unescaped
 * address through window.open, the hint shows while the modifier is held, a
 * javascript: \href opens nothing, a mod-click on plain text still adds a
 * cursor, \input opens the file, and a \ref key reveals its \label in another
 * file, and Shift+Alt+Enter on a \label seeds the Search panel with its references.
 */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const MAIN = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\url{https://example.org/a\\_b}',
  '\\href{javascript:alert(1)}{bad link}',
  'plain words here',
  '\\input{sec/intro}',
  '\\ref{sec:intro} is the intro.',
  '\\end{document}',
  '',
].join('\n');
const INTRO = ['\\section{Intro}\\label{sec:intro}', 'Intro text.', ''].join('\n');

async function seed(request: APIRequestContext, name: string): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'sec/intro.tex', content: INTRO } });
  return id;
}

const line = (page: Page, text: string) => page.locator('.cm-line').filter({ hasText: new RegExp(`^${text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`) });
const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

test.describe('link follow', () => {
  test('opens addresses, refuses scripts, keeps add-cursor, opens files and labels', async ({ page, request }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __opened: string[]; open: (u?: string | URL) => null };
      w.__opened = [];
      w.open = (u) => { w.__opened.push(String(u)); return null; };
    });
    const id = await seed(request, 'Link Follow');
    try {
      await openProject(page, id);
      const editor = page.getByTestId('code-pane').locator('.cm-editor');
      await expect(line(page, '\\url{')).toBeVisible();

      // The hint while the modifier is held, then the click opens the unescaped address.
      await page.keyboard.down(mod);
      await line(page, '\\url{').hover({ position: { x: 40, y: 6 } });
      await expect(editor.locator('.cm-modclick-target')).toBeVisible();
      await expect(page.getByTestId('modclick-hint')).toContainText('https://example.org/a_b');
      await line(page, '\\url{').click({ position: { x: 40, y: 6 }, modifiers: [mod] });
      await page.keyboard.up(mod);
      await expect.poll(() => opened(page)).toEqual(['https://example.org/a_b']);
      await expect(editor.locator('.cm-cursor-secondary')).toHaveCount(0);

      // javascript: opens nothing (and shows no hint).
      await line(page, '\\href{').click({ position: { x: 40, y: 6 }, modifiers: [mod] });
      await page.waitForTimeout(300);
      expect(await opened(page)).toEqual(['https://example.org/a_b']);

      // On plain text a mod-click adds a cursor, as before.
      await line(page, 'plain words').click({ position: { x: 10, y: 6 } });
      await line(page, 'plain words').click({ position: { x: 60, y: 6 }, modifiers: [mod] });
      await expect(editor.locator('.cm-cursor-secondary')).toHaveCount(1);

      // \input opens the file.
      await line(page, '\\input{').click({ position: { x: 60, y: 6 }, modifiers: [mod] });
      await expect(page.getByTestId('file-sec/intro.tex')).toHaveAttribute('aria-current', 'true');
      await expect(line(page, '\\section{Intro}')).toBeVisible();

      // A \ref key reveals its \label in the other file.
      await page.getByTestId('file-main.tex').click();
      await expect(line(page, '\\ref{sec:intro}')).toBeVisible();
      await line(page, '\\ref{sec:intro}').click({ position: { x: 12, y: 6 }, modifiers: [mod] });
      await expect(page.getByTestId('file-sec/intro.tex')).toHaveAttribute('aria-current', 'true');
      await expect(editor.locator('.cm-selectionBackground').first()).toBeVisible();

      // Shift+Alt+Enter on the label seeds the Search panel with its references, as a regex this time only.
      await page.keyboard.press('Shift+Alt+Enter');
      await expect(page.getByTestId('search-input')).toHaveValue('[{,]\\s*sec:intro\\s*[,}]');
      await expect(page.getByTestId('search-regex')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('search-summary')).toContainText('2 results in 2 files');
      expect(await page.evaluate(() => localStorage.getItem('aldine.search'))).toBeNull();
    } finally {
      await cleanup(request, id);
    }
  });
});
