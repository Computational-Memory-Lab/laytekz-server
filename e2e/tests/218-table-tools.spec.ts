import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP18 table-tools (feature 4): the header button's grid picker inserts a
 * booktabs float with its package line as one undo step, Tab walks the new
 * cells, and ⇧⌥A aligns the table at the cursor (a second press says it is
 * already aligned).
 */

const DOC = [
  '\\documentclass{article}',
  '\\usepackage{amsmath}',
  '\\begin{document}',
  'First line.',
  '',
  'Last line.',
  '\\end{document}',
  '',
].join('\n');

async function seed(request: APIRequestContext, name: string, content = DOC): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content } });
  return id;
}

const stored = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();

async function caretOnLine(page: Page, n: number) {
  await page.locator('.cm-line').nth(n).click();
  await page.keyboard.press('End');
}

test.describe('table tools', () => {
  test('the grid picker inserts a 3 × 2 booktabs table in one undo step, and Tab walks its cells', async ({ page, request }) => {
    const id = await seed(request, 'Table Picker');
    try {
      await openProject(page, id);
      await caretOnLine(page, 4); // the blank line
      await page.getByTestId('tables-button').click();
      await expect(page.getByTestId('tables-picker')).toBeVisible();
      await page.getByTestId('tables-picker-cell-3-2').hover();
      await expect(page.getByTestId('tables-picker-size')).toHaveText('3 × 2');
      await page.getByTestId('tables-picker-cell-3-2').click();
      await expect(page.getByTestId('tables-picker')).toHaveCount(0);
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('\\usepackage{amsmath}\n\\usepackage{booktabs}\n\\begin{document}');
      expect(await stored(request, id)).toContain('    \\toprule\n     &  &  \\\\\n    \\midrule\n     &  &  \\\\\n    \\bottomrule');

      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toBe(DOC);

      await caretOnLine(page, 4);
      await page.getByTestId('tables-button').click();
      await page.getByTestId('tables-picker-cell-2-1').click();
      await page.keyboard.type('A');
      await page.keyboard.press('Tab');
      await page.keyboard.type('B');
      await page.keyboard.press('Tab');
      await page.keyboard.type('Results');
      await page.keyboard.press('Tab');
      await page.keyboard.type('res');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain([
        '\\begin{table}[htbp]',
        '  \\centering',
        '  \\caption{Results}',
        '  \\label{tab:res}',
        '  \\begin{tabular}{ll}',
        '    \\toprule',
        '    A & B \\\\',
        '    \\bottomrule',
        '  \\end{tabular}',
        '\\end{table}',
      ].join('\n'));
    } finally {
      await cleanup(request, id);
    }
  });

  test('in Visual mode the first cell opens for typing and the empty caption shows a placeholder', async ({ page, request }) => {
    const id = await seed(request, 'Table Visual');
    try {
      await page.addInitScript(() => window.localStorage.setItem('aldine.editorMode', 'visual'));
      await openProject(page, id);
      await caretOnLine(page, 4);
      await page.getByTestId('tables-button').click();
      await page.getByTestId('tables-picker-cell-2-2').click();
      await expect(page.getByTestId('vis-table-cell-input')).toBeFocused();
      await page.keyboard.type('Name');
      await page.keyboard.press('Enter');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toMatch(/\\toprule\n +Name &/);
      await expect(page.getByTestId('vis-caption-placeholder')).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });

  test('Shift+Alt+A aligns the table at the cursor, then says it is already aligned', async ({ page, request }) => {
    const table = '\\begin{tabular}{lr}\nModel & Params \\\\\nBaseline&12M\\\\\n\\end{tabular}\n';
    const id = await seed(request, 'Table Align', DOC.replace('First line.\n', `First line.\n${table}`));
    try {
      await openProject(page, id);
      await page.locator('.cm-line').filter({ hasText: /^Baseline/ }).first().click();
      await page.keyboard.press('Shift+Alt+KeyA');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('Model    & Params \\\\\nBaseline &    12M \\\\\n');
      await page.keyboard.press('Shift+Alt+KeyA');
      await expect(page.getByText('This table is already aligned')).toBeVisible();
    } finally {
      await cleanup(request, id);
    }
  });
});
