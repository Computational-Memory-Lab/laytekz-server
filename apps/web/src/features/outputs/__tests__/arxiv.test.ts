import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorPageCtx, PageEvents } from '../../types';
import type { CompileResult } from '../../../api';
import { createEmitter } from '../../events';
import { arxivName, downloadForArxiv, loadGenerated, requestArxivDownload, trackPage } from '../api';

/** What the download link was clicked with. */
let saved: { href: string; download: string }[] = [];

beforeEach(() => {
  saved = [];
  vi.stubGlobal('document', {
    createElement: () => {
      const a = { href: '', download: '', rel: '', style: {} as Record<string, string>, click() { saved.push({ href: a.href, download: a.download }); }, remove() {} };
      return a;
    },
    body: { appendChild() {} },
  });
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:zip', revokeObjectURL: () => {} }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const ok = (o: Partial<CompileResult> = {}) => ({ ok: true, pdf: 'main.pdf', pdfUrl: '/api/projects/p1/output?branch=main&path=.aldine-out%2Fmain.pdf&t=1', log: '', errors: [], durationMs: 1, ...o }) as CompileResult;

function page(o: { last?: CompileResult | null; next?: CompileResult } = {}) {
  const events = createEmitter<PageEvents>();
  let last = o.last === undefined ? ok() : o.last;
  const compile = vi.fn(() => {
    events.emit('compileRequested', { seq: 1, trigger: 'user' });
    setTimeout(() => { last = o.next ?? ok(); events.emit('compileFinished', { result: last!, trigger: 'user', own: true }); }, 0);
  });
  const p = { projectId: 'p1', branch: 'main', events, compile, lastCompile: () => last, project: () => ({ name: 'My paper' }) } as unknown as EditorPageCtx;
  return { p, compile, events };
}

function zipResponse(warnings?: string[]) {
  const headers = new Headers({ 'content-type': 'application/zip' });
  if (warnings) headers.set('x-laytekz-warnings', encodeURIComponent(JSON.stringify(warnings)));
  return new Response(new Blob(['PK']), { status: 200, headers });
}

const host = (p: EditorPageCtx | null, confirm = vi.fn(async () => true)) => ({ projectId: 'p1', branch: 'main', projectName: 'My paper', toast: vi.fn(), confirm, page: p });

describe('download for arXiv', () => {
  it('saves the ZIP at once, named after the project, when the last typeset is current', async () => {
    const { p, compile } = page();
    const off = trackPage(p);
    const fetch = vi.fn(async () => zipResponse());
    vi.stubGlobal('fetch', fetch);
    expect(await downloadForArxiv(host(p))).toBe(true);
    expect(compile).not.toHaveBeenCalled();
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe('/api/projects/p1/export/arxiv?branch=main');
    expect(saved).toEqual([{ href: 'blob:zip', download: 'My paper (arXiv).zip' }]);
    off();
  });

  it('typesets first after an edit, after a draft, or with no typeset, and waits for that run', async () => {
    for (const setup of ['edit', 'draft', 'none'] as const) {
      const { p, compile, events } = page({ last: setup === 'draft' ? ok({ draft: true }) : setup === 'none' ? null : ok() });
      const off = trackPage(p);
      if (setup === 'edit') events.emit('docChanged', { path: 'main.tex', local: true });
      vi.stubGlobal('fetch', vi.fn(async () => zipResponse()));
      expect(await downloadForArxiv(host(p))).toBe(true);
      expect(compile).toHaveBeenCalledTimes(1);
      expect(saved.length).toBe(1);
      saved = [];
      off();
    }
  });

  it('stops when the typeset fails, and asks for nothing from the server', async () => {
    const { p } = page({ last: null, next: ok({ ok: false }) });
    const off = trackPage(p);
    const fetch = vi.fn(async () => zipResponse());
    vi.stubGlobal('fetch', fetch);
    const h = host(p);
    expect(await downloadForArxiv(h)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenLastCalledWith(expect.stringContaining('typeset failed'), 'error');
    off();
  });

  it('asks before saving a ZIP with warnings, and saves nothing when declined', async () => {
    const { p } = page();
    const off = trackPage(p);
    vi.stubGlobal('fetch', vi.fn(async () => zipResponse(['LuaLaTeX: arXiv does not offer it.'])));
    const no = vi.fn(async () => false);
    expect(await downloadForArxiv(host(p, no))).toBe(false);
    expect(no).toHaveBeenCalledWith(expect.objectContaining({ title: 'Download for arXiv anyway?', confirmLabel: 'Download anyway', body: expect.stringContaining('LuaLaTeX') }));
    expect(saved).toEqual([]);
    const yes = vi.fn(async () => true);
    expect(await downloadForArxiv(host(p, yes))).toBe(true);
    expect(saved.length).toBe(1);
    off();
  });

  it('says "Typeset first" on a 409, with a Typeset action', async () => {
    const { p } = page();
    const off = trackPage(p);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Typeset first' }), { status: 409, headers: { 'content-type': 'application/json' } })));
    const h = host(p);
    expect(await downloadForArxiv(h)).toBe(false);
    expect(h.toast).toHaveBeenCalledWith('Typeset first: the arXiv ZIP needs a current typeset.', 'error', expect.objectContaining({ label: 'Typeset' }));
    // WP30's own reason is shown as it is
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Typeset first: refs.bib changed since the last typeset.', code: 'typeset-first' }), { status: 409 })));
    const h2 = host(p);
    expect(await downloadForArxiv(h2)).toBe(false);
    expect(h2.toast).toHaveBeenCalledWith('Typeset first: refs.bib changed since the last typeset.', 'error', expect.objectContaining({ label: 'Typeset' }));
    off();
  });

  it('from Share goes through the open editor page of that project and branch, else straight to the server', async () => {
    const { p, compile } = page({ last: ok({ draft: true }) });
    const off = trackPage(p);
    vi.stubGlobal('fetch', vi.fn(async () => zipResponse()));
    expect(await requestArxivDownload({ projectId: 'p1', branch: 'main', projectName: 'My paper', toast: vi.fn(), confirm: vi.fn(async () => true) })).toBe(true);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(await requestArxivDownload({ projectId: 'p1', branch: 'other', projectName: 'My paper', toast: vi.fn(), confirm: vi.fn(async () => true) })).toBe(true);
    expect(compile).toHaveBeenCalledTimes(1);
    off();
  });

  it('names the ZIP after the project', () => {
    expect(arxivName('My: paper')).toBe('My- paper (arXiv).zip');
    expect(arxivName('')).toBe('document (arXiv).zip');
  });
});

describe('loadGenerated', () => {
  it('reads the list route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ files: [{ name: 'main.bbl', size: 3, fromLastRun: true }] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const list = await loadGenerated({ projectId: 'p1', branch: 'main', pdfUrl: '/api/projects/p1/output?branch=main&path=paper%2F.aldine-out%2Fmain.pdf' });
    expect(list).toEqual({ dir: 'paper/.aldine-out', partial: false, files: [{ name: 'main.bbl', size: 3, mtime: null, fromLastRun: true, tracked: null, keepable: null }] });
  });

  it('probes beside the PDF, as V1 did, when the server has no list route', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/output/list')) return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
      const exists = url.includes('main.log');
      return new Response(JSON.stringify({ exists }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const list = await loadGenerated({ projectId: 'p1', branch: 'main', pdfUrl: '/api/projects/p1/output?branch=main&path=.aldine-out%2Fmain.pdf&t=4' });
    expect(list.partial).toBe(true);
    expect(list.dir).toBe('.aldine-out');
    expect(list.files.map((f) => f.name)).toEqual(['main.log']);
  });
});
