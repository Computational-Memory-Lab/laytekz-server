/**
 * Laytekz V2 context-menu contracts (WP01, frozen). The editor's menu host is
 * contextmenu/index.ts (WP04); the PDF pane's is in PdfPane.tsx (WP05).
 */
import type { EditorView } from '@codemirror/view';
import type { MenuEntry } from '../components/Menu';
import type { EditorPageCtx } from '../features/types';
import type { TexContext } from '../editor/texContext/types';

/** One row of the menu: the item model of components/Menu.tsx. */
export type MenuItemSpec = MenuEntry;

export type MenuGroup = 'link' | 'navigate' | 'annotate' | 'insert' | 'table' | 'format';

export interface MenuTarget {
  view: EditorView;
  pos: number;
  selection: { from: number; to: number; empty: boolean };
  /** The selection existed before the button-2 mousedown. */
  hadSelection: boolean;
  ctx: TexContext | null;
  event: MouseEvent | KeyboardEvent;
  page: EditorPageCtx | null;
}

export interface ContextMenuEntry {
  id: string;
  group: MenuGroup;
  order: number;
  /** true: a plain right-click here opens the app menu even without a selection. */
  claims?(t: MenuTarget): boolean;
  items(t: MenuTarget): MenuItemSpec[] | null;
}

// ---- The PDF pane (left open for feature 19: comments on text selected in the PDF) ----

/** A box in PDF points, origin at the top-left of the page (pdf.js viewport with scale 1, y down). */
export interface PdfRect { left: number; top: number; right: number; bottom: number }

/** Text selected in the PDF preview's text layer. `page` is 1-based. */
export interface PdfTextSelection {
  page: number;
  text: string;
  /** One box per line of the selection on `page`. */
  rects: readonly PdfRect[];
  /** The selection's run: the CompileResult's pdfUrl, so a later typeset can tell it is stale. */
  pdfUrl: string;
}

export interface PdfMenuTarget {
  /** The page under the pointer (1-based), or null outside every page. */
  page: number | null;
  /** The pointer in that page's PDF points; null for a keyboard open. */
  point: { x: number; y: number } | null;
  selection: PdfTextSelection | null;
  event: MouseEvent | KeyboardEvent;
  pageCtx: EditorPageCtx | null;
}

export interface PdfContextMenuEntry {
  id: string;
  group: 'annotate' | 'navigate' | 'copy';
  order: number;
  items(t: PdfMenuTarget): MenuItemSpec[] | null;
}
