import { test, expect, type APIRequestContext } from '@playwright/test';
import { createProject, cleanup } from './helpers';

/**
 * WP35 library links in the real server against the mocks (mocks/mendeley.mjs,
 * mocks/zotero.mjs): Sign in with Mendeley through the mock's authorize page,
 * link a folder (its subfolder included) into mendeley.bib, link a Zotero
 * collection with a pasted key, both written by background syncs, then unlink
 * and disconnect. API only: the panel is WP36's.
 */
async function settle(request: APIRequestContext, id: string, jobId: string) {
  for (let i = 0; i < 100; i++) {
    const job = await (await request.get(`/api/projects/${id}/libraries/jobs/${jobId}`)).json();
    if (job.state === 'done' || job.state === 'error') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the sync did not finish');
}

test('library links: Mendeley by sign-in, Zotero by key, synced in the background', async ({ request }) => {
  const id = await createProject(request, 'Library links');
  try {
    const caps = await (await request.get('/api/capabilities')).json();
    expect(caps.libraries).toMatchObject({ mendeley: true, zotero: { key: true, oauth: false } });

    // Sign in with Mendeley: app → mock authorize page → app callback → back to the project.
    let res = await request.get(`/api/libraries/mendeley/connect?return=/p/${id}`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    res = await request.get(res.headers().location, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    res = await request.get(res.headers().location, { maxRedirects: 0 });
    expect(res.headers().location).toBe(`/p/${id}?library=mendeley&connected=1`);
    expect(await (await request.get('/api/libraries/mendeley/connection')).json()).toMatchObject({ connected: true, name: 'Mia Ross' });

    res = await request.post(`/api/projects/${id}/libraries`, { data: { provider: 'mendeley', library: 'me', collection: 'mf-thesis' } });
    expect(res.status()).toBe(200);
    const mendeley = await res.json();
    expect(mendeley.link).toMatchObject({ bibFile: 'mendeley.bib', collectionName: 'Thesis', recursive: true });
    expect((await settle(request, id, mendeley.jobId)).result).toMatchObject({ synced: true, itemCount: 2 });
    const mbib = await (await request.get(`/api/projects/${id}/file?path=mendeley.bib`)).text();
    expect(mbib).toContain('@article{ross2021crdt,');
    expect(mbib).toContain('@incollection{chen2019,');
    expect(mbib).toContain('10.5555/crdt_2021');
    expect(mbib).not.toContain('Private notes');

    // Zotero by pasted key, a collection and its subcollection.
    expect((await request.put('/api/libraries/zotero/connection', { data: { apiKey: 'test-key-123' } })).status()).toBe(200);
    res = await request.post(`/api/projects/${id}/libraries`, { data: { provider: 'zotero', library: 'users/777', collection: 'COLL1' } });
    expect(res.status()).toBe(200);
    const zot = await res.json();
    expect(zot.link.bibFile).toBe('zotero.bib');
    expect((await settle(request, id, zot.jobId)).result).toMatchObject({ synced: true, itemCount: 2 });
    const zbib = await (await request.get(`/api/projects/${id}/file?path=zotero.bib`)).text();
    expect(zbib).toContain('@article{turing1950,');
    expect(zbib).toContain('@book{shannon1948,');
    expect(zbib).not.toContain('Can machines think');

    const list = await (await request.get(`/api/projects/${id}/libraries`)).json();
    expect(list.map((l: { bibFile: string }) => l.bibFile)).toEqual(['mendeley.bib', 'zotero.bib']);
    res = await request.post(`/api/projects/${id}/libraries/${zot.link.id}/sync`, { data: { branch: 'main' } });
    expect((await settle(request, id, (await res.json()).jobId)).result).toMatchObject({ synced: false, unchanged: true });

    for (const l of list) expect((await request.delete(`/api/projects/${id}/libraries/${l.id}`)).status()).toBe(200);
    expect(await (await request.get(`/api/projects/${id}/libraries`)).json()).toEqual([]);
  } finally {
    await request.delete('/api/libraries/mendeley/connection');
    await request.delete('/api/libraries/zotero/connection');
    await cleanup(request, id);
  }
});
