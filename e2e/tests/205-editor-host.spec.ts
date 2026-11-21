import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, expectTypesetOk, cleanup } from './helpers';

/**
 * WP05 editor-host: the V1 editor is what the editor settings' defaults
 * give; a setting changes the open editor in place; and the probe feature
 * (WP06, localStorage 'aldine.e2e.probe' = '1') reaches every editor
 * extension point, in Source and in Visual mode, and the PDF app menu.
 * The probe's triggers are in apps/web/src/features/_probe/editor.ts.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Some text for the probe sentence.',
  '%probe-chain',
  '\\probelink',
  '%probe-menu',
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

const line = (page: Page, text: string) => page.locator('.cm-line').filter({ hasText: new RegExp(`^${text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`) });

const probeCount = (page: Page, what: string) =>
  page.evaluate((w) => (window as unknown as { __laytekzProbe?: { counts: Record<string, number> } }).__laytekzProbe?.counts[w] ?? 0, what);

const withProbe = (page: Page) => page.addInitScript(() => localStorage.setItem('aldine.e2e.probe', '1'));

test.describe('editor host', () => {
  test('the editor settings\' defaults give the V1 editor, and Tab still indents', async ({ page, request }) => {
    const id = await seed(request, 'Editor Host Defaults');
    try {
      await openProject(page, id);
      const editor = page.getByTestId('code-pane').locator('.cm-editor');
      await expect(editor.locator('.cm-lineNumbers')).toBeVisible();
      await expect(editor.locator('.cm-foldGutter')).toHaveCount(1);
      await expect(editor.locator('.cm-content')).toHaveClass(/cm-lineWrapping/);
      await line(page, 'Some text').click();
      await expect(editor.locator('.cm-activeLine')).toHaveCount(1);
      await page.keyboard.press('Home');
      await page.keyboard.press('Tab');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('\n  Some text for the probe sentence.');
    } finally {
      await cleanup(request, id);
    }
  });

  test('an editor setting changes the open editor in place, without a remount', async ({ page, context, request }) => {
    const id = await seed(request, 'Editor Host Settings');
    try {
      await page.addInitScript(() => {
        if (sessionStorage.getItem('e2e.seeded')) return;
        sessionStorage.setItem('e2e.seeded', '1');
        localStorage.setItem('aldine.editor.lineNumbers', 'false');
      });
      await openProject(page, id);
      const editor = page.getByTestId('code-pane').locator('.cm-editor');
      await expect(editor.locator('.cm-content')).toBeVisible();
      await expect(editor.locator('.cm-lineNumbers')).toHaveCount(0);
      await line(page, 'Some text').click();
      await editor.evaluate((el) => { el.setAttribute('data-e2e-mounted', '1'); });

      // Another tab changes two settings: this one follows through the storage event.
      const other = await context.newPage();
      await other.goto('/');
      await other.evaluate(() => {
        localStorage.setItem('aldine.editor.lineNumbers', 'true');
        localStorage.setItem('aldine.editor.wrap', 'false');
      });
      await expect(editor.locator('.cm-lineNumbers')).toBeVisible();
      await expect(editor.locator('.cm-content')).not.toHaveClass(/cm-lineWrapping/);
      await expect(page.locator('.cm-editor[data-e2e-mounted="1"]')).toHaveCount(1);
      await expect(page.getByTestId('sync-status')).not.toHaveText(/connecting/i);

      // Visual mode always wraps.
      await page.getByTestId('mode-visual').click();
      await expect(editor.locator('.cm-content')).toHaveClass(/cm-lineWrapping/);
      await page.getByTestId('mode-source').click();
      await expect(editor.locator('.cm-content')).not.toHaveClass(/cm-lineWrapping/);
      await other.close();
    } finally {
      await cleanup(request, id);
    }
  });

  for (const mode of ['source', 'visual'] as const) {
    test(`the probe's extension, key chain, mod-click, menu entry and completion run in ${mode} mode`, async ({ page, request }) => {
      const id = await seed(request, `Editor Host Probe ${mode}`);
      try {
        await withProbe(page);
        await openProject(page, id);
        if (mode === 'visual') await page.getByTestId('mode-visual').click();
        await expect(page.getByTestId(`mode-${mode}`)).toHaveAttribute('aria-pressed', 'true');
        const editor = page.getByTestId('code-pane').locator('.cm-editor');

        // extension
        await expect(editor).toHaveAttribute('data-probe', 'on');

        // key chain: Mod-ArrowRight on %probe-chain
        await line(page, '%probe-chain').click();
        await page.keyboard.press(`${mod}+ArrowRight`);
        await expect.poll(() => probeCount(page, 'keyChain')).toBe(1);
        await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('%probe-chain ok\n');

        // mod-click on \probelink follows it and adds no cursor
        await line(page, '\\probelink').click({ position: { x: 12, y: 6 }, modifiers: [mod] });
        await expect.poll(() => probeCount(page, 'modClick')).toBe(1);
        await expect(editor.locator('.cm-cursor-secondary')).toHaveCount(0);

        // menu entry: the probe claims a right-click on %probe-menu
        await line(page, '%probe-menu').click({ button: 'right' });
        const menu = page.getByTestId('editor-context-menu');
        await expect(menu).toBeVisible();
        await menu.getByTestId('probe-menu-item').click();
        await expect.poll(() => probeCount(page, 'menu')).toBe(1);

        // completion source: \probec offers \probecompletion
        await line(page, '%probe-menu').click();
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.keyboard.type('\\probec');
        await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('\\probecompletion');
        await page.keyboard.press('Escape');
        await expect(editor).toHaveAttribute('data-probe', 'on');
      } finally {
        await cleanup(request, id);
      }
    });
  }

  for (const mode of ['source', 'visual'] as const) {
    test(`the probe's automatic edit runs in ${mode} mode, and one Undo takes back only it`, async ({ page, request }) => {
      const id = await seed(request, `Editor Host Auto Edit ${mode}`);
      try {
        await withProbe(page);
        await openProject(page, id);
        await page.getByTestId(`mode-${mode}`).click();
        await line(page, '%probe-menu').click();
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.keyboard.type('%probe->');
        await expect.poll(() => stored(request, id), { timeout: 20_000 }).toMatch(/^\s*%probe→$/m);
        await page.keyboard.press(`${mod}+z`);
        await expect.poll(() => stored(request, id), { timeout: 20_000 }).toMatch(/^\s*%probe->$/m);
        expect(await stored(request, id)).not.toContain('→');
      } finally {
        await cleanup(request, id);
      }
    });
  }

  test('the PDF app menu opens on a right-click inside a selection a feature has an entry for, and reports the selection', async ({ page, context, request }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // \probelink is not a command TeX knows: this document typesets.
    const id = await seed(request, 'Editor Host PDF', '\\documentclass{article}\n\\begin{document}\nSome text for the probe sentence.\n\\end{document}\n');
    try {
      await withProbe(page);
      await openProject(page, id);
      await expectTypesetOk(page);
      const sentence = 'Some text for the probe sentence.';
      const box = await page.waitForFunction((needle) => {
        const layer = document.querySelector('canvas[data-page="1"]')?.parentElement?.querySelector('.pdf-text');
        if (!layer) return null;
        const nodes: Text[] = [];
        const walk = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        for (let t = walk.nextNode(); t; t = walk.nextNode()) nodes.push(t as Text);
        const all = nodes.map((t) => t.data).join('');
        const at = all.indexOf(needle);
        if (at < 0) return null;
        const rect = (i: number) => {
          let k = 0;
          for (const t of nodes) {
            if (i < k + t.data.length) {
              const r = document.createRange();
              r.setStart(t, i - k);
              r.setEnd(t, i - k + 1);
              const b = r.getBoundingClientRect();
              return { x: b.left, y: b.top, w: b.width, h: b.height };
            }
            k += t.data.length;
          }
          return null;
        };
        return { first: rect(at), last: rect(at + needle.length - 1) };
      }, sentence, { timeout: 60_000 }).then((h) => h.jsonValue());
      const { first, last } = box as { first: { x: number; y: number; w: number; h: number }; last: { x: number; y: number; w: number; h: number } };

      // No selection: a right-click keeps the native menu.
      await page.mouse.click(first.x + 2, first.y + first.h / 2, { button: 'right' });
      await expect(page.getByTestId('pdf-context-menu')).toHaveCount(0);

      await page.mouse.move(first.x + 1, first.y + first.h / 2);
      await page.mouse.down();
      await page.mouse.move(last.x + last.w - 1, last.y + last.h / 2, { steps: 12 });
      await page.mouse.up();
      await expect.poll(() => probeCount(page, 'event:pdfSelection')).toBeGreaterThan(0);

      const inside = { x: first.x + 20, y: first.y + first.h / 2 };
      await page.mouse.click(inside.x, inside.y, { button: 'right' });
      const menu = page.getByTestId('pdf-context-menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByTestId('pdf-context-copy')).toBeVisible();
      await menu.getByTestId('probe-pdf-item').click();
      await expect.poll(() => probeCount(page, 'pdfMenu')).toBe(1);
      await expect(menu).toHaveCount(0);

      // Shift keeps the native menu (and may move the selection's end, so it comes after).
      await page.keyboard.down('Shift');
      await page.mouse.click(inside.x, inside.y, { button: 'right' });
      await page.keyboard.up('Shift');
      await expect(page.getByTestId('pdf-context-menu')).toHaveCount(0);

      // Outside the selection: the native menu.
      await page.mouse.click(inside.x, first.y + first.h * 6, { button: 'right' });
      await expect(page.getByTestId('pdf-context-menu')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });
});
