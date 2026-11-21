import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { cleanup, createProject, openProject } from './helpers';

/**
 * Settings core (V2, WP02): the store's device layer, the pre-paint script
 * and the appearance CSS, in a real browser. Every tab follows a change made
 * in another at once; the interface size, contrast and motion are on <html>
 * before the app runs, even with storage blocked; the V1 keys are read and
 * never rewritten; and the editor's typography follows its variables.
 */

const root = (page: Page) => page.evaluate(() => {
  const r = document.documentElement;
  return { theme: r.dataset.theme, contrast: r.dataset.contrast, motion: r.dataset.motion, pdfDark: r.dataset.pdfDark, fontSize: r.style.fontSize };
});
const token = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test.describe('settings core', () => {
  test('a change in one tab shows in every other tab at once', async ({ context }) => {
    const a = await context.newPage();
    const b = await context.newPage();
    await a.goto('/');
    await b.goto('/');
    await expect(b.getByTestId('home-more')).toBeVisible();
    const plainHairline = await token(b, '--hairline');

    await a.evaluate(() => {
      localStorage.setItem('aldine.theme', 'light');
      localStorage.setItem('aldine.appearance.contrast', '"more"');
      localStorage.setItem('aldine.appearance.motion', '"reduce"');
      localStorage.setItem('aldine.appearance.scale', '125');
      localStorage.setItem('aldine.pdf.dark', '"invert"');
    });
    await expect.poll(() => root(b)).toEqual({ theme: 'light', contrast: 'more', motion: 'reduce', pdfDark: 'invert', fontSize: '125%' });
    // the contrast mirror in theme.css takes effect, as the media query would
    await expect.poll(() => token(b, '--hairline')).not.toBe(plainHairline);

    await a.evaluate(() => {
      localStorage.removeItem('aldine.appearance.contrast');
      localStorage.removeItem('aldine.appearance.motion');
      localStorage.removeItem('aldine.appearance.scale');
      localStorage.setItem('aldine.theme', 'dark');
    });
    await expect.poll(() => root(b)).toEqual({ theme: 'dark', contrast: undefined, motion: undefined, pdfDark: 'invert', fontSize: '' });
    // The writing tab hears no storage event of its own: a fresh tab shows what b should.
    const c = await context.newPage();
    await c.goto('/');
    await expect(c.getByTestId('home-more')).toBeVisible();
    expect(await root(c)).toEqual(await root(b));
    expect(await token(b, '--hairline')).toBe(await token(c, '--hairline'));
  });

  test('the pre-paint applies the appearance before the app runs', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('aldine.theme', 'light');
      localStorage.setItem('aldine.appearance.scale', '110');
      localStorage.setItem('aldine.appearance.contrast', '"more"');
      localStorage.setItem('aldine.appearance.motion', '"reduce"');
      // what the pre-paint stamped, before any module script ran
      document.addEventListener('readystatechange', () => {
        if (document.readyState !== 'interactive') return;
        const r = document.documentElement;
        (window as unknown as { prepainted: unknown }).prepainted = { theme: r.dataset.theme, contrast: r.dataset.contrast, motion: r.dataset.motion, fontSize: r.style.fontSize };
      });
    });
    await page.goto('/');
    await expect(page.getByTestId('home-more')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { prepainted: unknown }).prepainted)).toEqual({ theme: 'light', contrast: 'more', motion: 'reduce', fontSize: '110%' });
    expect(await root(page)).toMatchObject({ theme: 'light', contrast: 'more', motion: 'reduce', fontSize: '110%' });
  });

  test('the app loads and follows the system when site data is blocked', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await expect(page.getByTestId('home-more')).toBeVisible();
    expect(await root(page)).toMatchObject({ theme: 'light', contrast: undefined, fontSize: '' });
    expect(errors).toEqual([]);
  });

  test('reads the V1 keys and never rewrites them', async ({ page, request }) => {
    const seeded: Record<string, string> = {
      'aldine.theme': 'sepia',
      'aldine.vim': 'junk',
      'aldine.autoTypeset': 'junk',
      'aldine.draftTypeset': '0',
      'aldine.spellcheck': '0',
      'aldine.changeMarks': 'yes',
      'aldine.pdfZoom': '9',
      'aldine.shortcuts': '{not json',
    };
    await page.addInitScript((values) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
    }, seeded);
    const id = await createProject(request, 'Settings core keys');
    try {
      await page.goto('/');
      await expect(page.getByTestId('home-more')).toBeVisible();
      await openProject(page, id);
      await page.reload();
      await expect(page.getByTestId('code-pane')).toHaveAttribute('data-loaded', 'true');
      const now = await page.evaluate((keys) => Object.fromEntries(keys.map((k) => [k, localStorage.getItem(k)])), Object.keys(seeded));
      expect(now).toEqual(seeded);
    } finally {
      await cleanup(request, id);
    }
  });

  test('the editor’s typography follows a change made in another tab, and goes back exactly', async ({ page, request, context }) => {
    const id = await createProject(request, 'Settings core typography');
    try {
      await openProject(page, id);
      const scroller = page.locator('.code-pane .cm-scroller');
      const style = () => scroller.evaluate((el) => {
        const s = getComputedStyle(el);
        return { size: getComputedStyle(el.closest('.cm-editor')!).fontSize, lineHeight: s.lineHeight, family: s.fontFamily, ligatures: s.fontVariantLigatures };
      });
      const before = await style();
      expect(before.size).toBe('13.5px');

      const other = await context.newPage();
      await other.goto('/');
      await other.evaluate(() => {
        localStorage.setItem('aldine.editor.fontSize', '16');
        localStorage.setItem('aldine.editor.lineHeight', '1.8');
        localStorage.setItem('aldine.editor.font', '"Courier New"');
      });
      await expect.poll(style).toMatchObject({ size: '16px', lineHeight: '28.8px', ligatures: 'none' });
      expect((await style()).family).toContain('Courier New');

      await other.evaluate(() => localStorage.setItem('aldine.editor.ligatures', 'true'));
      await expect.poll(async () => (await style()).ligatures).toBe('normal');

      await other.evaluate(() => {
        for (const k of ['aldine.editor.fontSize', 'aldine.editor.lineHeight', 'aldine.editor.font', 'aldine.editor.ligatures']) localStorage.removeItem(k);
      });
      await expect.poll(style).toEqual(before);
    } finally {
      await cleanup(request, id);
    }
  });
});
