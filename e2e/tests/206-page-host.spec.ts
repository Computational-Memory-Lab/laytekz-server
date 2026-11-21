import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, openSidebarTab } from './helpers';

/**
 * WP06 page host: every slot renders the probe feature's item with the page
 * context, the probe's command obeys refusedFor and runs from its keybinding,
 * read-only rules and the rename interceptor reach the editor, the interim
 * word count and download button sit where V1 drew them, and the settings
 * page is a route over the editor that never remounts it.
 */

const DOC = '\\documentclass{article}\n\\begin{document}\nHello from the probe.\n\\end{document}\n';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
/** The settings page, or WP01's placeholder while WP07's is not there. */
const SETTINGS_VIEW = '[data-testid="settings-page"], [data-testid="settings-page-stub"]';
const SETTINGS_CLOSE = '[data-testid="settings-close"], [data-testid="settings-page-stub-close"]';

const put = (request: APIRequestContext, id: string, path: string, content: string) =>
  request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });

const probeOn = (page: Page) => page.addInitScript(() => localStorage.setItem('aldine.e2e.probe', '1'));
const probeCounts = (page: Page) => page.evaluate(() => (window as unknown as { __laytekzProbe?: { counts: Record<string, number> } }).__laytekzProbe?.counts ?? {});

const EDITOR_SLOTS = ['toolbar.main', 'editor.status', 'editor.tools', 'editor.banners', 'pdf.status', 'pdf.actions', 'pdf.overlay', 'files.footer', 'editor.overlay'];

