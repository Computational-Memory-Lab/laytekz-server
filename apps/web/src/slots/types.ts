/**
 * Laytekz V2 slot contracts (WP01, frozen). The <Slot> component is
 * slots/Slot.tsx (WP06); WP06 renders every slot below.
 */
import type { ComponentType } from 'react';
import type { AppCtx, EditorPageCtx } from '../features/types';

export type SlotId =
  | 'toolbar.main'      // project toolbar, before Share
  | 'editor.status'     // editor pane header, after the file name (context chip; word count in the editor-only layout)
  | 'editor.tools'      // editor pane header, before Find. Orders: 100 tables, 200 statistics, 300 highlighter, 400 citations
  | 'editor.banners'    // below the editor pane header (read-only reasons, notices)
  | 'pdf.status'        // PDF pane header, after the typeset status (word count)
  | 'pdf.actions'       // PDF pane header, before Zoom (download button, order 900)
  | 'pdf.overlay'       // over the PDF pages, positioned by the item (PDF selection comments, feature 19)
  | 'files.footer'      // bottom of the Files panel (generated files)
  | 'sidebar.panels'    // sidebar tabs; an item with `panel` becomes a tab
  | 'editor.overlay'    // end of .editor-shell (pet)
  | 'home.toolbar'
  | 'home.accountMenu'
  | 'phone.moreSheet';

export interface SlotProps { page: EditorPageCtx | null; app: AppCtx }

export interface SlotItem {
  /** Unique; '<featureId>.<name>'. Also the panel id of a `sidebar.panels` item. */
  id: string;
  slot: SlotId;
  /** Ascending; ties keep manifest order. */
  order: number;
  when?(p: SlotProps): boolean;
  /** Heavy UI is lazy: `render: lazy(() => import('./Picker'))`. Each item
   *  renders inside its own ErrorBoundary and Suspense. */
  render: ComponentType<SlotProps>;
  /** `sidebar.panels` only. `pinned`: a tab on the sidebar's main row (beside
   *  Files, Search, History, Review); otherwise listed in the More menu. */
  panel?: { title: string; icon: ComponentType; pinned?: boolean };
}
