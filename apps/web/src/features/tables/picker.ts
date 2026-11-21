import { MAX_COLS, MAX_ROWS } from '../../editor/tables/insert';

/**
 * The grid picker's model, pure: the size under the pointer or chosen by
 * the keys, and how far the grid is drawn. It starts at 8 × 8 and grows by
 * one column or row when the pointer reaches the last one, up to 12 × 20
 * (8 columns on a phone).
 */

export interface Size { cols: number; rows: number }
export interface Shown { cols: number; rows: number }

export const START = 8;
export const PHONE_COLS = 8;
export const FIRST_SIZE: Size = { cols: 3, rows: 3 };

export function maxCols(phone: boolean): number {
  return phone ? PHONE_COLS : MAX_COLS;
}

export function clampSize(s: Size, phone = false): Size {
  return {
    cols: Math.max(1, Math.min(maxCols(phone), Math.floor(s.cols) || 1)),
    rows: Math.max(1, Math.min(MAX_ROWS, Math.floor(s.rows) || 1)),
  };
}

/** The grid drawn for `size`: at least 8 × 8, one more than the size where it reaches the edge, within the maximum. */
export function shownFor(size: Size, shown: Shown, phone = false): Shown {
  const mc = maxCols(phone);
  return {
    cols: Math.min(mc, Math.max(phone ? Math.min(START, mc) : START, shown.cols, size.cols + (size.cols >= shown.cols ? 1 : 0))),
    rows: Math.min(MAX_ROWS, Math.max(START, shown.rows, size.rows + (size.rows >= shown.rows ? 1 : 0))),
  };
}

/** What a key does to the size: a new size, 'insert' (Enter, Space), or null (not the grid's key). */
export function keyStep(size: Size, key: string, phone = false): Size | 'insert' | null {
  switch (key) {
    case 'ArrowRight': return clampSize({ ...size, cols: size.cols + 1 }, phone);
    case 'ArrowLeft': return clampSize({ ...size, cols: size.cols - 1 }, phone);
    case 'ArrowDown': return clampSize({ ...size, rows: size.rows + 1 }, phone);
    case 'ArrowUp': return clampSize({ ...size, rows: size.rows - 1 }, phone);
    case 'Home': return { cols: 1, rows: 1 };
    case 'End': return { cols: maxCols(phone), rows: MAX_ROWS };
    case 'Enter': case ' ': return 'insert';
    default: return null;
  }
}

export function sizeLabel(s: Size): string {
  return `${s.cols} × ${s.rows}`;
}

export function sizeWords(s: Size): string {
  return `${s.cols} column${s.cols === 1 ? '' : 's'}, ${s.rows} row${s.rows === 1 ? '' : 's'}`;
}
