import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP13 math hover: hovering math in the source shows it drawn by KaTeX with
 * the preamble's macros; a broken formula says why in words; the setting
 * turns it off; the command pins a status preview that Escape closes; the
 * file's bytes never change.
 */

const DOC = [
  '\\documentclass{article}',
  '\\newcommand{\\R}{\\mathbb{R}}',
  '\\begin{document}',
  'Let $x \\in \\R$ be real.',
  'Broken $\\frac{a}{b$ here.',
  'Plain words only.',
  '\\end{document}',
  '',
].join('\n');

async function seed(request: APIRequestContext, name: string): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
  return id;
}

const stored = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();

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

test.describe('math hover', () => {
  test('hovering shows the formula drawn with the preamble\'s macros, errors in words, and the setting turns it off', async ({ page, request }) => {
    const id = await seed(request, 'Math Hover Preview');
    try {
      await openProject(page, id);
      await expect(page.locator('[data-testid=code-pane] .cm-line', { hasText: 'Let $x' })).toBeVisible();

      await hover(page, 'Let $x', '\\R');
      const preview = page.getByTestId('math-preview');
      await expect(preview).toBeVisible();
      await expect(preview).toHaveAttribute('data-tier', 'katex');
      await expect(preview.locator('.katex')).toBeVisible();
      await expect(preview.locator('.katex-error')).toHaveCount(0);
      await expect(preview.getByTestId('math-preview-issue')).toBeHidden();

      await hover(page, 'Plain words', 'words');
      await expect(preview).toHaveCount(0);

      await hover(page, 'Broken $', 'frac');
      await expect(preview).toBeVisible();
      await expect(preview.getByTestId('math-preview-issue')).toContainText("Can't draw this formula:");

      await page.evaluate(() => localStorage.setItem('aldine.mathPreview.hover', 'false'));
      await page.reload();
      await expect(page.locator('[data-testid=code-pane] .cm-line', { hasText: 'Let $x' })).toBeVisible();
      await hover(page, 'Let $x', '\\R');
      await page.waitForTimeout(1200);
      await expect(preview).toHaveCount(0);

      expect(await stored(request, id)).toBe(DOC);
    } finally {
      await cleanup(request, id);
    }
  });

  test('the command pins a status preview at the cursor, and Escape closes it', async ({ page, request }) => {
    const id = await seed(request, 'Math Hover Pin');
    try {
      await openProject(page, id);
      const p = await spot(page, 'Let $x', 'x');
      await page.mouse.click(p.x, p.y);
      await page.mouse.move(5, 5);
      await page.getByTestId('palette-open').click();
      await page.getByTestId('palette-input').fill('Preview the formula');
      await page.getByTestId('palette-item-mathPreview.pin').click();
      const pinned = page.locator('[data-testid=math-preview][data-pinned=true]');
      await expect(pinned).toBeVisible();
      await expect(pinned).toHaveAttribute('role', 'status');
      await expect(pinned.locator('.katex')).toBeVisible();

      await page.locator('[data-testid=code-pane] .cm-content').focus();
      await page.keyboard.press('Escape');
      await expect(pinned).toHaveCount(0);
      expect(await stored(request, id)).toBe(DOC);
    } finally {
      await cleanup(request, id);
    }
  });
});
