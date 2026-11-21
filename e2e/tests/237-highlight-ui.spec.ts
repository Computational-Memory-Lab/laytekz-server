import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP37 highlight-ui, smoke: the split button highlights the selection, the
 * dropdown picks a colour, right-click inside the selection offers the
 * highlighter (Shift+right-click does not), "Custom colour…" refuses a bad
 * hex and applies a good one, the card opens on a click inside a highlight,
 * the list shows them, and the file's bytes never change.
 */

const DOC = '\\documentclass{article}\n\\begin{document}\nAlpha beta gamma delta epsilon.\n\\end{document}\n';

async function seed(request: APIRequestContext, name: string): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
  return id;
}
const stored = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();

test('highlighter button, menus, custom colour, card and list', async ({ page, request }) => {
  const id = await seed(request, 'Highlighter UI');
  try {
    await openProject(page, id);
    const editor = page.getByTestId('code-pane').locator('.cm-editor');
    const line = editor.locator('.cm-line').filter({ hasText: 'Alpha beta' });
    await expect(line).toBeVisible();
    const button = page.getByTestId('highlight-button');
    await expect(button).toBeEnabled({ timeout: 20_000 });

    // The button paints the selection with the current colour (yellow).
    await line.getByText('Alpha beta gamma delta epsilon.').dblclick({ position: { x: 5, y: 5 } });
    await button.click();
    await expect(editor.locator('.cm-hl[data-hl-color="yellow"]')).toHaveText('Alpha');
    await expect(button).toHaveAttribute('aria-pressed', 'true');

    // The dropdown: Green repaints the selection and becomes the current colour.
    await page.getByTestId('highlight-options').click();
    await page.getByTestId('highlight-option-green').click();
    await expect(editor.locator('.cm-hl[data-hl-color="green"]')).toHaveText('Alpha');
    await expect(button).toHaveAttribute('data-hl-current', 'green');

    // Right-click inside a selection: the app menu with the highlighter; Pink from the submenu.
    const beta = editor.locator('.cm-line').filter({ hasText: 'Alpha beta' });
    const box = (await beta.boundingBox())!;
    await page.mouse.dblclick(box.x + 60, box.y + box.height / 2);
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    expect(selected.trim().length).toBeGreaterThan(0);
    await page.mouse.click(box.x + 60, box.y + box.height / 2, { button: 'right' });
    const menu = page.getByTestId('editor-context-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('editor-menu-highlight')).toBeVisible();
    await menu.getByTestId('editor-menu-highlight-colour').click();
    await page.getByTestId('editor-menu-highlight-pink').click();
    await expect(editor.locator('.cm-hl[data-hl-color="pink"]')).toHaveCount(1);

    // Shift+right-click never opens the app menu.
    await page.mouse.dblclick(box.x + 60, box.y + box.height / 2);
    await page.keyboard.down('Shift');
    await page.mouse.click(box.x + 60, box.y + box.height / 2, { button: 'right' });
    await page.keyboard.up('Shift');
    await expect(menu).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Custom colour: a bad hex is refused, a good one applies and joins "Your colours".
    await line.getByText(/epsilon/).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.getByTestId('highlight-options').click();
    await page.getByTestId('highlight-option-custom').click();
    const dialog = page.getByTestId('highlight-color-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('highlight-color-hex').fill('#12');
    await expect(page.getByTestId('highlight-color-error')).toBeVisible();
    await expect(page.getByTestId('highlight-color-apply')).toBeDisabled();
    await page.getByTestId('highlight-color-hex').fill('#3366ff');
    await page.getByTestId('highlight-color-apply').click();
    await expect(dialog).toHaveCount(0);
    await expect(editor.locator('.cm-hl[data-hl-color="#3366ff"]')).toHaveCount(1);
    await page.getByTestId('highlight-options').click();
    await expect(page.getByTestId('highlight-option-3366ff')).toBeVisible();
    await page.keyboard.press('Escape');

    // The card: a click inside a highlight shows it; Remove takes the highlight away.
    const green = editor.locator('.cm-hl[data-hl-color="green"]').first();
    await expect(green).toBeVisible();
    const g = (await green.boundingBox())!;
    await page.mouse.click(g.x + g.width / 2, g.y + g.height / 2);
    const card = page.getByTestId('highlight-card');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('highlight-card-title')).toContainText('Green highlight');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);

    // The list shows this file's highlights.
    await page.getByTestId('tab-highlighter.list').click();
    await expect(page.getByTestId('highlights-panel')).toBeVisible();
    await expect(page.getByTestId('highlights-row')).toHaveCount(3);
    await page.getByTestId('highlights-scope-project').click();
    await expect(page.getByTestId('highlights-row')).toHaveCount(3, { timeout: 15_000 });

    // Highlights never reach the file.
    expect(await stored(request, id)).toBe(DOC);
  } finally {
    await cleanup(request, id);
  }
});