test.describe('page host', () => {
  test('without the probe nothing of it shows, and the word count and download button are where V1 drew them', async ({ page, request }) => {
    const id = await createProject(request, 'Page Host Plain');
    try {
      await put(request, id, 'main.tex', DOC);
      await openProject(page, id);
      await expect(page.locator('[data-testid^="probe-slot-"]')).toHaveCount(0);
      await expect(page.getByTestId('word-count')).toHaveText(/^\d[\d,]* words$/);
      const header = () => page.evaluate(() => [...document.querySelector('[data-testid="preview"] > .pane__header')!.children].map((c) => c.getAttribute('data-testid') ?? c.className));
      // `.pdf-status + .pdf-words` (the separator dot) needs the count right after the status
      let order = await header();
      expect(order[order.indexOf('word-count') - 1]).toBe('pdf-status');
      expect(order[order.indexOf('zoom-controls') + 1]).toBe('pdf-download');
      expect(order[order.indexOf('pdf-download') + 1]).toBe('auto-toggle');
      await expect(page.locator('a[data-testid="pdf-download"]')).toHaveAttribute('href', /\.pdf/, { timeout: 120_000 });
      await expect(page.locator('a[data-testid="pdf-download"]')).toHaveAttribute('download', 'Page Host Plain.pdf');
      order = await header();
      expect(order[order.indexOf('zoom-controls') + 1]).toBe('pdf-download');
      await expect(page.locator('[data-perch="editor"]')).toHaveCount(1);
      await expect(page.locator('[data-perch="preview"]')).toHaveCount(1);
      await expect(page.locator('[data-perch="files"]')).toHaveCount(1);
    } finally { await cleanup(request, id); }
  });

  test('every probe item renders in its slot with the page, and the probe hears the page', async ({ page, request }) => {
    await probeOn(page);
    const id = await createProject(request, 'Page Host Probe');
    try {
      await put(request, id, 'main.tex', DOC);
      await openProject(page, id);
      for (const slot of EDITOR_SLOTS) {
        await expect(page.getByTestId(`probe-slot-${slot}`), slot).toHaveAttribute('data-page', `${id}::main`);
      }
      // after the word count, which stays next to the typeset status
      expect(await page.evaluate(() => document.querySelector('[data-testid="word-count"]')?.nextElementSibling?.getAttribute('data-testid'))).toBe('probe-slot-pdf.status');
      await expect(page.locator('html')).toHaveAttribute('data-probe-boot', '1');
      await expect(page.locator('html')).toHaveAttribute('data-probe-active', `${id}::main`);
      // a pinned panel on the sidebar's main row, and one in the More menu
      await page.getByTestId('tab-_probe.panel').click();
      await expect(page.getByTestId('probe-panel')).toHaveText('Probe panel for Page Host Probe');
      await openSidebarTab(page, '_probe.morePanel');
      await expect(page.getByTestId('probe-more-panel')).toBeVisible();
      await expect.poll(async () => {
        const c = await probeCounts(page);
        return ['event:activeFile', 'event:filesChanged', 'event:projectChanged', 'event:compileRequested', 'event:compileFinished'].every((k) => (c[k] ?? 0) > 0);
      }, { timeout: 120_000 }).toBe(true);
    } finally { await cleanup(request, id); }
  });

  test('the project list shows the probe in its toolbar slot', async ({ page }) => {
    await probeOn(page);
    await page.goto('/');
    // the feature modules load once the page is idle
    await expect(page.getByTestId('probe-slot-home.toolbar')).toHaveAttribute('data-page', '', { timeout: 20_000 });
    // home.accountMenu: a row of the account menu (here "More", with accounts off), drawn by the item's component
    await page.getByTestId('home-more').click();
    await expect(page.getByTestId('home-more-list').getByTestId('probe-slot-home.accountMenu')).toHaveAttribute('data-page', '');
    await page.keyboard.press('Escape');
  });

  test('the phone sheet draws the probe after its own rows, and adds no box without it', async ({ page, request }) => {
    const id = await createProject(request, 'Page Host Phone');
    try {
      await put(request, id, 'main.tex', DOC);
      await page.setViewportSize({ width: 390, height: 844 });
      await openProject(page, id);
      const sheet = page.getByTestId('toolbar-more-sheet');
      await page.getByTestId('toolbar-more').click({ timeout: 15_000 });
      await expect(sheet.getByTestId('more-settings')).toBeVisible();
      // the empty slot's wrapper generates no box, so the sheet's flex gaps are V1's
      expect(await sheet.locator('.action-sheet__slot').evaluate((el) => [getComputedStyle(el).display, el.childElementCount])).toEqual(['contents', 0]);
      const plain = await sheet.locator('.action-sheet').evaluate((el) => el.getBoundingClientRect().height);
      await sheet.getByTestId('toolbar-more-sheet-cancel').click();

      await probeOn(page);
      await page.reload();
      await page.getByTestId('toolbar-more').click({ timeout: 15_000 });
      const tag = sheet.getByTestId('probe-slot-phone.moreSheet');
      await expect(tag).toHaveAttribute('data-page', `${id}::main`);
      // after the sheet's rows, before Cancel
      expect(await tag.evaluate((el) => el.closest('.action-sheet__slot')?.nextElementSibling?.getAttribute('data-testid'))).toBe('toolbar-more-sheet-cancel');
      expect(await sheet.locator('.action-sheet').evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(plain);
    } finally { await cleanup(request, id); }
  });

  test('the probe command runs from the palette and from its keybinding, and a showcase has neither', async ({ page, request }) => {
    await probeOn(page);
    await page.addInitScript(() => localStorage.setItem('aldine.shortcuts', JSON.stringify({ '_probe.hello': { mod: true, shift: true, alt: false, key: '9', code: 'Digit9' } })));
    const id = await createProject(request, 'Page Host Command');
    try {
      await put(request, id, 'main.tex', DOC);
      await openProject(page, id);
      const ran = async () => (await probeCounts(page)).command ?? 0;
      await page.keyboard.press(`${MOD}+k`);
      await page.getByTestId('palette-input').fill('Probe: say hello');
      await page.keyboard.press('Enter');
      await expect(page.locator('.toast', { hasText: 'Probe says hello' }).first()).toBeVisible();
      expect(await ran()).toBe(1);
      await page.locator('.cm-content').click();
      await page.keyboard.press(`${MOD}+Shift+Digit9`);
      await expect.poll(ran).toBe(2);

      expect((await request.post(`/api/test/showcase/${id}`)).ok()).toBe(true);
      await page.reload();
      await expect(page.getByTestId('showcase-note')).toBeVisible();
      await page.keyboard.press(`${MOD}+k`);
      await page.getByTestId('palette-input').fill('Probe: say hello');
      await expect(page.getByText('Probe: say hello')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await page.locator('.cm-content').click();
      await page.keyboard.press(`${MOD}+Shift+Digit9`);
      await page.waitForTimeout(500);
      expect(await ran()).toBe(0);
      await expect(page.locator('.toast', { hasText: 'Probe says hello' })).toHaveCount(0);
    } finally { await cleanup(request, id); }
  });

  test('a read-only rule makes the file read-only with its reason, and an interceptor takes a rename over', async ({ page, request }) => {
    await probeOn(page);
    const id = await createProject(request, 'Page Host Rules');
    try {
      await put(request, id, 'main.tex', DOC);
      await put(request, id, 'probe-readonly.tex', 'Read only.\n');
      await page.goto(`/p/${id}?file=probe-readonly.tex`);
      await expect(page.getByTestId('active-file')).toHaveText('probe-readonly.tex');
      await expect(page.getByTestId('read-only-banner')).toHaveText('Probe: this file is read-only.');
      await expect(page.locator('.cm-content')).toHaveAttribute('aria-readonly', 'true');

      await page.getByTestId('file-main.tex').click();
      await expect(page.getByTestId('active-file')).toHaveText('main.tex');
      await expect(page.getByTestId('read-only-banner')).toHaveCount(0);
      await page.keyboard.press(`${MOD}+k`);
      await page.getByTestId('palette-input').fill('Rename main.tex');
      await page.keyboard.press('Enter');
      await page.getByTestId('dialog-input').fill('main.probe-intercept');
      await page.getByTestId('dialog-confirm').click();
      await expect(page.locator('.toast', { hasText: 'Probe intercepted renaming main.tex' })).toBeVisible();
      const { files } = await (await request.get(`/api/projects/${id}/files?branch=main`)).json() as { files: { path: string }[] };
      expect(files.map((f) => f.path)).toContain('main.tex');
      expect((await probeCounts(page))['intercept:fileRename:palette']).toBe(1);
    } finally { await cleanup(request, id); }
  });
});

test.describe('settings routes', () => {
  test('Settings opens the page over the editor, which stays mounted, and closing returns to it', async ({ page, request }) => {
    const id = await createProject(request, 'Page Host Settings');
    try {
      await put(request, id, 'main.tex', DOC);
      await openProject(page, id);
      await page.evaluate(() => { (document.querySelector('.cm-editor') as HTMLElement & { probeMark?: string }).probeMark = 'kept'; });
      await page.getByTestId('project-settings-open').click();
      await expect(page).toHaveURL(new RegExp(`/p/${id}/settings/project$`));
      await expect(page.locator(SETTINGS_VIEW).first()).toBeVisible();
      await expect(page.getByTestId('editor-shell')).toHaveAttribute('inert', '');
      await page.locator(SETTINGS_CLOSE).first().click();
      await expect(page).toHaveURL(new RegExp(`/p/${id}$`));
      await expect(page.locator(SETTINGS_VIEW)).toHaveCount(0);
      expect(await page.evaluate(() => (document.querySelector('.cm-editor') as HTMLElement & { probeMark?: string }).probeMark)).toBe('kept');

      // the event the app's entry points (and the desktop menu) dispatch, keeping the branch
      expect((await request.post(`/api/projects/${id}/branches`, { data: { name: 'draft' } })).ok()).toBe(true);
      await openProject(page, id, 'draft');
      const handled = await page.evaluate(() => !window.dispatchEvent(new CustomEvent('laytekz:open-settings', { cancelable: true, detail: { section: 'typing', setting: 'typing.explain' } })));
      expect(handled).toBe(true);
      await expect(page).toHaveURL(new RegExp(`/p/${id}/settings/typing\\?branch=draft#typing\\.explain$`));
      // Back is not leaving the page: no "unsaved edits" question
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/p/${id}\\?branch=draft$`));
      await expect(page.getByTestId('app-dialog')).toHaveCount(0);
      await expect(page.getByTestId('code-pane')).toBeVisible();
    } finally { await cleanup(request, id); }
  });

  test('/settings opens over the project list, and an editor subpath that does not exist is not a page', async ({ page, request }) => {
    const id = await createProject(request, 'Page Host Routes');
    try {
      await page.goto('/settings/account');
      await expect(page.locator(SETTINGS_VIEW).first()).toBeVisible();
      await expect(page.locator('.shelf-page')).toHaveAttribute('inert', '');
      await page.locator(SETTINGS_CLOSE).first().click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator('.shelf-page')).not.toHaveAttribute('inert', '');

      await page.goto(`/p/${id}/no-such-page`);
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    } finally { await cleanup(request, id); }
  });
});
