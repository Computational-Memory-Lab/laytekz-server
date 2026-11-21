import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { ApiError, type Comment } from '../../../api';
import type { EditorFeatureCtx, EditorPageCtx } from '../../types';
import { commentOnSelection, revealInPdf, resetForTests, trackEditor } from '../flow';

const { synctex, settings } = vi.hoisted(() => ({ synctex: vi.fn(), settings: {} as Record<string, unknown> }));
vi.mock('../../../api', () => {
  class ApiError extends Error {
    constructor(message: string, public readonly status: number) { super(message); }
  }
  return { api: { synctex: (...a: unknown[]) => synctex(...a) }, ApiError };
});
vi.mock('../../../settings/store', () => ({ getSetting: (id: string) => settings[id] }));
vi.mock('../../../keys/registry', () => ({ chordLabel: () => '⇧⌘C', matchesShortcut: () => false }));

const DOC = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Some text for the \\emph{commented} sentence,',
  'which runs onto a second line.',
  '\\end{document}',
  '',
].join('\n');

/** A stand-in for the editor view: a state and a dispatch, no DOM. */
function fakeView(doc: string) {
  const view = {
    state: EditorState.create({ doc }),
    dispatched: [] as TransactionSpec[],
    dispatch(spec: TransactionSpec) {
      view.dispatched.push(spec);
      view.state = view.state.update(spec).state;
    },
  };
  return view;
}

function fakePage(view: ReturnType<typeof fakeView>, o: { layout?: 'editor' | 'both' | 'pdf'; showcase?: boolean } = {}) {
  let active: string | null = 'other.tex';
  const toast = vi.fn();
  const page = {
    projectId: 'p1',
    branch: 'main',
    showcase: () => !!o.showcase,
    pdf: () => ({ url: '/out/run-1.pdf', doc: {} }),
    lastCompile: () => ({ ok: true, pdfUrl: '/out/run-1.pdf', compileId: 7 }),
    files: () => [{ path: 'main.tex', type: 'file' }, { path: 'other.tex', type: 'file' }],
    activeFile: () => active,
    openFile: vi.fn((p: string) => { active = p; }),
    view: () => view,
    toast,
    comments: () => [],
    ui: { layout: () => o.layout ?? 'both', phone: () => false, sidebarHidden: () => false, showPanel: () => {} },
  };
  return { page: page as unknown as EditorPageCtx, toast, openFile: page.openFile };
}

const selection = (text: string, rects = [{ left: 72, top: 100, right: 400, bottom: 110 }]) => ({ page: 1, text, rects, pdfUrl: '/out/run-1.pdf' });

let runCommand: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetForTests();
  synctex.mockReset();
  for (const k of Object.keys(settings)) delete settings[k];
  runCommand = vi.fn(() => true);
  trackEditor({ runCommand } as unknown as EditorFeatureCtx);
});

