import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP10 escape-typing (feature 1): & and % typed in text are escaped, a table
 * keeps & raw, Backspace right after gives the plain character back, a paste
 * of prose is escaped in Source mode (raw with ⌘⇧V), the context chip names
 * where the cursor is, and with the switches off nothing changes.
 */
test.use({ settingsTestDefaults: null });

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  'First line.',
  '\\begin{tabular}{ll}',
  'CELL',
  '\\end{tabular}',
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

/** Puts the caret at the end of the first editor line that starts with `text`. */
async function caretAfter(page: Page, text: string) {
  await page.locator('.cm-line').filter({ hasText: new RegExp(`^${text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`) }).first().click();
  await page.keyboard.press('End');
}

/** A paste event with plain text, as the browser sends one. */
const paste = (page: Page, text: string) => page.locator('.cm-content').evaluate((el, t) => {
  const data = new DataTransfer();
  data.setData('text/plain', t);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, text);

test.describe('escape typing', () => {
  test('escapes & and % in text, keeps & raw in a table, Backspace reverts, paste escapes, the chip follows', async ({ page, request }) => {
    const id = await seed(request, 'Escape Typing');
    try {
      await openProject(page, id);
      await caretAfter(page, 'First line.');
      await page.keyboard.type(' R&D grew 50% ', { delay: 30 });
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('First line. R\\&D grew 50\\% ');
      await expect(page.getByTestId('typing-mode')).toHaveText('Text');

      await page.keyboard.type('Q&', { delay: 30 });
      await page.waitForTimeout(100);
      await page.keyboard.press('Backspace');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('50\\% Q&\n');

      await caretAfter(page, 'CELL');
      await page.keyboard.type(' & b \\\\', { delay: 30 });
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('CELL & b \\\\\n');
      await expect(page.getByTestId('typing-mode')).toHaveText(/^Table/);

      await caretAfter(page, 'First line.');
      await page.keyboard.press('Enter');
      await paste(page, 'Q&A: 30% off, $5 #1');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('\nQ\\&A: 30\\% off, \\$5 \\#1\n');

      // ⌘⇧V / Ctrl+Shift+V: the browser's plain-text paste, stored exactly as copied.
      await page.keyboard.press('Enter');
      await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+V`);
      await paste(page, 'Raw: 5% & #2');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('\nRaw: 5% & #2\n');
    } finally {
      await cleanup(request, id);
    }
  });

  test('works in Visual mode too', async ({ page, request }) => {
    await page.addInitScript(() => window.localStorage.setItem('aldine.editorMode', 'visual'));
    const id = await seed(request, 'Escape Typing Visual');
    try {
      await openProject(page, id);
      await caretAfter(page, 'First line.');
      await page.keyboard.type(' R&D grew 50% ', { delay: 30 });
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('First line. R\\&D grew 50\\% ');
    } finally {
      await cleanup(request, id);
    }
  });

  test('with the switches off, input is stored exactly as typed', async ({ page, request }) => {
    await page.addInitScript(() => {
      for (const id of ['escape.amp', 'escape.percent', 'escape.hash', 'escape.paste']) localStorage.setItem(`aldine.${id}`, 'false');
    });
    const id = await seed(request, 'Escape Typing Off');
    try {
      await openProject(page, id);
      await caretAfter(page, 'First line.');
      await page.keyboard.type(' R&D grew 50% #1', { delay: 30 });
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('First line. R&D grew 50% #1\n');
    } finally {
      await cleanup(request, id);
    }
  });
});
