import fs from 'node:fs';
import { test, expect } from '../fixtures';

/**
 * WP23 settings-complete: search, reset with Undo, every keybinding with
 * None and Reset, export and import with a preview and Undo, and a phone
 * width without sideways scrolling. On /settings over the project list.
 */

const stored = (page: import('@playwright/test').Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

test.describe('the completed settings page', () => {
  test('search filters the rows and says how many match', async ({ page }) => {
    await page.goto('/settings/appearance');
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect(page.getByTestId('settings-search')).toBeFocused();
    await page.getByTestId('settings-search').fill('font');
    for (const id of ['editor.font', 'editor.fontSize', 'editor.ligatures']) await expect(page.getByTestId(`setting-${id}`)).toBeVisible();
    await expect(page.getByTestId('setting-editor.vim')).toHaveCount(0);
    await expect(page.getByTestId('settings-search-count')).toContainText('settings match');
    await page.getByTestId('settings-search').fill('zzqxv');
    await expect(page.getByTestId('settings-search-empty')).toHaveText('No settings match “zzqxv”');
    // Escape clears the search first, then closes the page
    await page.getByTestId('settings-search').press('Escape');
    await expect(page.getByTestId('settings-search')).toHaveValue('');
    await expect(page.getByTestId('setting-editor.vim')).toBeVisible();
    await page.getByTestId('settings-search').press('Escape');
    await expect(page.getByTestId('settings-page')).toHaveCount(0);
  });

  test('a row resets to its default and Undo puts it back', async ({ page }) => {
    await page.goto('/settings/editor-text');
    const field = page.getByTestId('setting-editor.fontSize-control-number');
    await field.fill('16');
    await field.press('Enter');
    await expect.poll(() => stored(page, 'aldine.editor.fontSize')).toBe('16');
    await page.getByTestId('setting-editor.fontSize-reset').click();
    await expect.poll(() => stored(page, 'aldine.editor.fontSize')).toBeNull();
    await expect(page.getByTestId('setting-editor.fontSize-reset')).toHaveCount(0);
    await page.getByTestId('settings-reset-undo').click();
    await expect.poll(() => stored(page, 'aldine.editor.fontSize')).toBe('16');
    await expect(field).toHaveValue('16');
  });

  test('a shortcut can be left without keys and reset', async ({ page }) => {
    await page.goto('/settings/shortcuts');
    await expect(page.getByTestId('shortcut-settings')).toBeVisible();
    await page.getByTestId('shortcut-none-jump').click();
    await expect(page.getByTestId('shortcut-jump')).toContainText('None');
    expect(JSON.parse((await stored(page, 'aldine.shortcuts')) ?? '{}')).toEqual({ jump: null });
    await page.getByTestId('shortcut-reset-jump').click();
    await expect(page.getByTestId('shortcut-jump')).not.toContainText('None');
    expect(await stored(page, 'aldine.shortcuts')).toBeNull();
  });

  test('export downloads the changed settings; import previews, applies and undoes in one step', async ({ page }) => {
    await page.goto('/settings/editor-behaviour');
    await page.getByTestId('settings-vim').check();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('settings-export').click()]);
    expect(download.suggestedFilename()).toBe('laytekz-settings.json');
    const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    expect(exported.format).toBe('laytekz-settings');
    expect(exported.settings['editor.vim']).toBe(true);

    const file = { format: 'laytekz-settings', version: 1, exportedAt: 'x', settings: { 'appearance.theme': 'dark', 'editor.vim': true, 'nope.unknown': 1 } };
    await page.getByTestId('settings-import-file').setInputFiles({ name: 'laytekz-settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    await expect(page.getByTestId('settings-import-preview')).toBeVisible();
    await expect(page.getByTestId('settings-import-count')).toContainText('1 setting will change');
    await expect(page.getByTestId('settings-import-change-appearance.theme')).toContainText('Dark');
    await page.getByTestId('settings-import-apply').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await stored(page, 'aldine.theme')).toBe('dark');
    await page.getByTestId('settings-import-undo').click();
    await expect.poll(() => stored(page, 'aldine.theme')).toBeNull();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('no sideways scrolling at 375 px, with the sections as chips', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await page.goto('/settings/appearance');
    await expect(page.getByTestId('settings-page')).toBeVisible();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth
      || (document.querySelector('[data-testid="settings-content"]') as HTMLElement).scrollWidth > (document.querySelector('[data-testid="settings-content"]') as HTMLElement).clientWidth);
    expect(wide).toBe(false);
    await page.getByTestId('settings-nav-pdf').click();
    await expect(page.getByTestId('settings-nav-pdf')).toHaveAttribute('aria-current', 'true');
  });
});
