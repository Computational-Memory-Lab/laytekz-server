import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, typeset, expectTypesetOk } from './helpers';

/**
 * WP21 math PDF crop: after a typeset, hovering a display equation shows the
 * typeset PDF's own pixels (data-tier="pdf"); lines added above it keep that;
 * an edit inside it falls back to KaTeX, captioned as changed since the last
 * typeset; the setting turns the PDF layer off.
 */

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Some text before the equation.',
  '\\begin{equation}',
  '  a^2 + b^2 = c^2',
  '\\end{equation}',
  'Plain words after it.',
  '\\end{document}',
  '',
].join('\n');

async function seed(request: APIRequestContext, name: string): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
  return id;
}

/** The middle of the first character of `needle` on the editor line starting with `lineStart`. */
async function spot(page: Page, lineStart: string, needle: string): Promise<{ x: number; y: number }> {
  const box = await page.evaluate(([ls, nd]) => {
    const line = [...document.querySelectorAll('[data-testid=code-pane] .cm-line')].find((l) => (l.textContent ?? '').startsWith(ls));
    if (!line) return null;
    let off = (line.textContent ?? '').indexOf(nd);
    if (off < 0) return null;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const len = n.textContent?.length ?? 0;
      if (off < len) {
        const r = document.createRange();
        r.setStart(n, off);
        r.setEnd(n, off + 1);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      off -= len;
    }
    return null;
  }, [lineStart, needle] as const);
  expect(box, `${needle} on the line ${lineStart}`).not.toBeNull();
  return box!;
}

async function hover(page: Page, lineStart: string, needle: string): Promise<void> {
  const p = await spot(page, lineStart, needle);
  await page.mouse.move(p.x - 3, p.y);
  await page.mouse.move(p.x, p.y);
}

async function leave(page: Page): Promise<void> {
  await hover(page, 'Plain words', 'words');
  await expect(page.getByTestId('math-preview')).toHaveCount(0);
}

test.describe('math PDF crop', () => {
  test('a display equation previews as typeset until it is edited', async ({ page, request }) => {
    // no typeset after edits: the test decides when the PDF is made
    await page.addInitScript(() => { try { localStorage.setItem('aldine.autoTypeset', '0'); } catch { /* ignore */ } });
    const id = await seed(request, 'Math PDF Crop');
    try {
      await openProject(page, id);
      await typeset(page);
      await expectTypesetOk(page);

      await hover(page, '  a^2', 'a^2');
      const preview = page.getByTestId('math-preview');
      await expect(preview).toBeVisible();
      await expect(preview).toHaveAttribute('data-tier', 'pdf', { timeout: 15_000 });
      await expect(preview).toContainText('As typeset');
      const size = await preview.locator('canvas').evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
      expect(size[0]).toBeGreaterThan(20);
      expect(size[1]).toBeGreaterThan(5);
      await leave(page);

      // lines added above the equation: still the typeset pixels
      const above = await spot(page, 'Some text before', 'before');
      await page.mouse.click(above.x, above.y);
      await page.keyboard.press('End');
      await page.keyboard.type('\nA new line above.\nAnd another one.');
      await hover(page, '  a^2', 'a^2');
      await expect(preview).toHaveAttribute('data-tier', 'pdf', { timeout: 15_000 });
      await leave(page);

      // an edit inside the equation: KaTeX, saying why
      const inside = await spot(page, '  a^2', 'c^2');
      await page.mouse.click(inside.x, inside.y);
      await page.keyboard.press('End');
      await page.keyboard.type(' + d');
      await leave(page);
      await hover(page, '  a^2', 'a^2');
      await expect(preview).toBeVisible();
      await expect(preview).toContainText('changed since the last typeset', { timeout: 15_000 });
      await expect(preview).toHaveAttribute('data-tier', 'katex');
      await leave(page);

      // typeset again: the PDF layer is back
      await typeset(page);
      await expect(page.getByTestId('pdf-status')).toContainText('Typeset in', { timeout: 120_000 });
      await expect.poll(async () => {
        await leave(page);
        await hover(page, '  a^2', 'a^2');
        await expect(preview).toBeVisible();
        await page.waitForTimeout(1500);
        return preview.getAttribute('data-tier');
      }, { timeout: 60_000 }).toBe('pdf');
    } finally {
      await cleanup(request, id);
    }
  });
});