describe('commenting on a PDF selection', () => {
  it('finds the words in the source and opens the page\'s comment composer on them', async () => {
    synctex.mockResolvedValue({ ok: true, records: [{ input: '/srv/p1/./main.tex', line: 3 }] });
    const view = fakeView(DOC);
    const { page, toast, openFile } = fakePage(view);
    const out = await commentOnSelection(page, selection('commented sentence, which runs', [
      { left: 72, top: 100, right: 400, bottom: 110 }, { left: 72, top: 112, right: 200, bottom: 122 },
    ]));
    expect(out).toBe('composer');
    expect(openFile).toHaveBeenCalledWith('main.tex');
    // two lookups: the selection's first and last line, against the run on screen
    expect(synctex).toHaveBeenCalledTimes(2);
    expect(synctex.mock.calls[0]).toEqual(['p1', 'main', { direction: 'inverse', page: 1, x: 74, y: 105, compileId: 7 }]);
    const sel = view.state.selection.main;
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe('commented} sentence,\nwhich runs');
    expect(runCommand).toHaveBeenCalledWith('comment');
    expect(toast).not.toHaveBeenCalled();
    // only the selection changed
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it('says so plainly and anchors nothing when the words are not in the source there', async () => {
    synctex.mockResolvedValue({ ok: true, records: [{ input: 'main.tex', line: 3 }] });
    const view = fakeView(DOC);
    const { page, toast } = fakePage(view);
    expect(await commentOnSelection(page, selection('Figure 1: a caption from elsewhere'))).toBe('not-found');
    expect(runCommand).not.toHaveBeenCalled();
    expect(toast.mock.calls[0][0]).toMatch(/Could not find “Figure 1: a caption from elsewhere” in main\.tex near line 3, so no comment was added/);
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it('says so when SyncTeX finds no source, or text from outside the project', async () => {
    const view = fakeView(DOC);
    const { page, toast } = fakePage(view);
    synctex.mockResolvedValue({ ok: true, records: [] });
    expect(await commentOnSelection(page, selection('Some text'))).toBe('no-source');
    synctex.mockResolvedValue({ ok: true, records: [{ input: '/usr/share/texlive/article.cls', line: 9 }] });
    expect(await commentOnSelection(page, selection('Some text'))).toBe('outside');
    expect(toast.mock.calls[1][0]).toMatch(/article\.cls, which is not a file in this project/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('passes on the server\'s sentence when the preview and the SyncTeX file are different runs', async () => {
    synctex.mockRejectedValue(new ApiError('This preview is from an older typeset. Typeset again to jump.', 409));
    const { page, toast } = fakePage(fakeView(DOC));
    expect(await commentOnSelection(page, selection('Some text'))).toBe('lookup-failed');
    expect(toast).toHaveBeenCalledWith('This preview is from an older typeset. Typeset again to jump.', 'error');
  });

  it('refuses a selection from a PDF no longer on screen, a showcase, and the switch turned off', async () => {
    const { page } = fakePage(fakeView(DOC));
    expect(await commentOnSelection(page, { ...selection('Some text'), pdfUrl: '/out/run-0.pdf' })).toBe('stale');
    const show = fakePage(fakeView(DOC), { showcase: true });
    expect(await commentOnSelection(show.page, selection('Some text'))).toBe('readonly');
    settings['pdfComments.enabled'] = false;
    expect(await commentOnSelection(page, selection('Some text'))).toBe('off');
    expect(synctex).not.toHaveBeenCalled();
  });
});

describe('showing a comment in the PDF', () => {
  const comment = { id: 'c1', file: 'main.tex', anchor: { from: 0, to: 0, quote: 'commented' } } as unknown as Comment;

  it('jumps the PDF once Review has selected the comment, after a silent lookup', async () => {
    const view = fakeView(DOC);
    const at = DOC.indexOf('commented');
    view.dispatch({ selection: { anchor: at, head: at + 'commented'.length } });
    const { page, openFile } = fakePage(view);
    page.openFile('main.tex');
    openFile.mockClear();
    synctex.mockResolvedValue({ ok: true, records: [{ page: 1, x: 72, y: 100, h: 72, v: 100 }] });
    expect(await revealInPdf(page, comment)).toBe(true);
    expect(synctex).toHaveBeenCalledWith('p1', 'main', { direction: 'forward', file: 'main.tex', line: 3, column: 0 });
    expect(runCommand).toHaveBeenCalledWith('jump-pdf');
  });

  it('stays quiet when the comment has no place in the PDF, with one pane, or with the switch off', async () => {
    const view = fakeView(DOC);
    const at = DOC.indexOf('commented');
    view.dispatch({ selection: { anchor: at, head: at + 'commented'.length } });
    const both = fakePage(view);
    both.page.openFile('main.tex');
    synctex.mockResolvedValue({ ok: true, records: [] });
    expect(await revealInPdf(both.page, comment)).toBe(false);
    const single = fakePage(view, { layout: 'editor' });
    single.page.openFile('main.tex');
    expect(await revealInPdf(single.page, comment)).toBe(false);
    settings['pdfComments.revealInPdf'] = false;
    expect(await revealInPdf(both.page, comment)).toBe(false);
    expect(runCommand).not.toHaveBeenCalled();
    expect(both.toast).not.toHaveBeenCalled();
  });
});
