import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, openPluginTab, cleanup } from './helpers';

/**
 * WP19 citation picker (feature 17): ⇧⌘E / Ctrl+Shift+E opens the picker,
 * "lamport 94" plus Enter writes the document's parenthetical command,
 * ⇧⌘Space switches it to narrative, and the picker opened inside a
 * citation edits it (chips prefilled, a page number added). natbib gets
 * \citet from Shift+Enter and p.~12 for a page.
 */
const BIB = [
  '@book{lamport1994, author = {Lamport, Leslie}, title = {LaTeX: A Document Preparation System}, year = {1994}}',
  '@book{knuth1984, author = {Knuth, Donald E.}, title = {The TeXbook}, year = {1984}}',
  '',
].join('\n');

const doc = (preamble: string) => [preamble, '\\begin{document}', 'As shown by', '\\end{document}', ''].join('\n');

async function seed(request: APIRequestContext, name: string, preamble: string): Promise<string> {
  const id = await createProject(request, name);
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'refs.bib', content: BIB } });
  await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: doc(preamble) } });
  return id;
}

const stored = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/projects/${id}/file?branch=main&path=main.tex`)).text();

async function caretAfter(page: Page, text: string) {
  await page.locator('.cm-line').filter({ hasText: text }).first().click();
  await page.keyboard.press('End');
}

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('citation picker', () => {
  test('biblatex: parenthetical, switch to narrative, then edit with a page', async ({ page, request }) => {
    const id = await seed(request, 'Cite Picker', '\\documentclass[man,biblatex]{apa7}\n\\addbibresource{refs.bib}');
    try {
      await openProject(page, id);
      await caretAfter(page, 'As shown by');
      await page.keyboard.press(`${MOD}+Shift+E`);
      await expect(page.getByTestId('cite-picker')).toBeVisible();
      await expect(page.getByTestId('cite-picker-note')).toContainText('biblatex');
      await page.getByTestId('cite-picker-input').fill('lamport 94');
      await expect(page.getByTestId('cite-picker-row-lamport1994')).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('cite-picker')).toHaveCount(0);
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('As shown by \\parencite{lamport1994}\n');

      await page.keyboard.press(`${MOD}+Shift+Space`);
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('As shown by \\textcite{lamport1994}\n');

      await page.keyboard.press(`${MOD}+Shift+E`);
      await expect(page.getByTestId('cite-picker-chip-lamport1994')).toBeVisible();
      await page.getByTestId('cite-locator').fill('12');
      await page.keyboard.press('Enter');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('As shown by \\textcite[12]{lamport1994}\n');
    } finally {
      await cleanup(request, id);
    }
  });

  test('natbib: Shift+Enter gives \\citet, a page gives p.~12', async ({ page, request }) => {
    const id = await seed(request, 'Cite Picker natbib', '\\documentclass{article}\n\\usepackage{natbib}\n\\bibliographystyle{plainnat}');
    try {
      await openProject(page, id);
      await caretAfter(page, 'As shown by');
      await page.keyboard.press(`${MOD}+Shift+E`);
      await expect(page.getByTestId('cite-picker-note')).toContainText('natbib');
      await page.getByTestId('cite-picker-input').fill('knuth');
      await expect(page.getByTestId('cite-picker-row-knuth1984')).toBeVisible();
      await page.keyboard.press('Shift+Enter');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('As shown by \\citet{knuth1984}\n');

      await page.keyboard.press('End');
      await page.keyboard.type(' and');
      await page.keyboard.press(`${MOD}+Shift+E`);
      await page.getByTestId('cite-picker-input').fill('lamport');
      await page.keyboard.press('Tab');
      await expect(page.getByTestId('cite-picker-chip-lamport1994')).toBeVisible();
      await page.getByTestId('cite-locator').fill('12');
      await page.keyboard.press('Enter');
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('\\citet{knuth1984} and \\citep[p.~12]{lamport1994}\n');
    } finally {
      await cleanup(request, id);
    }
  });
});

test.describe('Cite panel', () => {
  // "Cite panels use the document's citation command" is an automatic change, off under the legacy specs' defaults.
  test.use({ settingsTestDefaults: null });

  test('inserts the document\u2019s parenthetical command', async ({ page, request }) => {
    const id = await seed(request, 'Cite Panel', '\\documentclass[man,biblatex]{apa7}\n\\addbibresource{refs.bib}');
    try {
      await openProject(page, id);
      await caretAfter(page, 'As shown by');
      await page.keyboard.type(' ');
      await openPluginTab(page, 'references');
      await page.getByTestId('cite-bib-lamport1994').click();
      await expect.poll(() => stored(request, id), { timeout: 20_000 }).toContain('As shown by \\parencite{lamport1994}\n');
    } finally {
      await cleanup(request, id);
    }
  });
});
