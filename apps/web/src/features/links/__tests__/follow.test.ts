import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { EditorFeatureCtx, EditorPageCtx } from '../../types';

const apiRequest = vi.fn(async (url: string): Promise<unknown> => {
  if (url.includes('/labels')) return [{ label: 'fig:x', file: 'sec/results.tex', line: 4 }];
  return [{ key: 'lamport94', file: 'zotero.bib', line: 2 }];
});
vi.mock('../../../api', () => ({ apiRequest: (url: string) => apiRequest(url) }));

const { linksCtx, resolveAt, runAction, keyAt } = await import('../follow');
const { __resetIndexes, loadIndex } = await import('../indexes');
const { takeRegexSeed } = await import('../searchSeed');

interface Fake { ctx: EditorFeatureCtx; opened: Array<[string, unknown]>; panels: Array<[string, string | undefined]>; notes: string[] }

function fake(settings: Record<string, boolean> = {}, filePath = 'main.tex'): Fake {
  const opened: Array<[string, unknown]> = [];
  const panels: Array<[string, string | undefined]> = [];
  const notes: string[] = [];
  const page = {
    projectId: 'p1', branch: 'main',
    files: () => ['main.tex', 'sec/intro.tex', 'sec/results.tex', 'zotero.bib', 'fig/plot.pdf'].map((path) => ({ path, type: 'file' as const })),
    openFile: (path: string, at?: unknown) => { opened.push([path, at]); },
    ui: { showPanel: (id: string, q?: string) => { panels.push([id, q]); } },
  } as unknown as EditorPageCtx;
  const ctx = {
    projectId: 'p1', branch: 'main', filePath, rootFile: 'main.tex',
    setting: <T,>(id: string) => (settings[id] ?? true) as unknown as T,
    notify: (text: string) => { notes.push(text); },
    page: () => page,
  } as unknown as EditorFeatureCtx;
  return { ctx, opened, panels, notes };
}

/** A view stand-in: resolveAt and keyAt read only `state`. */
function view(doc: string, f: Fake) {
  return { state: EditorState.create({ doc, extensions: [linksCtx.of(f.ctx)] }) };
}

beforeEach(() => { __resetIndexes(); apiRequest.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('resolveAt', () => {
  it('opens a web address, whatever the project switch says', () => {
    const f = fake({ 'links.project': false });
    const doc = 'See \\url{https://example.org/a\\_b} now.';
    const r = resolveAt(view(doc, f), doc.indexOf('example'));
    expect(r?.target.title).toBe('Open https://example.org/a_b');
    expect(r?.action).toEqual({ kind: 'external', href: 'https://example.org/a_b' });
  });

  it('is off with its switch: a ⌘-click adds a cursor again', () => {
    const f = fake({ 'links.follow': false });
    const doc = 'https://example.org/';
    expect(resolveAt(view(doc, f), 3)).toBeNull();
  });

  it('opens project files, and says when one is missing', () => {
    const f = fake();
    let doc = '\\input{sec/intro}';
    expect(resolveAt(view(doc, f), 10)?.action).toEqual({ kind: 'file', path: 'sec/intro.tex' });
    doc = '\\input{sec/nothere}';
    const r = resolveAt(view(doc, f), 10);
    expect(r?.target.error).toBe('No file sec/nothere in this project');
  });

  it('leaves project targets alone with the project switch off', () => {
    const f = fake({ 'links.project': false });
    expect(resolveAt(view('\\input{sec/intro}', f), 10)).toBeNull();
  });

  it('goes to a label in the same document', () => {
    const f = fake();
    const doc = 'See \\ref{sec:a}.\n\\section{A}\\label{sec:a}';
    const r = resolveAt(view(doc, f), doc.indexOf('sec:a'));
    expect(r?.action).toMatchObject({ kind: 'local', from: doc.indexOf('\\label') });
    expect(r?.target.title).toBe('Go to \\label{sec:a}, line 2');
  });

  it('goes to a label in another file once the index is in', async () => {
    const f = fake();
    const doc = 'See \\cref{fig:x} and \\ref{fig:none}.';
    const v = view(doc, f);
    expect(resolveAt(v, doc.indexOf('fig:x'))?.target.title).toBe('Go to \\label{fig:x}');
    await loadIndex('labels', 'p1', 'main');
    expect(resolveAt(v, doc.indexOf('fig:x'))?.target.title).toBe('Go to fig:x in sec/results.tex, line 4');
    expect(resolveAt(v, doc.indexOf('fig:none'))?.target.error).toBe('No \\label{fig:none} in this project');
  });

  it('finds a \\label\'s references', () => {
    const f = fake();
    const doc = '\\label{fig:x}';
    const r = resolveAt(view(doc, f), 8);
    expect(r?.action).toEqual({ kind: 'references', key: 'fig:x' });
    expect(keyAt(view(doc, f).state, 8, 'main.tex')).toBe('fig:x');
  });
});

describe('runAction', () => {
  it('opens addresses through window.open, never a refused one', async () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const f = fake();
    const v = view('', f) as never;
    await runAction(v, { kind: 'external', href: 'https://example.org/a_b' });
    expect(open).toHaveBeenCalledWith('https://example.org/a_b', '_blank', 'noopener,noreferrer');
    await runAction(v, { kind: 'external', href: 'javascript:alert(1)' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(f.notes).toEqual(['Laytekz opens only web and email links']);
  });

  it('opens a citation key\'s entry, with the Zotero notice', async () => {
    const f = fake();
    await runAction(view('', f) as never, { kind: 'cite', key: 'lamport94' });
    expect(f.opened).toEqual([['zotero.bib', { line: 2 }]]);
    expect(f.notes[0]).toMatch(/zotero\.bib is rewritten by each Zotero sync/);
  });

  it('opens the file holding a label', async () => {
    const f = fake();
    await runAction(view('', f) as never, { kind: 'ref', key: 'fig:x' });
    expect(f.opened).toEqual([['sec/results.tex', { find: '\\label{fig:x}' }]]);
  });

  it('seeds the Search panel with a pattern for Find references', async () => {
    const f = fake();
    await runAction(view('', f) as never, { kind: 'references', key: 'fig:x' });
    expect(f.panels).toHaveLength(1);
    const [id, q] = f.panels[0];
    expect(id).toBe('search');
    expect(new RegExp(q!).test('\\ref{fig:x}')).toBe(true);
    expect(takeRegexSeed(q)).toBe(true);
    expect(takeRegexSeed(q)).toBe(false);
  });
});
