import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { SynctexRect } from './synctex';

/** Space kept around the formula's boxes, in points. */
export const CROP_PAD_PT = 3;

/** The theme's colours, for "Match the theme" (pdf.js maps the page's ink onto them). */
function themeColors(): { background: string; foreground: string } | null {
  try {
    const css = getComputedStyle(document.documentElement);
    const background = css.getPropertyValue('--bg-panel-raised').trim() || css.getPropertyValue('--bg-panel').trim();
    const foreground = css.getPropertyValue('--text').trim();
    return background && foreground ? { background, foreground } : null;
  } catch {
    return null;
  }
}

/**
 * Draws `rect` of the typeset PDF's page into a canvas at `pxPerPt` CSS
 * pixels per point, sharp on the screen's pixel ratio. Null when the page
 * cannot be drawn as SyncTeX measured it (a rotated page), or on abort.
 */
export async function cropCanvas(doc: PDFDocumentProxy, rect: SynctexRect, o: { pxPerPt: number; paper: boolean; label: string; signal: AbortSignal }): Promise<HTMLCanvasElement | null> {
  if (rect.page < 1 || rect.page > doc.numPages) return null;
  const page = await doc.getPage(rect.page);
  if (o.signal.aborted || page.rotate % 360 !== 0) return null;
  const [vx0, vy0, vx1, vy1] = page.view;
  // SyncTeX measures from the page's corner; a crop box moved off it would shift every crop
  if (vx0 !== 0 || vy0 !== 0) return null;
  const x0 = Math.max(rect.x0, 0), y0 = Math.max(rect.y0, 0);
  const x1 = Math.min(rect.x1, vx1 - vx0), y1 = Math.min(rect.y1, vy1 - vy0);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const dpr = Math.min(Math.max(globalThis.devicePixelRatio || 1, 1), 3);
  const scale = o.pxPerPt * dpr;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w * scale));
  canvas.height = Math.max(1, Math.ceil(h * scale));
  canvas.style.width = `${w * o.pxPerPt}px`;
  canvas.style.maxWidth = '100%';
  canvas.style.height = 'auto';
  canvas.style.display = 'block';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', o.label);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const viewport = page.getViewport({ scale, offsetX: -x0 * scale, offsetY: -y0 * scale });
  const colors = o.paper ? null : themeColors();
  if (o.paper) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const task: RenderTask = page.render({
    canvasContext: ctx,
    viewport,
    ...(colors ? { pageColors: colors } : {}),
  } as Parameters<typeof page.render>[0]);
  const stop = () => task.cancel();
  o.signal.addEventListener('abort', stop, { once: true });
  try {
    await task.promise;
  } catch {
    return null;
  } finally {
    o.signal.removeEventListener('abort', stop);
  }
  return o.signal.aborted ? null : canvas;
}
