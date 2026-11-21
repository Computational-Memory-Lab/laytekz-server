import { test, expect, TEST_DEFAULTS_KEY } from '../fixtures';
import { cleanup, createProject, openProject, openSettingsPage } from './helpers';

/**
 * WP07 settings-shell: the registry-driven settings page and the suite's
 * `automatic-off` default. The page needs the page host's routes (WP06) and
 * the settings store (WP02); the fixture tests need neither.
 */

test.describe('the suites default every automatic setting to off', () => {
  test('in the test\'s own page and in a context it creates', async ({ page, browser }) => {
    await page.goto('/');
    expect(await page.evaluate((k) => localStorage.getItem(k), TEST_DEFAULTS_KEY)).toBe('automatic-off');
    const ctx = await browser.newContext();
    try {
      const other = await ctx.newPage();
      await other.goto('/');
      expect(await other.evaluate((k) => localStorage.getItem(k), TEST_DEFAULTS_KEY)).toBe('automatic-off');
    } finally { await ctx.close(); }
  });

  test.describe('a spec of an automatic feature', () => {
    test.use({ settingsTestDefaults: null });
    test('opts out and gets the real defaults', async ({ page }) => {
      await page.goto('/');
      expect(await page.evaluate((k) => localStorage.getItem(k), TEST_DEFAULTS_KEY)).toBeNull();
    });
  });
});

test.describe('the settings page over the editor', () => {
  test('opens at /p/<id>/settings/editor-text without remounting the editor, and Back closes it without a prompt', async ({ page, request }) => {
    const id = await createProject(request, 'Settings Shell');
    try {
      await openProject(page, id);
      await expect(page.getByTestId('sync-status')).not.toContainText(/connecting/i);
      // the editor's DOM node and the sync status, watched across opening and closing
      await page.evaluate(() => {
        (document.querySelector('[data-testid="code-pane"]') as HTMLElement).dataset.wp07 = 'kept';
        const w = window as unknown as { wp07Status: string[] };
        w.wp07Status = [];
        const status = document.querySelector('[data-testid="sync-status"]');
        if (status) new MutationObserver(() => w.wp07Status.push(status.textContent || '')).observe(status, { subtree: true, characterData: true, childList: true });
      });
      await page.locator('.cm-content').click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type('ALPHA');
      let prompted = false;
      page.on('dialog', (d) => { prompted = true; void d.dismiss(); });

      await openSettingsPage(page, { section: 'editor-text' });
      await expect(page).toHaveURL(new RegExp(`/p/${id}/settings/editor-text$`));
      await expect(page.getByTestId('settings-section-editor-text')).toBeInViewport();
      await expect(page.getByTestId('settings-nav-editor-text')).toHaveAttribute('aria-current', 'true');
      await expect(page.getByTestId('project-settings')).toBeVisible();

      await page.goBack();
      await expect(page.getByTestId('settings-page')).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/p/${id}$`));
      expect(prompted, 'Back raised no unsaved-edits prompt').toBe(false);
      await expect(page.locator('[data-testid="code-pane"][data-wp07="kept"]')).toHaveCount(1);
      expect((await page.evaluate(() => (window as unknown as { wp07Status: string[] }).wp07Status)).some((t) => /connecting/i.test(t))).toBe(false);
      // the cursor stayed where it was: typing carries on after ALPHA
      await page.locator('.cm-content').focus();
      await page.keyboard.type('BETA');
      await expect(page.locator('.cm-content')).toContainText('ALPHABETA');
    } finally { await cleanup(request, id); }
  });

  test('a #<id> link highlights its row; the nav scrolls and keeps the address in step; Escape closes', async ({ page, request }) => {
    const id = await createProject(request, 'Settings Nav');
    try {
      await openProject(page, id);
      await openSettingsPage(page, { section: 'appearance', setting: 'appearance.theme' });
      const row = page.getByTestId('setting-appearance.theme');
      await expect(row).toHaveAttribute('data-target', 'true');
      await expect(row).toBeInViewport();
      await expect(page.getByTestId('settings-scope-note')).toHaveText(/in this browser|to your account/);

      await page.getByTestId('settings-nav-typesetting').click();
      await expect(page).toHaveURL(new RegExp(`/p/${id}/settings/typesetting$`));
      await expect(page.getByTestId('settings-section-typesetting')).toBeInViewport();
      await expect(page.getByTestId('settings-nav-typesetting')).toHaveAttribute('aria-current', 'true');
      await expect(row).not.toHaveAttribute('data-target', 'true');

      // the project's own rows, embedded with their V1 ids
      await page.getByTestId('settings-nav-project').click();
      await expect(page.getByTestId('settings-this-project')).toBeVisible();
      await expect(page.getByTestId('settings-name')).toHaveValue('Settings Nav');

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('settings-page')).toHaveCount(0);
      await expect(page.getByTestId('editor-shell')).toBeVisible();
    } finally { await cleanup(request, id); }
  });

  test('the V1 ids drive the moved preferences, and a change lands on the V1 key', async ({ page, request }) => {
    const id = await createProject(request, 'Settings Legacy');
    try {
      await openProject(page, id);
      await openSettingsPage(page, { section: 'editor-behaviour' });
      const vim = page.getByTestId('settings-vim');
      await expect(vim).not.toBeChecked();
      await vim.check();
      await expect.poll(() => page.evaluate(() => localStorage.getItem('aldine.vim'))).toBe('1');
      await expect(page.getByTestId('project-settings')).toContainText('Esc for normal mode');
      await vim.uncheck();
      await expect.poll(() => page.evaluate(() => localStorage.getItem('aldine.vim'))).not.toBe('1');

      await expect(page.getByTestId('settings-spellcheck')).toBeChecked();
      await page.getByTestId('settings-spellcheck').uncheck();
      await expect(page.getByTestId('settings-spell-lang')).toBeDisabled();
      await page.getByTestId('settings-spellcheck').check();
      await expect(page.getByTestId('settings-spell-lang')).toBeEnabled();

      await page.getByTestId('settings-theme').selectOption('light');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect.poll(() => page.evaluate(() => localStorage.getItem('aldine.theme'))).toBe('light');
      await page.getByTestId('settings-close').click();
      await expect(page.getByTestId('settings-page')).toHaveCount(0);
    } finally {
      await page.evaluate(() => { localStorage.removeItem('aldine.vim'); localStorage.removeItem('aldine.theme'); localStorage.removeItem('aldine.spellcheck'); }).catch(() => {});
      await cleanup(request, id);
    }
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
    test('fills the screen without scrolling sideways', async ({ page, request }) => {
      const id = await createProject(request, 'Settings Phone');
      try {
        await openProject(page, id);
        await openSettingsPage(page, { section: 'appearance' });
        const box = (await page.getByTestId('settings-page').boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(374);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await expect(page.getByTestId('settings-close')).toBeInViewport();
      } finally { await cleanup(request, id); }
    });
  });
});

test.describe('the settings page on its own', () => {
  test('/settings/<section> opens over the project list and closes to it', async ({ page }) => {
    await page.goto('/settings/appearance');
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect(page.getByTestId('settings-section-appearance')).toBeInViewport();
    await expect(page.getByTestId('project-settings')).toHaveCount(0);
    await expect(page.getByTestId('settings-this-project')).toHaveCount(0);
    // no accounts on this suite's server: this browser's name is offered
    await expect(page.getByTestId('settings-your-name')).toBeVisible();
    await page.getByTestId('settings-close').click();
    await expect(page.getByTestId('settings-page')).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  });
});
