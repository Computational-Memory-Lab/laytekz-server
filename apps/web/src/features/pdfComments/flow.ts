/**
 * Feature 19's actions: comment on text selected in the PDF, and show a
 * comment in the PDF when it is chosen in Review. Both go through what the
 * editor page already has: the SyncTeX route the double-click jump uses, the
 * page's own `comment` command (its composer, the comments API, the Review
 * panel and the marks in the source) and its `jump-pdf` command. Nothing
 * here changes a document: the only editor transaction is a selection.
 */
import { EditorSelection, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { api, ApiError, type Comment } from '../../api';
import type { PdfTextSelection } from '../../contextmenu/types';
import { chordLabel } from '../../keys/registry';
import { getSetting } from '../../settings/store';
import type { EditorFeatureCtx, EditorPageCtx } from '../types';
import { locateSelection, pdfKey } from './match';
import { probePoint, sameSelectedText, shortQuote, sourcePlace, type SourcePlace, type SynctexRecord } from './place';
import { PDF_COMMENTS_SETTING_IDS as ids } from './settings';

// ---- Live state (one editor page at a time) ----

interface Live {
  page: EditorPageCtx;
  selection: PdfTextSelection | null;
}

let live: Live | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const fn of [...listeners]) fn(); };

/** The editor page features run on now, and the PDF selection it last reported. */
export function livePage(): EditorPageCtx | null { return live?.page ?? null; }
export function liveSelection(): PdfTextSelection | null { return live?.selection ?? null; }
export function subscribeSelection(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** activate(page): follow the page's PDF selection reports. */
export function attachPage(page: EditorPageCtx): () => void {
  live = { page, selection: null };
  const off = page.events.on('pdfSelection', ({ selection }) => {
    if (live?.page !== page) return;
    live.selection = selection;
    changed();
  });
  changed();
  return () => {
    off();
    if (live?.page === page) { live = null; changed(); }
  };
}

/** Settings read defensively: an unknown or unloaded store gives the default. */
export function settingOn(id: string): boolean {
  try { return getSetting<boolean>(id) !== false; } catch { return true; }
}
export const commentsOn = () => settingOn(ids.enabled);

// ---- What the editor contribution hands over ----

/** Each live editor view's feature context: which file it shows and whether its doc has synced. */
const viewCtx = new WeakMap<EditorView, EditorFeatureCtx>();
/** Runs a page command by id (`comment`, `jump-pdf`); only an editor context has it. */
let runCommand: ((id: string) => boolean) | null = null;

/** The editor extension: records the view's context, nothing else. */
export function trackEditor(ctx: EditorFeatureCtx): Extension {
  runCommand = ctx.runCommand;
  return ViewPlugin.define((view) => {
    viewCtx.set(view, ctx);
    return { destroy() { viewCtx.delete(view); } };
  });
}

/** For tests. */
export function resetForTests(): void {
  live = null;
  runCommand = null;
  listeners.clear();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `get` until it gives a value or `ms` pass. */
async function waitFor<T>(get: () => T | null, ms: number, step = 50): Promise<T | null> {
  const until = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() >= until) return null;
    await sleep(step);
  }
}

/** The editor view of `file` once it has loaded its text. */
function editorFor(page: EditorPageCtx, file: string): EditorView | null {
  const view = page.view();
  if (!view || page.activeFile() !== file) return null;
  const ctx = viewCtx.get(view);
  if (ctx) return ctx.filePath === file && ctx.synced() ? view : null;
  // Without the feature host's context (an older page) trust the active file once it has text.
  return view.state.doc.length > 0 ? view : null;
}

// ---- Comment on a PDF selection ----

/** The comment shortcut's label, for messages. */
function commentKeys(): string {
  try { return chordLabel('comment'); } catch { return 'the comment shortcut'; }
}

async function lookUp(page: EditorPageCtx, sel: PdfTextSelection, compileId: number | undefined): Promise<{ start: SourcePlace | null; end: SourcePlace | null }> {
  const ask = async (i: number) => {
    const p = probePoint(sel.rects[i]);
    const res = await api.synctex(page.projectId, page.branch, { direction: 'inverse', page: sel.page, x: p.x, y: p.y, compileId });
    return sourcePlace(res.records as SynctexRecord[] | undefined, page.files());
  };
  const last = sel.rects.length - 1;
  const [start, end] = await Promise.all([ask(0), last > 0 ? ask(last).catch(() => null) : Promise.resolve(null)]);
  return { start, end };
}

export type CommentOutcome = 'composer' | 'off' | 'readonly' | 'stale' | 'lookup-failed' | 'no-source' | 'outside' | 'no-editor' | 'not-found' | 'no-command';

let busy = false;

/**
 * Finds the selected words in the source and opens the page's comment
 * composer on them. Every way it can fail says so and anchors nothing.
 */
export async function commentOnSelection(page: EditorPageCtx, sel: PdfTextSelection): Promise<CommentOutcome> {
  if (busy) return 'composer';
  busy = true;
  try {
    return await commentOnSelectionNow(page, sel);
  } finally {
    busy = false;
  }
}

