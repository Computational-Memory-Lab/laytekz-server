import { lazy, Suspense, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { usePageEvents } from '../host';
import type { SlotProps } from '../../slots/types';
import { useSetting } from '../../settings/store';
import { usePopover } from '../../util/usePopover';
import { isOver, ruleLabel, statusText, statusTitle } from './model';
import { SHOW_SETTING, subscribeWordCount, wordCountSnapshot } from './store';
import { useBreakdownRequests } from './requests';
import './wordcount.css';

const Breakdown = lazy(() => import('./Breakdown'));

const POPOVER_WIDTH = 380;

/** Under the button, its right edge on the button's, kept on screen. */
function popoverPlace(rect: DOMRect): { top: number; left: number } {
  const vw = window.innerWidth;
  const width = Math.min(POPOVER_WIDTH, vw - 16);
  return { top: Math.round(rect.bottom + 6), left: Math.round(Math.min(Math.max(8, rect.right - width), vw - width - 8)) };
}

/**
 * The word count in the PDF pane's header (and in the editor's header in the
 * Editor-only layout): "3,412 words", "3,412 / 4,000 words", or "214 of
 * 3,412 words" while text is selected. A button that opens the breakdown.
 * It renders no wrapper, so the header's `.pdf-status + .pdf-words` rule
 * still puts its separator dot before it.
 */
export default function WordCountStatus({ page }: SlotProps) {
  const snap = useSyncExternalStore(subscribeWordCount, wordCountSnapshot, wordCountSnapshot);
  const [show] = useSetting<boolean>(SHOW_SETTING);
  const pop = usePopover();
  usePageEvents(page, ['activeFile']);
  useBreakdownRequests(page, () => pop.setOpen(true));
  if (!page || show === false || !page.activeFile()) return null;
  const s = { total: snap.total, target: snap.inDoc ? snap.rule.target : null, sel: snap.sel, inDoc: snap.inDoc };
  const over = isOver(s);
  const rect = pop.open ? pop.trigger.current?.getBoundingClientRect() : null;
  return (
    <>
      <button
        ref={pop.trigger}
        type="button"
        className={`pdf-status pdf-words wc-status${over ? ' wc-status--over' : ''}`}
        data-testid="word-count"
        data-over={over ? 'true' : undefined}
        title={statusTitle(s, ruleLabel(snap.rule))}
        aria-expanded={pop.open}
        aria-haspopup="dialog"
        // the popover closes on any press outside it; the button toggles it itself
        onPointerDown={(e) => { if (pop.open) e.stopPropagation(); }}
        onClick={() => pop.setOpen(!pop.open)}
      >
        {statusText(s)}
      </button>
      {pop.open && rect && createPortal(
        <div
          ref={pop.ref}
          className="wc-popover"
          role="dialog"
          aria-label="Word count breakdown"
          data-testid="word-count-popover"
          style={popoverPlace(rect)}
        >
          <Suspense fallback={<div className="wc-popover__loading">Loading…</div>}>
            <Breakdown page={page} onClose={pop.close} />
          </Suspense>
        </div>,
        document.body,
      )}
    </>
  );
}
