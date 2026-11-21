import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useChordLabel } from '../../keys/registry';
import { useSetting } from '../../settings/store';
import type { SlotProps } from '../../slots/types';
import { commentOnSelection, liveSelection, selectionInPdf, subscribeSelection } from './flow';
import { PDF_COMMENTS_SETTING_IDS as ids } from './settings';
import './pdfComments.css';

const GAP = 6;
const EDGE = 4;

/** Beside the end of the PDF selection, inside the preview; null when that end is scrolled out of view. */
function placeButton(width: number, height: number): { left: number; top: number } | null {
  const sel = selectionInPdf();
  const pane = document.querySelector('[data-testid="pdf-pane"]')?.getBoundingClientRect();
  if (!sel || !pane) return null;
  const rects = [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const last = rects[rects.length - 1];
  if (!last) return null;
  let left = last.right + GAP;
  let top = last.top + last.height / 2 - height / 2;
  if (left + width > pane.right - EDGE) {
    // No room on the right: under the end of the selection instead.
    left = last.right - width;
    top = last.bottom + GAP;
  }
  left = Math.min(Math.max(left, pane.left + EDGE), pane.right - width - EDGE);
  if (top < pane.top + EDGE || top + height > pane.bottom - EDGE) return null;
  return { left, top };
}

/** The Comment button beside text selected in the PDF preview (slot pdf.overlay). */
export default function CommentButton({ page }: SlotProps) {
  const [enabled] = useSetting<boolean>(ids.enabled);
  const selection = useSyncExternalStore(subscribeSelection, liveSelection, liveSelection);
  const keys = useChordLabel('comment');
  const ref = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const show = enabled !== false && !!selection && !!page && !page.showcase();

  const measure = useCallback(() => {
    const el = ref.current;
    setPlace(show ? placeButton(el?.offsetWidth || 96, el?.offsetHeight || 28) : null);
  }, [show]);

  useLayoutEffect(measure, [measure, selection]);
  useEffect(() => {
    if (!show) return;
    let frame = 0;
    const later = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };
    // Scrolls of the preview (capture: scroll does not bubble) and resizes move the selection.
    window.addEventListener('scroll', later, true);
    window.addEventListener('resize', later);
    return () => {
      window.removeEventListener('scroll', later, true);
      window.removeEventListener('resize', later);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [show, measure]);

  if (!show) return null;
  const run = () => {
    const s = liveSelection();
    if (!s || !page || busy) return;
    setBusy(true);
    void commentOnSelection(page, s).finally(() => setBusy(false));
  };
  return createPortal(
    <button
      ref={ref}
      type="button"
      className="btn btn--small btn--primary pdf-comment-btn"
      data-testid="pdf-comment-button"
      style={place ? { left: place.left, top: place.top } : { visibility: 'hidden', left: 0, top: 0 }}
      title={`Comment on this text (${keys})`}
      disabled={busy}
      // Pressing a button would clear the selection it is about.
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {busy ? 'Finding…' : 'Comment'}
    </button>,
    document.body,
  );
}
