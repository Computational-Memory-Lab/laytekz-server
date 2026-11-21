/**
 * The rows of the highlighter's menus (WP37): the split button's dropdown
 * and the right-click entry share the colour rows.
 */
import { createElement, type ReactNode } from 'react';
import type { MenuEntry } from '../../components/Menu';
import { PRESETS, colorName, isPreset } from './model';
import { cleanCustomList } from './colors';

export function swatchIcon(color: string): ReactNode {
  return createElement('span', {
    className: `hl-swatch hl-swatch--${isPreset(color) ? color : 'custom'}`,
    style: isPreset(color) ? undefined : { ['--hl' as string]: color },
    'aria-hidden': true,
  });
}

export interface ColorRowsOptions {
  current: string;
  custom: unknown;
  /** Paints with the colour (and makes it the current one). */
  pick(color: string): void;
  /** Opens "Custom colour…". */
  custom_(): void;
  /** Test id prefix: 'highlight-option' (dropdown) or 'editor-menu-highlight' (right-click). */
  prefix: string;
}

/** Six presets, "Your colours", and "Custom colour…". */
export function colorRows(o: ColorRowsOptions): MenuEntry[] {
  const rows: MenuEntry[] = PRESETS.map((p) => ({
    id: `${o.prefix}-${p}`,
    label: colorName(p),
    icon: swatchIcon(p),
    role: 'radio' as const,
    checked: o.current === p,
    testId: `${o.prefix}-${p}`,
    onSelect: () => o.pick(p),
  }));
  const yours = cleanCustomList(o.custom);
  if (yours.length) {
    rows.push({ kind: 'label', id: `${o.prefix}-yours`, label: 'Your colours' });
    for (const c of yours) {
      rows.push({
        id: `${o.prefix}-${c.slice(1)}`, label: c, icon: swatchIcon(c), role: 'radio', checked: o.current === c,
        testId: `${o.prefix}-${c.slice(1)}`, onSelect: () => o.pick(c),
      });
    }
  }
  rows.push({ id: `${o.prefix}-custom`, label: 'Custom colour…', testId: `${o.prefix}-custom`, onSelect: o.custom_ });
  return rows;
}

export interface DropdownState {
  current: string;
  custom: unknown;
  canWrite: boolean;
  hasSelection: boolean;
  selectionHasHighlight: boolean;
  hasHighlights: boolean;
  hasMine: boolean;
}

export interface DropdownActions {
  pick(color: string): void;
  custom(): void;
  erase(): void;
  clearMine(): void;
  clearAll(): void;
  step(dir: 1 | -1): void;
  showList(): void;
  settings(): void;
}

/** The split button's dropdown. */
export function dropdownItems(s: DropdownState, a: DropdownActions): MenuEntry[] {
  const rows: MenuEntry[] = [];
  if (s.canWrite) {
    rows.push(...colorRows({ current: s.current, custom: s.custom, pick: a.pick, custom_: a.custom, prefix: 'highlight-option' }));
    rows.push({ kind: 'separator' });
    rows.push({ id: 'erase', label: 'Remove highlights in selection', disabled: !s.selectionHasHighlight, testId: 'highlight-option-erase', onSelect: a.erase });
    rows.push({ id: 'clear-mine', label: 'Clear my highlights in this file', disabled: !s.hasMine, testId: 'highlight-option-clear-mine', onSelect: a.clearMine });
    rows.push({ id: 'clear-all', label: 'Clear all highlights in this file…', danger: true, disabled: !s.hasHighlights, testId: 'highlight-option-clear-all', onSelect: a.clearAll });
    rows.push({ kind: 'separator' });
  }
  rows.push({ id: 'next', label: 'Go to next highlight', disabled: !s.hasHighlights, testId: 'highlight-option-next', onSelect: () => a.step(1) });
  rows.push({ id: 'prev', label: 'Go to previous highlight', disabled: !s.hasHighlights, testId: 'highlight-option-prev', onSelect: () => a.step(-1) });
  rows.push({ id: 'list', label: 'Show highlights list', testId: 'highlight-option-list', onSelect: a.showList });
  rows.push({ id: 'settings', label: 'Highlighter settings…', testId: 'highlight-option-settings', onSelect: a.settings });
  rows.push({
    kind: 'hint', id: 'hint', testId: 'highlight-option-hint',
    label: 'Highlights mark the source for you and your co-authors. They are not part of the LaTeX, the PDF, the ZIP download or the history.',
  });
  return rows;
}

/** The right-click entry's rows, or null when the menu should not offer them. */
export function contextItems(s: Omit<DropdownState, 'hasHighlights' | 'hasMine'> & { shortcut: string }, a: Pick<DropdownActions, 'pick' | 'custom' | 'erase'>): MenuEntry[] | null {
  if (!s.canWrite || !s.hasSelection) return null;
  const rows: MenuEntry[] = [
    {
      id: 'highlight', label: `Highlight ${colorName(s.current).toLowerCase()}`, icon: swatchIcon(s.current),
      shortcut: s.shortcut || undefined, testId: 'editor-menu-highlight', onSelect: () => a.pick(s.current),
    },
    {
      kind: 'submenu', id: 'highlight-colour', label: 'Highlight colour', testId: 'editor-menu-highlight-colour',
      items: colorRows({ current: s.current, custom: s.custom, pick: a.pick, custom_: a.custom, prefix: 'editor-menu-highlight' }),
    },
  ];
  if (s.selectionHasHighlight) rows.push({ id: 'highlight-remove', label: 'Remove highlight', testId: 'editor-menu-highlight-remove', onSelect: a.erase });
  return rows;
}
