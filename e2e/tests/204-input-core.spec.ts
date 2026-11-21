import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { createProject, openProject, cleanup } from './helpers';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const MOD_E = /⌘E|Ctrl\+E/;
const DEFAULT_COMMENT = /⇧⌘C|Ctrl\+Shift\+C/;

/** Project settings, by the V1 test ids (WP07 keeps them). */
async function openSettings(page: Page) {
  await page.getByTestId('project-settings-open').click();
  await expect(page.getByTestId('shortcut-comment')).toBeVisible();
}

/** What the browser has stored for the keybindings ('aldine.shortcuts'). */
const stored = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('aldine.shortcuts') ?? '{}') as Record<string, unknown>);

/**
 * WP04: the V1 shortcut rows now run on the V2 keybinding registry. They must
 * behave as before, keep the stored chords of bindings this page does not
 * know (a later feature's, a cleared one), and refuse the chords the editor
 * and the browser keep.
 */
test.describe('keybinding registry', () => {
  test('changing a shortcut keeps other bindings\' stored chords and refuses an editor chord', async ({ page, request }) => {
    const id = await createProject(request, 'Input Core Keys');
    try {
      await page.addInitScript(() => {
        if (sessionStorage.getItem('e2e.seeded')) return;
        sessionStorage.setItem('e2e.seeded', '1');
        localStorage.setItem('aldine.shortcuts', JSON.stringify({
          'citations.insert': { mod: true, shift: true, alt: false, key: 'y', code: 'KeyY' },
          'links.follow': null,
        }));
      });
      await openProject(page, id);
      await openSettings(page);
      const recorder = page.getByTestId('shortcut-comment');
      await expect(recorder).toContainText(DEFAULT_COMMENT);
      await recorder.click();
      // CodeMirror's Select all matches: refused, and the row keeps recording
      await page.keyboard.press(`${mod}+Shift+L`);
      await expect(page.getByTestId('shortcut-hint-comment')).toContainText('Select all matches');
      await page.keyboard.press(`${mod}+e`);
      await expect(recorder).toContainText(MOD_E);

      let saved = await stored(page);
      expect(saved.comment).toMatchObject({ mod: true, shift: false, alt: false, key: 'e' });
      expect(saved['citations.insert']).toEqual({ mod: true, shift: true, alt: false, key: 'y', code: 'KeyY' });
      expect(saved['links.follow']).toBeNull();

      await page.getByTestId('shortcut-reset-comment').click();
      await expect(recorder).toContainText(DEFAULT_COMMENT);
      saved = await stored(page);
      expect(saved).not.toHaveProperty('comment');
      expect(saved['citations.insert']).toBeTruthy();
      expect(saved).toHaveProperty(['links.follow'], null);
    } finally {
      await cleanup(request, id);
    }
  });

  test('a shortcut changed in another tab applies here without a reload', async ({ page, context, request }) => {
    const id = await createProject(request, 'Input Core Tabs');
    try {
      await openProject(page, id);
      await expect(page.getByTestId('add-comment')).toContainText(DEFAULT_COMMENT);
      const other = await context.newPage();
      await openProject(other, id);
      await openSettings(other);
      await other.getByTestId('shortcut-comment').click();
      await other.keyboard.press(`${mod}+e`);
      await expect(other.getByTestId('shortcut-comment')).toContainText(MOD_E);
      await other.getByTestId('settings-close').click();
      await expect(page.getByTestId('add-comment')).toContainText(MOD_E);
      await other.close();
    } finally {
      await cleanup(request, id);
    }
  });
});
