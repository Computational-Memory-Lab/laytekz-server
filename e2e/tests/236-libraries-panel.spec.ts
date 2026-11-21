import type { Route } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup, openPluginTab } from './helpers';

/**
 * WP36: the Mendeley tab against WP35's library routes, mocked in the page
 * (page.route) because the two packages were built side by side. The synced
 * file itself is written through the real file API, as WP35's sync would.
 */
const BIB = '@article{lovelace1843,\n  author = {Lovelace, Ada},\n  title = {Notes on the Analytical Engine},\n  year = {1843},\n}\n';

test('Mendeley: connect, link a folder, a read-only mendeley.bib, sync with renamed keys, unlink', async ({ page, request }) => {
  const id = await createProject(request, 'Mendeley Panel');
  try {
    expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nAs \\cite{lovelace1843} wrote.\n\\end{document}\n' } })).ok()).toBeTruthy();

    let connected = false;
    let links: Array<Record<string, unknown>> = [];
    const posted: unknown[] = [];
    await page.route('**/api/capabilities', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), 'libraries.mendeley': true } });
    });
    await page.route(/\/api\/libraries\/mendeley\//, async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/connect')) {
        connected = true;
        await route.fulfill({ status: 302, headers: { location: url.searchParams.get('returnTo')! } });
      } else if (url.pathname.endsWith('/connection')) {
        await route.fulfill({ json: connected ? { connected: true, name: 'Ada' } : { connected: false } });
      } else if (url.pathname.endsWith('/libraries')) {
        await route.fulfill({ json: [{ id: 'personal', name: 'My library' }, { id: 'g1', name: 'Group: Engine' }] });
      } else if (url.pathname.endsWith('/collections')) {
        await route.fulfill({ json: [{ id: 'f1', name: 'Thesis' }, { id: 'f2', name: 'Notes', parentId: 'f1' }] });
      } else await route.fulfill({ status: 404, json: { error: 'not found' } });
    });
    await page.route(new RegExp(`/api/projects/${id}/libraries(/|$)`), async (route: Route) => {
      const req = route.request();
      const url = new URL(req.url());
      const rest = url.pathname.split('/libraries')[1] ?? '';
      if (rest === '' && req.method() === 'GET') return route.fulfill({ json: links });
      if (rest === '' && req.method() === 'POST') {
        const body = req.postDataJSON();
        posted.push(body);
        expect((await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: body.bibFile, content: BIB } })).ok()).toBeTruthy();
        const link = { id: 'm1', provider: 'mendeley', linkedBy: 'u1', linkedByName: 'Ada', libraryName: body.libraryName, collectionName: body.collectionName, bibFile: body.bibFile, recursive: body.recursive, lastSyncedAt: new Date().toISOString() };
        links = [link];
        return route.fulfill({ json: { link, jobId: 'j1' } });
      }
      if (rest === '/jobs/j1') return route.fulfill({ json: { state: 'done', itemCount: 1 } });
      if (rest === '/m1/sync') return route.fulfill({ json: { jobId: 'j2' } });
      if (rest === '/jobs/j2') return route.fulfill({ json: { state: 'done', itemCount: 1, renamedKeys: [{ from: 'lovelace1843', to: 'lovelaceNotes1843' }] } });
      if (rest === '/m1' && req.method() === 'DELETE') { links = []; return route.fulfill({ json: { ok: true } }); }
      return route.fulfill({ status: 404, json: { error: 'not found' } });
    });

    await openProject(page, id);
    // The tab sits on the main row, after Zotero.
    await expect(page.getByTestId('tab-plugin:mendeley')).toBeVisible();
    await openPluginTab(page, 'mendeley');
    await page.getByTestId('mendeley-connect').click();
    // Back from the round trip, the Mendeley tab is selected again.
    await expect(page.getByTestId('mendeley-connected')).toContainText('Signed in to Mendeley as Ada');
    await expect(page).not.toHaveURL(/libraries=mendeley/);

    await page.getByTestId('mendeley-add-link').click();
    await expect(page.getByTestId('mendeley-collection')).toContainText('Thesis › Notes');
    await page.getByTestId('mendeley-collection').selectOption('f1');
    await expect(page.getByTestId('mendeley-bibfile')).toHaveValue('mendeley.bib');
    await page.getByTestId('mendeley-import').click();
    await expect(page.getByTestId('mendeley-linked')).toHaveText('My library › Thesis → mendeley.bib');
    expect(posted[0]).toMatchObject({ provider: 'mendeley', library: 'personal', collection: 'f1', recursive: true, bibFile: 'mendeley.bib', omitFields: ['abstract', 'file', 'keywords'] });

    // The synced file opens read-only under the banner.
    await page.getByTestId('tab-files').click();
    await page.getByTestId('file-mendeley.bib').click();
    await expect(page.getByTestId('active-file')).toHaveText('mendeley.bib');
    await expect(page.getByTestId('read-only-banner')).toContainText('Synced from Mendeley (My library › Thesis), so it opens read-only');
    await page.locator('.cm-content').click();
    await page.keyboard.type('hand edit');
    await expect(page.locator('.cm-content')).not.toContainText('hand edit');

    // A sync that renames a key offers to update the citations, as one undo step.
    await page.getByTestId('file-main.tex').click();
    await expect(page.getByTestId('active-file')).toHaveText('main.tex');
    await openPluginTab(page, 'mendeley');
    await page.getByTestId('mendeley-sync').click();
    await expect(page.getByTestId('libraries-renamed-notice')).toContainText('lovelace1843 → lovelaceNotes1843');
    await page.getByTestId('libraries-renamed-update').click();
    await expect(page.locator('.cm-content')).toContainText('\\cite{lovelaceNotes1843}');
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.cm-content')).toContainText('\\cite{lovelace1843}');
    await page.getByTestId('libraries-renamed-dismiss').click();
    await expect(page.getByTestId('libraries-renamed-notice')).toHaveCount(0);

    // Unlinked, the file is an ordinary one again.
    await page.getByTestId('mendeley-unlink').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('mendeley-link')).toHaveCount(0);
    await page.getByTestId('tab-files').click();
    await page.getByTestId('file-mendeley.bib').click();
    await expect(page.getByTestId('active-file')).toHaveText('mendeley.bib');
    await expect(page.getByTestId('read-only-banner')).toHaveCount(0);
  } finally {
    await cleanup(request, id);
  }
});
