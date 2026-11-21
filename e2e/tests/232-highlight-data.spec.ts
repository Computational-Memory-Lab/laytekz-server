import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP32 highlight-data, smoke: ⇧⌘H highlights the selection, the mark is
 * shared through the doc (listed by GET …/highlights), survives a reload,
 * is one undo step, never changes the file's bytes, and the Highlighter
 * setting turned off hides it.
 */

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const DOC = '\\documentclass{article}\n\\begin{document}\nPlease highlight this phrase today.\n\\end{document}\n';

async function seed(request: APIRequestContext, name: string): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
  return id;
}
const stored = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();
const listed = async (request: APIRequestContext, id: string) => {
  const r = await request.get(`/api/projects/${id}/highlights?branch=main`);
  const body = await r.json() as { files: Array<{ path: string; highlights: Array<{ excerpt: string; colour: string }> }> };
  return body.files.flatMap((f) => f.highlights.map((h) => `${f.path}:${h.colour}:${h.excerpt}`));
};

test('highlight the selection with the shortcut: shared, undoable, kept, and never in the file', async ({ page, request }) => {
  const id = await seed(request, 'Highlighter Data');
  try {
    await openProject(page, id);
    const editor = page.getByTestId('code-pane').locator('.cm-editor');
    const word = editor.locator('.cm-line').filter({ hasText: 'Please highlight' });
    await expect(word).toBeVisible();
    await word.getByText('Please highlight this phrase today.').dblclick({ position: { x: 5, y: 5 } });
    await page.keyboard.press(`${mod}+Shift+KeyH`);
    const mark = editor.locator('.cm-hl[data-hl-color="yellow"]');
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveText('Please');
    await expect.poll(() => listed(request, id), { timeout: 15_000 }).toEqual(['main.tex:yellow:Please']);
    expect(await stored(request, id)).toBe(DOC);

    // One undo takes it back, redo restores it.
    await editor.locator('.cm-content').focus();
    await page.keyboard.press(`${mod}+KeyZ`);
    await expect(mark).toHaveCount(0);
    await page.keyboard.press(`${mod}+Shift+KeyZ`);
    await expect(mark).toHaveCount(1);
    await expect.poll(() => listed(request, id), { timeout: 15_000 }).toEqual(['main.tex:yellow:Please']);

    // Kept across a reload; the file is still exactly what it was.
    await page.reload();
    await expect(editor.locator('.cm-hl[data-hl-color="yellow"]')).toHaveText('Please', { timeout: 20_000 });
    expect(await stored(request, id)).toBe(DOC);

    // The Highlighter setting off hides the marks (the data stays).
    await page.evaluate(() => localStorage.setItem('aldine.highlighter.enabled', 'false'));
    await page.reload();
    await expect(editor.locator('.cm-line').filter({ hasText: 'Please highlight' })).toBeVisible({ timeout: 20_000 });
    await expect(editor.locator('.cm-hl')).toHaveCount(0);
    expect(await listed(request, id)).toEqual(['main.tex:yellow:Please']);
  } finally {
    await cleanup(request, id);
  }
});
