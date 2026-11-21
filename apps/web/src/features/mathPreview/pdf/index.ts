import { StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { CompileError, CompileResult } from '../../../api';
import { getSetting } from '../../../settings/store';
import { renderMath } from '../../../editor/visual/katex';
import { macrosUsedBy } from '../../../editor/visual/preamble';
import type { EditorPageCtx } from '../../types';
import { registerPreviewTier, type PreviewTierRequest, type PreviewTierResult } from '../api';
import { docInfo, issueText } from '../render';
import { MATH_PREVIEW_SETTING_IDS } from '../settings';
import { compiledField, compiledRange, settleResult, synctexLines, takeRequestSnapshot, takeResultSnapshot } from './compiled';
import { CROP_PAD_PT, cropCanvas } from './crop';
import { textHash } from './hash';
import { disposeSynctex, loadSynctex } from './loader';

/**
 * F3's exact layer (WP21): when a display formula has not changed since the
 * last typeset, the preview shows the typeset PDF itself, cropped at the
 * formula's SyncTeX boxes. Proof that it has not changed: the server's hash
 * of the text it typeset (CompileResult.sources) matches the editor's text
 * when the result arrived (or when this page asked for the typeset), every
 * edit since is mapped, and none reached inside the formula. The SyncTeX file
 * is used only when its `x-synctex-run` header names the run whose PDF is
 * shown. Anything doubtful leaves KaTeX's drawing.
 */

type Sourced = CompileResult & { sources?: Record<string, string> };

/** The typeset whose PDF the page shows, with the hashes of what it typeset. */
export interface ShownRun {
  compileId: number;
  pdfUrl: string;
  sources: Record<string, string>;
  errors: CompileError[];
  at: number;
}

/** The run a compile result stands for, or null when it carries no proof (no PDF, a stale PDF, an old server). */
export function shownRun(r: CompileResult | null | undefined, at = Date.now()): ShownRun | null {
  const s = r as Sourced | null | undefined;
  if (!s || !s.pdfUrl || typeof s.compileId !== 'number' || s.pdfStale || !s.sources || typeof s.sources !== 'object') return null;
  return { compileId: s.compileId, pdfUrl: s.pdfUrl, sources: s.sources, errors: Array.isArray(s.errors) ? s.errors : [], at };
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}

/** The run reported an error on these lines of this file: TeX's recovery makes its PDF misleading there. */
export function errorOn(errors: readonly CompileError[], filePath: string, first: number, last: number): boolean {
  const want = normalize(filePath);
  return errors.some((e) => {
    if (e.type !== 'error' || e.line === null || e.line < first || e.line > last) return false;
    const f = normalize(e.file ?? '');
    return !f || f === want || want.endsWith(`/${f}`) || f.endsWith(`/${want}`);
  });
}

const CHANGED = 'Preview: changed since the last typeset';

/** KaTeX's drawing again, captioned as changed since the typeset; null when KaTeX could not draw it (its error stays). */
function changedResult(req: PreviewTierRequest): PreviewTierResult | null {
  const t = req.target;
  if (t.tooLong) return null;
  const info = docInfo(req.view.state);
  const html = renderMath(t.source, t.display, macrosUsedBy(t.source, info.macros));
  if (!html || html.includes('katex-error')) return null;
  const dom = document.createElement('div');
  dom.dataset.testid = 'math-preview-changed';
  dom.innerHTML = html;
  dom.style.fontSize = `${(info.fontPt * req.pxPerPt) / 1.21}px`;
  const issue = issueText(html);
  if (issue) {
    const note = document.createElement('div');
    note.className = 'cm-math-preview__issue';
    note.textContent = issue;
    dom.append(note);
  }
  return { tier: 'katex', dom, caption: CHANGED };
}

/** The views this layer has given its field (each file opens a view of its own). */
const tracked = new WeakSet<EditorView>();

/** Adds the compiled-text field to `view` if it lacks it. False while the view is updating (a dispatch now would throw). */
function track(view: EditorView): boolean {
  if (tracked.has(view) || view.state.field(compiledField, false)) { tracked.add(view); return true; }
  try {
    view.dispatch({ effects: StateEffect.appendConfig.of(compiledField) });
    tracked.add(view);
    return true;
  } catch {
    return false;
  }
}

/** Dispatches an effect now, or right after the update in progress (an event emitted from inside one). */
function dispatchSoon(view: EditorView, effect: StateEffect<unknown>): void {
  try {
    view.dispatch({ effects: effect });
  } catch {
    queueMicrotask(() => { try { view.dispatch({ effects: effect }); } catch { /* the view closed */ } });
  }
}

let tokens = 0;

/**
 * Checks the typeset text of `run` against `view`'s text now and against the
 * snapshot taken when this page asked for the typeset; the field keeps the
 * one that matches the server's hash, with every edit since mapped onto it.
 */
async function adopt(view: EditorView, filePath: string, run: ShownRun): Promise<void> {
  if (!track(view)) return;
  const token = ++tokens;
  try {
    view.dispatch({ effects: takeResultSnapshot.of(token) });
  } catch {
    return; // inside an update: the next preview adopts
  }
  const st = view.state.field(compiledField, false);
  const want = run.sources[filePath];
  const result = st?.pending.get(token)?.text.toString();
  const request = st?.request?.text.toString();
  let use: 'result' | 'request' | null = null;
  if (want && result !== undefined && (await textHash(result)) === want) use = 'result';
  else if (want && request !== undefined && (await textHash(request)) === want) use = 'request';
  try {
    view.dispatch({ effects: settleResult.of({ token, compileId: run.compileId, use }) });
  } catch { /* the view closed while the text was hashed */ }
}

let ownPdf: { url: string; doc: Promise<PDFDocumentProxy | null> } | null = null;

/** The shown run's PDF: the PDF pane's document, or (pane hidden) a copy loaded here. */
async function pdfOf(page: EditorPageCtx, run: ShownRun): Promise<PDFDocumentProxy | null> {
  const shown = page.pdf();
  if (shown && shown.url === run.pdfUrl) return shown.doc;
  if (shown) return null; // the pane shows another typeset: wait for it
  if (ownPdf?.url !== run.pdfUrl) {
    const old = ownPdf;
    void old?.doc.then((d) => d?.destroy());
    const { pdfjs } = await import('../../../util/pdfjs');
    ownPdf = { url: run.pdfUrl, doc: pdfjs.getDocument({ url: run.pdfUrl }).promise.catch(() => null) };
  }
  return ownPdf.doc;
}

export function activate(page: EditorPageCtx): () => void {
  let run: ShownRun | null = shownRun(page.lastCompile());
  const offs: (() => void)[] = [];

  const settleNow = (result: CompileResult) => {
    const view = page.view();
    const file = page.activeFile();
    const next = shownRun(result);
    // a run that wrote no PDF leaves the previous one on screen, and its mapped text stands
    if (!next && result.pdfStale && run && result.compileId === run.compileId) return;
    run = next;
    if (!view || !file) return;
    if (run) void adopt(view, file, run).catch(() => {});
    else if (track(view)) dispatchSoon(view, settleResult.of({ token: 0, compileId: 0, use: null }));
  };

  offs.push(page.events.on('compileRequested', () => {
    const view = page.view();
    if (view && track(view)) dispatchSoon(view, takeRequestSnapshot.of(null));
  }));
  offs.push(page.events.on('compileFinished', ({ result }) => settleNow(result)));

  offs.push(registerPreviewTier({
    id: 'pdf',
    priority: 100,
    async render(req) {
      // the tier is asked while the tooltip is being built, inside an editor update
      await Promise.resolve();
      if (getSetting<boolean>(MATH_PREVIEW_SETTING_IDS.pdf) === false) return null;
      const t = req.target;
      if (!t.display || (t.kind !== 'display' && t.kind !== 'env')) return null;
      const shown = run;
      if (!shown || req.signal.aborted) return null;
      const view = req.view;
      if (view.state.field(compiledField, false)?.compiled?.compileId !== shown.compileId) {
        await adopt(view, req.filePath, shown);
        if (req.signal.aborted || run !== shown) return null;
      }
      const at = compiledRange(view.state, t.from, t.to);
      if (at.kind === 'changed') return changedResult(req);
      if (at.kind !== 'ok' || at.compileId !== shown.compileId) return null;
      if (errorOn(shown.errors, req.filePath, at.firstLine, at.lastLine)) return null;
      const lines = synctexLines(at);
      if (!lines) return null;
      const [doc, sync] = await Promise.all([pdfOf(page, shown), loadSynctex(page.projectId, page.branch, shown.compileId)]);
      if (!doc || !sync || req.signal.aborted || run !== shown) return null;
      const rect = await sync.rect({ filePath: req.filePath, ...lines, pad: CROP_PAD_PT });
      if (!rect || req.signal.aborted) return null;
      const canvas = await cropCanvas(doc, rect, { pxPerPt: req.pxPerPt, paper: req.paper, label: t.source, signal: req.signal });
      if (!canvas || run !== shown) return null;
      const dom = document.createElement('div');
      dom.dataset.testid = 'math-preview-pdf';
      dom.append(canvas);
      return {
        tier: 'pdf',
        dom,
        caption: rect.continues ? 'As typeset (continues on the next page)' : 'As typeset',
        title: `Typeset at ${new Date(shown.at).toLocaleTimeString()}`,
      };
    },
  }));

  return () => {
    for (const off of offs) off();
    disposeSynctex();
    const own = ownPdf;
    ownPdf = null;
    void own?.doc.then((d) => d?.destroy());
  };
}
