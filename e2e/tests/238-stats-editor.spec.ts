import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP38 statistics in the editor (feature 16): a trigger from the completion
 * list with a field formatted on Tab, the picker on ⇧⌘U with an empty
 * optional part removed, and the paste offer with Undo. The formatting rules
 * and the field engine are unit-tested in apps/web/src/features/stats.
 */
test.use({ settingsTestDefaults: null });

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const DOC = '\\documentclass{article}\n\\begin{document}\nSome text.\n\\end{document}\n';

const WELCH = [
  '\tWelch Two Sample t-test',
  '',
  'data:  extra by group',
  't = -1.8608, df = 17.776, p-value = 0.07939',
  'alternative hypothesis: true difference in means between group 1 and group 2 is not equal to 0',
  '95 percent confidence interval:',
  ' -3.3654832  0.2054832',
].join('\n');

async function seed(request: APIRequestContext, name: string): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
  return id;
}

const stored = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();

async function newLineAfterText(page: Page): Promise<void> {
  await page.locator('.cm-line').filter({ hasText: /^Some text\.$/ }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
}

test.describe('statistics in the editor', () => {
  test('\\pv, Enter, 0.0004, Tab stores $p < .001$', async ({ page, request }) => {
    const id = await seed(request, 'Stats Trigger');
    try {
      await openProject(page, id);
      await newLineAfterText(page);
      await page.keyboard.type('We found \\pv');
      await expect(page.locator('.cm-tooltip-autocomplete [aria-selected="true"]')).toContainText('\\pval');
      await page.waitForTimeout(150);
      await page.keyboard.press('Enter');
      await expect(page.locator('.cm-stats-ghost')).toBeVisible();
      await page.keyboard.type('0.0004');
      await page.keyboard.press('Tab');
      await page.keyboard.type('.');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('We found $p < .001$.\n');
    } finally {
      await cleanup(request, id);
    }
  });

  test('the picker inserts an ANOVA and drops the empty MSE part', async ({ page, request }) => {
    const id = await seed(request, 'Stats Picker');
    try {
      await openProject(page, id);
      await newLineAfterText(page);
      await page.keyboard.press(`${mod}+Shift+U`);
      await expect(page.getByTestId('stats-picker').getByTestId('palette-input')).toBeFocused();
      await page.keyboard.type('anova');
      await page.keyboard.press('Enter');
      await expect(page.locator('.cm-stats-ghost').first()).toBeVisible();
      for (const value of ['2', '45', '3.215', '', '0.0471', '0.125']) {
        if (value) await page.keyboard.type(value);
        await page.keyboard.press('Tab');
      }
      await expect.poll(() => stored(request, id), { timeout: 20_000 })
        .toContain('$F(2, 45) = 3.22$, $p = .047$, $\\eta^2_{\\mathrm{p}} = .13$\n');
    } finally {
      await cleanup(request, id);
    }
  });

  test('pasted R output: Convert rewrites it, and Undo brings back the paste', async ({ page, request }) => {
    const id = await seed(request, 'Stats Paste');
    try {
      await openProject(page, id);
      await newLineAfterText(page);
      await page.evaluate((text) => {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        document.querySelector('.cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, WELCH);
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('t = -1.8608, df = 17.776');
      await page.getByTestId('paste-stats-convert').click();
      await expect.poll(() => stored(request, id), { timeout: 20_000 })
        .toContain('$t(17.78) = -1.86$, $p = .079$, 95\\%~CI~$[-3.37, 0.21]$');
      await page.keyboard.press(`${mod}+z`);
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('t = -1.8608, df = 17.776, p-value = 0.07939');
    } finally {
      await cleanup(request, id);
    }
  });
});
