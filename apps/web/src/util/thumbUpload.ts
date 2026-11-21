/**
 * Galley: page-1 thumbnails drawn in the browser. The deployed compiler has
 * no PDF rasterizer, so the editor draws page 1 of the PDF pdf.js already
 * opened for the preview and sends it to PUT /api/projects/:id/thumbnail
 * (apps/server/src/thumbnail-upload.ts), which stores it where the compiler's
 * renderer would have. The sizes match apps/compiler/thumbnail.js.
 *
 * Nothing here is visible: every failure is a console.debug line at most.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { withBase } from '../basePath';

const WIDTH = 512;
const MAX_HEIGHT = 1536;
const QUALITY = 0.75;
/** How long a PDF stays the one on screen before its page 1 is drawn. */
export const SETTLE_MS = 4000;

/** PDFs this tab has sent an image of (project, branch, link): at most once each. */
const sent = new Set<string>();

/** Where the compiler writes the PDF of `rootFile`, relative to the branch (the server's outputPdfRel). */
export function outputPdfRel(rootFile: string): string {
  const root = rootFile || 'main.tex';
  const slash = root.lastIndexOf('/');
  const dir = slash < 0 ? '' : root.slice(0, slash);
  const base = root.slice(slash + 1).replace(/\.tex$/i, '');
  return `${dir ? `${dir}/` : ''}.aldine-out/${base}.pdf`;
}

/** The output path a PDF link names (its `path` query value), or null. */
export function pdfPathOf(url: string): string | null {
  try { return new URL(url, 'http://x').searchParams.get('path'); } catch { return null; }
}

/** The scale that draws a page of `w` × `h` points 512 pixels wide, or less when it would pass 1536 high. */
export function thumbScale(w: number, h: number): number {
  return Math.min(WIDTH / w, MAX_HEIGHT / h);
}

async function drawPage1(pdf: PDFDocumentProxy, live: () => boolean): Promise<Blob | null> {
  const page = await pdf.getPage(1);
  const one = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: thumbScale(one.width, one.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx || !live()) return null;
  // JPEG has no transparency: an unpainted pixel would come out black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  if (!live()) return null;
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', QUALITY));
}

type Idle = (fn: () => void) => () => void;
const whenIdle: Idle = (fn) => {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
  if (w.requestIdleCallback && w.cancelIdleCallback) {
    const h = w.requestIdleCallback(fn, { timeout: 10_000 });
    return () => w.cancelIdleCallback!(h);
  }
  const t = setTimeout(fn, 50);
  return () => clearTimeout(t);
};

export interface ThumbTarget {
  projectId: string;
  branch: string;
  /** The PDF's link: a new typeset's PDF has a new one. */
  url: string;
  pdf: PDFDocumentProxy;
  /** Whether this PDF's pages are the ones on screen now. */
  onScreen(): boolean;
}

/**
 * Draws page 1 of `t.pdf` and sends it once the PDF has been on screen for
 * SETTLE_MS and the browser is idle; the returned function calls it off.
 */
export function scheduleThumbnail(t: ThumbTarget): () => void {
  const key = `${t.projectId}\u0000${t.branch}\u0000${t.url}`;
  if (sent.has(key)) return () => {};
  let live = true;
  let stopIdle: (() => void) | null = null;
  const alive = () => live && t.onScreen();
  const run = async () => {
    if (!alive() || sent.has(key)) return;
    // The byte length of the whole file pdf.js loaded: the server stores the
    // image only while the PDF on disk is still that size.
    const { length } = await t.pdf.getDownloadInfo();
    const blob = await drawPage1(t.pdf, alive);
    if (!blob || !alive() || sent.has(key)) return;
    sent.add(key);
    const res = await fetch(withBase(`/api/projects/${encodeURIComponent(t.projectId)}/thumbnail?branch=${encodeURIComponent(t.branch)}&pdfSize=${length}`), {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: blob,
    });
    if (!res.ok) console.debug(`[thumbnail] not stored: HTTP ${res.status}`);
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    timer = setTimeout(() => {
      timer = null;
      if (!live) return;
      // Loaded but not laid out yet: wait for the pages to go on screen.
      if (!t.onScreen()) { arm(); return; }
      stopIdle = whenIdle(() => { stopIdle = null; run().catch((err) => console.debug('[thumbnail] not drawn', err)); });
    }, SETTLE_MS);
  };
  arm();
  return () => {
    live = false;
    if (timer) clearTimeout(timer);
    stopIdle?.();
  };
}
