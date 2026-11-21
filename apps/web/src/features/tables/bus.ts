import { getSetting } from '../../settings/store';
import type { EditorPageCtx } from '../types';
import { insertTable } from './actions';
import type { InsertOptions } from './actions';
import { FIRST_SIZE } from './picker';
import type { Size } from './picker';
import { TABLES_SETTING_IDS as ids } from './settings';
import type { ColumnAlign, Justify, LinesChoice } from './settings';
import type { AlignOptions } from '../../editor/tables/align';

/** The palette's "Insert table…" asks the table button to open its picker; a handled event is cancelled. */
export const PICKER_EVENT = 'laytekz:tables-picker';

export function setting<T>(id: string, fallback: T): T {
  try {
    const v = getSetting<T>(id);
    return v === undefined || v === null ? fallback : v;
  } catch { return fallback; }
}

/** The aligner's options from the settings. */
export function alignOptions(): AlignOptions {
  const justify = setting<Justify>(ids.justify, 'spec') === 'left' ? 'left' : 'spec';
  const w = setting<number>(ids.maxWidth, 40);
  return { justify, maxWidth: typeof w === 'number' && w >= 0 ? w : 40 };
}

/** The picker's options as the settings hold them. */
export function storedOptions(): Pick<InsertOptions, 'float' | 'header' | 'lines' | 'align'> {
  return {
    float: setting<boolean>(ids.insertFloat, true) !== false,
    header: setting<boolean>(ids.insertHeader, true) !== false,
    lines: setting<LinesChoice>(ids.insertLines, 'auto'),
    align: setting<ColumnAlign>(ids.insertAlign, 'l'),
  };
}

export function editorMode(): 'source' | 'visual' {
  return setting<string>('editor.mode', 'source') === 'visual' ? 'visual' : 'source';
}

/** Inserts a `size` table with the stored options into the open file and says what the person must know. */
export function insertForPage(page: EditorPageCtx, size: Size, extra: Partial<InsertOptions> = {}): boolean {
  const view = page.view();
  if (!view) return false;
  const r = insertTable(view, { ...storedOptions(), ...size, mode: editorMode(), ...extra });
  if (!r.ok) { page.toast(r.reason, 'info'); return false; }
  if (r.needsBooktabs) {
    const root = page.project()?.rootFile ?? 'the main file';
    page.toast(`Booktabs rules need \\usepackage{booktabs} in ${root}.`, 'info', root !== page.activeFile() ? {
      label: `Open ${root}`, run: () => page.openFile(root, { find: '\\begin{document}' }),
    } : undefined);
  }
  return true;
}

/** Opens the table button's picker, or, with no button on screen, inserts a 3 × 3 table with the stored options. */
export function openTablePicker(page: EditorPageCtx): void {
  const ev = new CustomEvent(PICKER_EVENT, { cancelable: true });
  window.dispatchEvent(ev);
  if (!ev.defaultPrevented) insertForPage(page, FIRST_SIZE);
}
