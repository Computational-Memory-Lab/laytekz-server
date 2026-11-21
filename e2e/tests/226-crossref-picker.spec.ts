import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP26 cross-reference picker (feature 17): ⇧⌘X / Ctrl+Shift+X lists the
 * project's labels with their captions; Enter writes Figure~\ref{…} without
 * cleveref and \Cref{…} in an apa7 document with cleveref. "Insert label
 * here" in a figure puts the label after the caption.
 */
const doc = (preamble: string, figure: string) => [
  preamble, '\\begin{document}', '\\section{Results}', '\\begin{figure}', '\\centering', figure, '\\end{figure}', 'As shown in', '\\end{document}', '',
].join('\n');

async function seed(request: APIRequestContext, name: string, content: string): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content } });
  return id;
}

const stored = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();

async function caretAfter(page: Page, text: string) {
  await page.locator('.cm-line').filter({ hasText: text }).first().click();
  await page.keyboard.press('End');
}

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const FIGURE = '\\caption{Mean reaction times}\n\\label{fig:rt}';

test.describe('cross-reference picker', () => {
  test('without cleveref: Figure~\\ref, and a typed "Figure " gets a tie', async ({ page, request }) => {
    const id = await seed(request, 'Ref Picker', doc('\\documentclass{article}', FIGURE));
    try {
      await openProject(page, id);
      await caretAfter(page, 'As shown in');
      await page.keyboard.press(`${MOD}+Shift+X`);
      await expect(page.getByTestId('ref-picker')).toBeVisible();
      await page.getByTestId('ref-picker-input').fill('mean');
      await expect(page.getByTestId('ref-picker-row-fig:rt')).toContainText('Mean reaction times');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('ref-picker')).toHaveCount(0);
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('As shown in Figure~\\ref{fig:rt}\n');

      await page.keyboard.type(' and Figure ');
      await page.keyboard.press(`${MOD}+Shift+X`);
      await page.getByTestId('ref-picker-input').fill('rt');
      await expect(page.getByTestId('ref-picker-row-fig:rt')).toBeVisible();
      await page.keyboard.press('Enter');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('\\ref{fig:rt} and Figure~\\ref{fig:rt}\n');
    } finally {
      await cleanup(request, id);
    }
  });

  test('apa7 with cleveref: \\Cref', async ({ page, request }) => {
    const id = await seed(request, 'Ref Picker APA', doc('\\documentclass[man]{apa7}\n\\usepackage{cleveref}', FIGURE));
    try {
      await openProject(page, id);
      await caretAfter(page, 'As shown in');
      await page.keyboard.press(`${MOD}+Shift+X`);
      await expect(page.getByTestId('ref-picker-note')).toContainText('cleveref');
      await expect(page.getByTestId('ref-picker-row-fig:rt')).toBeVisible();
      await page.keyboard.press('Enter');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('As shown in \\Cref{fig:rt}\n');
    } finally {
      await cleanup(request, id);
    }
  });

  test('Insert label here in a figure lands after the caption', async ({ page, request }) => {
    const id = await seed(request, 'Label Here', doc('\\documentclass{article}', '\\caption{Mean reaction times}'));
    try {
      await openProject(page, id);
      await caretAfter(page, '\\centering');
      await page.keyboard.press(`${MOD}+k`);
      await page.getByTestId('palette-input').fill('Insert label here');
      await page.getByTestId('palette-item-crossrefs.label').click();
      await expect.poll(() => stored(request, id), { timeout: 20_000 })
        .toContain('\\centering\n\\caption{Mean reaction times}\\label{fig:mean-reaction-times}\n\\end{figure}');
    } finally {
      await cleanup(request, id);
    }
  });
});
