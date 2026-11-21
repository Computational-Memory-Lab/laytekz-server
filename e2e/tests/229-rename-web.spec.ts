import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP29 rename-web (F10): renaming the main document offers the .bib that
 * shares its name and the references to both, applies them as one commit,
 * and the notification's Undo puts everything back. A rename nothing refers
 * to happens straight away, as before.
 */

const put = (request: APIRequestContext, id: string, path: string, content: string) =>
  request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path, content } });
const read = async (request: APIRequestContext, id: string, path: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=${encodeURIComponent(path)}`)).text();
const listing = async (request: APIRequestContext, id: string): Promise<string[]> => {
  const { files } = (await (await request.get(`/api/projects/${id}/files?branch=main`)).json()) as { files: { path: string; type: string }[] };
  return files.filter((f) => f.type === 'file').map((f) => f.path).sort();
};
const rootOf = async (request: APIRequestContext, id: string) => ((await (await request.get(`/api/projects/${id}`)).json()) as { rootFile: string }).rootFile;

async function renameFromTree(page: Page, from: string, to: string) {
  await page.getByTestId(`file-${from}`).click({ button: 'right' });
  await page.getByTestId('file-menu-rename').click();
  await page.getByTestId('dialog-input').fill(to);
  await page.getByTestId('dialog-confirm').click();
}

const PAPER = '\\documentclass{article}\n\\usepackage[backend=biber]{biblatex}\n\\addbibresource{paper.bib}\n\\begin{document}\nHello.\n\\input{intro}\n% \\addbibresource{paper.bib} kept for later\n\\end{document}\n';

test.describe('rename preview', () => {
  test('renaming the main document offers its .bib, updates the references in one commit, and Undo puts everything back', async ({ page, request }) => {
    const id = await createProject(request, 'Rename Preview');
    try {
      await put(request, id, 'paper.tex', PAPER);
      await put(request, id, 'paper.bib', '@misc{a, title={A}}\n');
      await put(request, id, 'intro.tex', 'Intro.\n');
      await put(request, id, 'scratch.tex', 'x\n');
      await request.patch(`/api/projects/${id}`, { data: { rootFile: 'paper.tex' } });
      await openProject(page, id);

      // a rename nothing refers to: no dialog
      await renameFromTree(page, 'scratch.tex', 'notes.tex');
      await expect(page.getByTestId('file-notes.tex')).toBeVisible();
      await expect(page.getByTestId('rename-preview')).toHaveCount(0);

      await renameFromTree(page, 'paper.tex', 'thesis.tex');
      const dialog = page.getByTestId('rename-preview');
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId('rename-preview-title')).toHaveText('Rename paper.tex to thesis.tex?');
      await expect(page.getByTestId('rename-file-paper.bib')).toBeChecked();
      await expect(dialog.locator('[data-kind="comment"]').first(), 'a reference in a comment starts unchecked').not.toBeChecked();
      await expect(dialog.locator('[data-kind="code"]').first()).toBeChecked();
      await expect(page.getByTestId('rename-confirm')).toHaveText('Rename 2 files and update 1 reference');
      await page.getByTestId('rename-confirm').click();
      await expect(dialog).toHaveCount(0);

      await expect(page.locator('.toast').filter({ hasText: 'Renamed paper.tex to thesis.tex and 1 other file, and updated 1 reference in 1 file' })).toBeVisible();
      await expect.poll(() => listing(request, id)).toEqual(expect.arrayContaining(['thesis.tex', 'thesis.bib', 'intro.tex']));
      expect(await listing(request, id)).not.toContain('paper.tex');
      expect(await read(request, id, 'thesis.tex')).toContain('\\addbibresource{thesis.bib}');
      await expect.poll(() => rootOf(request, id)).toBe('thesis.tex');
      await expect(page.getByTestId('file-thesis.tex')).toBeVisible();

      // Undo: names, text and the main document come back
      await page.locator('.toast').filter({ hasText: 'Renamed paper.tex' }).getByRole('button', { name: 'Undo' }).click();
      await expect.poll(() => listing(request, id)).toEqual(expect.arrayContaining(['paper.tex', 'paper.bib']));
      expect(await read(request, id, 'paper.tex')).toContain('\\addbibresource{paper.bib}');
      await expect.poll(() => rootOf(request, id)).toBe('paper.tex');
      await expect(page.getByTestId('file-paper.tex')).toBeVisible();
    } finally { await cleanup(request, id); }
  });
});
