import { lazy } from 'react';
import { chordLabel, matchesShortcut } from '../../keys/registry';
import type { PdfContextMenuEntry } from '../../contextmenu/types';
import type { FeatureModule } from '../types';
import { attachPage, commentOnSelection, commentsOn, onCommentKey, trackEditor, watchReviewClicks } from './flow';

/**
 * F19 comments on text selected in the PDF (package WPX1). Select text in
 * the PDF preview, then choose the Comment button beside it, "Comment on
 * this text" in its right-click menu, or the comment shortcut (⇧⌘C): the
 * words are found in the source through SyncTeX and the page's own comment
 * composer opens on them, so the comment is an ordinary one (Review panel,
 * marks in the source, the comments API). Choosing a comment in Review also
 * scrolls the PDF to it. Settings: pdfComments.enabled, pdfComments.revealInPdf.
 */

const comments = (k: KeyboardEvent) => {
  try { return matchesShortcut(k, 'comment'); } catch { return false; }
};

const pdfMenu: PdfContextMenuEntry = {
  id: 'pdfComments.add',
  group: 'annotate',
  order: 10,
  items: (t) => {
    const page = t.pageCtx, sel = t.selection;
    if (!page || !sel || page.showcase() || !commentsOn()) return null;
    let shortcut: string | undefined;
    try { shortcut = chordLabel('comment'); } catch { shortcut = undefined; }
    return [{ id: 'pdfComments.add', label: 'Comment on this text', shortcut, testId: 'pdf-comment-item', onSelect: () => { void commentOnSelection(page, sel); } }];
  },
};

const feature: FeatureModule = {
  id: 'pdfComments',
  editor: {
    // Every file: a comment can sit in any text file, and the page's commands come through this context.
    files: /(?:)/,
    extension: (ctx) => trackEditor(ctx),
  },
  slots: [{ id: 'pdfComments.button', slot: 'pdf.overlay', order: 100, render: lazy(() => import('./CommentButton')) }],
  pdfContextMenu: [pdfMenu],
  activate(page) {
    const offPage = attachPage(page);
    const offReview = watchReviewClicks(page);
    return () => { offReview(); offPage(); };
  },
  boot() {
    const onKey = (e: KeyboardEvent) => onCommentKey(e, comments);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  },
};

export default feature;