async function commentOnSelectionNow(page: EditorPageCtx, sel: PdfTextSelection): Promise<CommentOutcome> {
  if (!commentsOn()) return 'off';
  if (page.showcase()) {
    page.toast('This showcase is read-only, so it cannot take comments. Make a copy to comment on it.', 'info');
    return 'readonly';
  }
  const shown = page.pdf();
  if (!shown || sel.pdfUrl !== shown.url || !sel.rects.length || !pdfKey(sel.text)) {
    page.toast('The PDF changed after you selected this text. Select it again.', 'info');
    return 'stale';
  }
  const result = page.lastCompile();
  let place: { start: SourcePlace | null; end: SourcePlace | null };
  try {
    place = await lookUp(page, sel, result?.compileId);
  } catch (err) {
    // 409: the preview on screen and the SyncTeX on disk are different runs (the server's sentence says so).
    if (err instanceof ApiError && err.status === 409) page.toast(err.message, 'error');
    else page.toast('Laytekz could not look up where this text is in the source. Typeset again, then select the text once more.', 'error');
    return 'lookup-failed';
  }
  const { start, end } = place;
  if (!start) {
    page.toast(`Laytekz could not find where “${shortQuote(sel.text)}” is in the source, so no comment was added.`, 'error');
    return 'no-source';
  }
  if (!start.inProject) {
    page.toast(`“${shortQuote(sel.text)}” comes from ${start.file}, which is not a file in this project, so it cannot take a comment.`, 'error');
    return 'outside';
  }
  page.openFile(start.file);
  const view = await waitFor(() => editorFor(page, start.file), 8000);
  if (!view) {
    page.toast(`Could not open ${start.file} to place the comment.`, 'error');
    return 'no-editor';
  }
  const endLine = end && end.inProject && end.file === start.file ? end.line : undefined;
  const found = locateSelection(view.state.doc.toString(), start.line, sel.text, { endLine });
  if (!found) {
    // Show where SyncTeX points, and say plainly that nothing was anchored.
    const n = Math.min(Math.max(1, start.line), view.state.doc.lines);
    view.dispatch({ selection: { anchor: view.state.doc.line(n).from }, effects: EditorView.scrollIntoView(view.state.doc.line(n).from, { y: 'center' }), userEvent: 'select.pdfComment' });
    page.toast(`Could not find “${shortQuote(sel.text)}” in ${start.file} near line ${n}, so no comment was added. Select the words in the editor and press ${commentKeys()} to comment there.`, 'error');
    return 'not-found';
  }
  view.dispatch({
    selection: EditorSelection.single(found.from, found.to),
    effects: EditorView.scrollIntoView(found.from, { y: 'center' }),
    userEvent: 'select.pdfComment',
  });
  if (!runCommand || !runCommand('comment')) {
    page.toast('The comment box could not be opened here. Press the comment shortcut with the text selected in the editor.', 'error');
    return 'no-command';
  }
  return 'composer';
}

/** Waits briefly for a selection report that matches what the Selection holds now (reports settle 150 ms after a change). */
export async function selectionMatching(text: string, ms = 600): Promise<PdfTextSelection | null> {
  return waitFor(() => {
    const s = liveSelection();
    return s && sameSelectedText(s.text, text) ? s : null;
  }, ms, 30);
}

/** The PDF preview holds the document's text selection. */
export function selectionInPdf(): Selection | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const pane = document.querySelector('[data-testid="pdf-pane"]');
  return pane && pane.contains(sel.getRangeAt(0).startContainer) ? sel : null;
}

/**
 * boot(): the comment shortcut while the PDF has the selection. A capture
 * listener on window added at boot runs before the page's own (Editor.tsx
 * adds it later, in an effect), so the page never opens its composer on the
 * code editor's old selection. Anywhere else the key is left alone.
 */
export function onCommentKey(e: KeyboardEvent, matches: (e: KeyboardEvent) => boolean): void {
  if (e.defaultPrevented || e.repeat || e.isComposing) return;
  const page = livePage();
  if (!page || !matches(e) || !commentsOn()) return;
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
  const sel = selectionInPdf();
  if (!sel) return;
  e.preventDefault();
  e.stopPropagation();
  const text = sel.toString();
  void selectionMatching(text).then((s) => {
    if (s) void commentOnSelection(page, s);
    else page.toast('Select the text in the PDF again, then press the comment shortcut.', 'info');
  });
}

// ---- Show a comment in the PDF ----

/**
 * Review's "jump to the commented text" selects the comment's range in the
 * editor; once it has, the PDF scrolls to the same place through the page's
 * Jump PDF to cursor. A silent lookup first, so a comment with no place in
 * the PDF (a .bib file, an unused file) never raises the jump's error toast.
 */
export async function revealInPdf(page: EditorPageCtx, c: Comment): Promise<boolean> {
  if (!settingOn(ids.revealInPdf)) return false;
  if (page.ui.layout() !== 'both' || page.ui.phone() || !page.pdf() || !c.anchor.quote) return false;
  const view = await waitFor(() => {
    const v = editorFor(page, c.file);
    if (!v) return null;
    const s = v.state.selection.main;
    return !s.empty && v.state.sliceDoc(s.from, s.to) === c.anchor.quote ? v : null;
  }, 3000);
  if (!view) return false;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head).number;
  try {
    const res = await api.synctex(page.projectId, page.branch, { direction: 'forward', file: c.file, line, column: 0 });
    if (!res.records?.some((r) => r.page != null && (r.y != null || r.v != null))) return false;
  } catch {
    return false;
  }
  // The person may have moved on meanwhile: only while the caret is still on that line.
  if (page.view() !== view || view.state.doc.lineAt(view.state.selection.main.head).number !== line) return false;
  return !!runCommand?.('jump-pdf');
}

/** activate(page): a click on a Review card's "jump to the commented text". */
export function watchReviewClicks(page: EditorPageCtx): () => void {
  const onClick = (e: MouseEvent) => {
    const target = e.target as Element | null;
    const anchor = target && typeof target.closest === 'function' ? target.closest('.review__anchor') : null;
    const card = anchor?.closest('[data-comment-card]');
    const id = card?.getAttribute('data-comment-card');
    if (!id) return;
    const c = page.comments().find((x) => x.id === id);
    if (c) void revealInPdf(page, c);
  };
  document.addEventListener('click', onClick);
  return () => document.removeEventListener('click', onClick);
}
