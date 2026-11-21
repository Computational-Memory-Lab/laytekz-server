import { describe, expect, it, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { collectMenu, finishMenu, GROUP_ORDER, menuPolicy, type MenuPolicyInput } from '../policy';
import type { ContextMenuEntry, MenuItemSpec, MenuTarget } from '../types';

// Plan §2.4: when the editor's own menu replaces the native one.
const base: MenuPolicyInput = {
  via: 'mouse', shiftKey: false, defaultPrevented: false, enabled: true, touch: false,
  insideSelection: true, claimed: false, hasItems: true,
};
const opens = (o: Partial<MenuPolicyInput>) => menuPolicy({ ...base, ...o });

describe('the menu policy', () => {
  it('opens on a plain right-click inside a selection that existed before the press', () => {
    expect(opens({})).toBe(true);
  });

  it('opens on a target an entry claims, without a selection', () => {
    expect(opens({ insideSelection: false, claimed: true })).toBe(true);
  });

  it('leaves the native menu (spelling suggestions) everywhere else', () => {
    expect(opens({ insideSelection: false }), 'outside the selection, nothing claimed').toBe(false);
    expect(opens({ shiftKey: true }), 'Shift+right-click').toBe(false);
    expect(opens({ shiftKey: true, claimed: true }), 'Shift wins over a claim').toBe(false);
    expect(opens({ enabled: false }), 'the setting is off').toBe(false);
    expect(opens({ touch: true }), 'a long press').toBe(false);
    expect(opens({ defaultPrevented: true }), 'already handled').toBe(false);
  });

  it('never replaces the native menu with a bare Cut/Copy/Paste', () => {
    expect(opens({ hasItems: false })).toBe(false);
    expect(opens({ hasItems: false, claimed: true })).toBe(false);
  });

  it('opens from Shift+F10 or the Menu key with a selection or a claimed caret, not with the setting off', () => {
    expect(opens({ via: 'keyboard', shiftKey: true })).toBe(true);
    expect(opens({ via: 'keyboard', touch: true })).toBe(true);
    expect(opens({ via: 'keyboard', insideSelection: false, claimed: true })).toBe(true);
    expect(opens({ via: 'keyboard', insideSelection: false })).toBe(false);
    expect(opens({ via: 'keyboard', enabled: false })).toBe(false);
    expect(opens({ via: 'keyboard', hasItems: false })).toBe(false);
  });
});

const target = (o: Partial<MenuTarget> = {}): MenuTarget => ({
  view: {} as EditorView, pos: 5, selection: { from: 2, to: 9, empty: false }, hadSelection: true, ctx: null,
  event: { shiftKey: false } as MouseEvent, page: null, ...o,
});
const item = (id: string): MenuItemSpec => ({ id, label: id, onSelect: () => {} });
const ids = (items: readonly MenuItemSpec[]) => items.map((e) => (e.kind === 'separator' ? '—' : e.kind === 'hint' ? `hint:${e.label}` : 'id' in e ? e.id : '?'));

describe('collecting the entries', () => {
  it('orders by group (link, navigate, annotate, insert, table, format) then order, a separator between groups', () => {
    const entries: ContextMenuEntry[] = [
      { id: 'hl', group: 'annotate', order: 10, items: () => [item('highlight')] },
      { id: 'fmt', group: 'format', order: 0, items: () => [item('bold')] },
      { id: 'link', group: 'link', order: 0, items: () => [item('open'), item('copy-link')] },
      { id: 'note', group: 'annotate', order: 5, items: () => [item('comment')] },
      { id: 'none', group: 'table', order: 0, items: () => null },
    ];
    expect(GROUP_ORDER).toEqual(['link', 'navigate', 'annotate', 'insert', 'table', 'format']);
    expect(ids(collectMenu(entries, target()).items)).toEqual(['open', 'copy-link', '—', 'comment', 'highlight', '—', 'bold']);
  });

  it('reports a claim even from an entry with nothing to add here', () => {
    const entries: ContextMenuEntry[] = [{ id: 'link', group: 'link', order: 0, claims: (t) => t.pos === 5, items: () => [] }];
    expect(collectMenu(entries, target())).toEqual({ claimed: true, items: [] });
    expect(collectMenu(entries, target({ pos: 1 })).claimed).toBe(false);
  });

  it('hands every entry the same target, and skips one that throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: MenuTarget[] = [];
    const t = target({ hadSelection: false });
    const entries: ContextMenuEntry[] = [
      { id: 'boom', group: 'link', order: 0, claims: () => { throw new Error('boom'); }, items: () => [item('never')] },
      { id: 'ok', group: 'insert', order: 0, items: (x) => { seen.push(x); return x.hadSelection ? null : [item('label-here')]; } },
    ];
    expect(ids(collectMenu(entries, t).items)).toEqual(['label-here']);
    expect(seen[0]).toBe(t);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('the rows every menu ends with', () => {
  const actions = { cut: vi.fn(), copy: vi.fn(), paste: vi.fn() };

  it('are Cut, Copy and Paste after a separator, with the platform\'s keys, and the way to the native menu', () => {
    const rows = finishMenu([item('highlight')], { selectionEmpty: false, readOnly: false, via: 'mouse', mac: true, actions });
    expect(ids(rows)).toEqual(['highlight', '—', 'cut', 'copy', 'paste', 'hint:Shift+right-click for the standard menu']);
    const cut = rows[2] as Extract<MenuItemSpec, { id: string; onSelect(): void }>;
    expect(cut.shortcut).toBe('⌘X');
    expect(cut.testId).toBe('editor-menu-cut');
    cut.onSelect();
    expect(actions.cut).toHaveBeenCalledOnce();
    const win = finishMenu([], { selectionEmpty: false, readOnly: false, via: 'keyboard', mac: false, actions });
    expect(ids(win)).toEqual(['cut', 'copy', 'paste']);
    expect((win[2] as { shortcut?: string }).shortcut).toBe('Ctrl+V');
  });

  it('disable Cut and Copy without a selection, and Cut and Paste in a read-only file', () => {
    const state = (o: { selectionEmpty: boolean; readOnly: boolean }) =>
      Object.fromEntries(finishMenu([], { ...o, via: 'keyboard', mac: true, actions }).map((e) => ['id' in e ? e.id : '', !!(e as { disabled?: boolean }).disabled]));
    expect(state({ selectionEmpty: true, readOnly: false })).toEqual({ cut: true, copy: true, paste: false });
    expect(state({ selectionEmpty: false, readOnly: true })).toEqual({ cut: true, copy: false, paste: true });
  });
});
