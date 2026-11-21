/**
 * When the editor's own right-click menu opens instead of the browser's (or
 * the desktop app's), and what it lists: pure functions, so the policy is
 * tested without a DOM (plan §2.4).
 */
import type { ContextMenuEntry, MenuGroup, MenuItemSpec, MenuTarget } from './types';

export interface MenuPolicyInput {
  /** A right-click (or a Mac's Control-click) or Shift+F10 / the Menu key. */
  via: 'mouse' | 'keyboard';
  shiftKey: boolean;
  /** Something else (a Visual widget, a dialog) already handled the event. */
  defaultPrevented: boolean;
  /** The `editor.contextMenu` setting. */
  enabled: boolean;
  /** The last pointer was a finger: a long press keeps the native menu. */
  touch: boolean;
  /** Mouse: the press landed inside a selection that existed before it.
   *  Keyboard: a selection exists. */
  insideSelection: boolean;
  /** Some entry claims the target (a link under the pointer). */
  claimed: boolean;
  /** Some entry had items to show. */
  hasItems: boolean;
}

/**
 * true: the app menu. false: leave the event alone, so the native menu (with
 * spelling suggestions, Look Up, the desktop app's own items) appears as it
 * always did. With no feature items there is nothing to add over the native
 * menu, so it is never replaced by a bare Cut/Copy/Paste.
 */
export function menuPolicy(i: MenuPolicyInput): boolean {
  if (i.defaultPrevented || !i.enabled || !i.hasItems) return false;
  if (!i.insideSelection && !i.claimed) return false;
  if (i.via === 'keyboard') return true;
  // Shift+right-click is the way back to the native menu.
  return !i.shiftKey && !i.touch;
}

/** Menu groups, top to bottom. */
export const GROUP_ORDER: readonly MenuGroup[] = ['link', 'navigate', 'annotate', 'insert', 'table', 'format'];

export interface CollectedMenu {
  claimed: boolean;
  /** The entries' items, a separator between groups. Empty: nothing to show. */
  items: MenuItemSpec[];
}

const visibleRows = (items: readonly MenuItemSpec[]) => items.some((e) => e.kind !== 'separator');

/** Asks every entry, by group then order. An entry that throws is skipped with a warning. */
export function collectMenu(entries: readonly ContextMenuEntry[], t: MenuTarget): CollectedMenu {
  const rank = (e: ContextMenuEntry) => GROUP_ORDER.indexOf(e.group);
  const ordered = [...entries].sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  let claimed = false;
  const groups = new Map<MenuGroup, MenuItemSpec[]>();
  for (const entry of ordered) {
    try {
      if (entry.claims?.(t)) claimed = true;
      const items = entry.items(t);
      if (!items || !visibleRows(items)) continue;
      // Entries of one group run together; a separator comes only between groups.
      groups.set(entry.group, [...(groups.get(entry.group) ?? []), ...items]);
    } catch (err) {
      console.warn(`Context menu ${entry.id} failed`, err);
    }
  }
  const items: MenuItemSpec[] = [];
  for (const g of GROUP_ORDER) {
    const list = groups.get(g);
    if (!list?.length) continue;
    if (items.length) items.push({ kind: 'separator', id: `group-${g}` });
    items.push(...list);
  }
  return { claimed, items };
}

export interface StandardActions {
  cut(): void;
  copy(): void;
  paste(): void;
}

/** The rows every editor menu ends with: Cut, Copy (through execCommand, so
 *  the editor's clipboard filters run) and Paste; a mouse-opened menu also
 *  names the way to the native menu. */
export function finishMenu(items: readonly MenuItemSpec[], o: { selectionEmpty: boolean; readOnly: boolean; via: 'mouse' | 'keyboard'; mac: boolean; actions: StandardActions }): MenuItemSpec[] {
  const mod = (k: string) => (o.mac ? `⌘${k}` : `Ctrl+${k}`);
  const out: MenuItemSpec[] = [...items];
  if (out.length) out.push({ kind: 'separator', id: 'clipboard-sep' });
  out.push(
    { id: 'cut', label: 'Cut', shortcut: mod('X'), disabled: o.selectionEmpty || o.readOnly, onSelect: o.actions.cut, testId: 'editor-menu-cut' },
    { id: 'copy', label: 'Copy', shortcut: mod('C'), disabled: o.selectionEmpty, onSelect: o.actions.copy, testId: 'editor-menu-copy' },
    { id: 'paste', label: 'Paste', shortcut: mod('V'), disabled: o.readOnly, onSelect: o.actions.paste, testId: 'editor-menu-paste' },
  );
  if (o.via === 'mouse') out.push({ kind: 'hint', id: 'native-hint', label: 'Shift+right-click for the standard menu', testId: 'editor-menu-native-hint' });
  return out;
}
