/**
 * The editor's context-menu host (WP04 input-core). A plain right-click inside
 * a selection that existed before the press, or on something an entry claims,
 * opens the app menu when some entry has items; otherwise (and always with
 * Shift, on touch, with the setting off, or when the event was handled) the
 * event is left alone and the native menu appears as before. The policy is
 * contextmenu/policy.ts; plan §2.4 and docs/galley-v2/README.md D2.
 */
import type { Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import type { ContextMenuEntry, MenuTarget } from './types';
import type { EditorPageCtx } from '../features/types';
import { collectMenu, finishMenu, menuPolicy, type MenuPolicyInput } from './policy';
import { openMenu, type MenuAnchor } from '../components/Menu';
import { contextAt } from '../editor/texContext';
import { getSetting } from '../settings/store';
import { CORE_SETTING_IDS } from '../settings/types';
import { isMac } from '../platform';

export { collectMenu, finishMenu, menuPolicy } from './policy';
export type { MenuPolicyInput } from './policy';

/** The press and its contextmenu event arrive together; an older press is not this menu's. */
const PRESS_MS = 1500;

/** The `editor.contextMenu` setting; on when the store cannot say. */
function enabled(): boolean {
  try { return getSetting<boolean>(CORE_SETTING_IDS.contextMenu) !== false; } catch { return true; }
}

function safeContext(view: EditorView, pos: number): MenuTarget['ctx'] {
  try { return contextAt(view.state, pos); } catch { return null; }
}

function safePage(page: () => EditorPageCtx | null): EditorPageCtx | null {
  try { return page(); } catch { return null; }
}

interface Press { from: number; to: number; pos: number; at: number }

class ContextMenuHost {
  /** The selection and the position under the pointer when a right button went down, before the browser moves either. */
  press: Press | null = null;
  touch = false;
  menu: { close(): void } | null = null;

  constructor(readonly view: EditorView, readonly entries: readonly ContextMenuEntry[], readonly page: () => EditorPageCtx | null) {}

  record(e: MouseEvent): void {
    const sel = this.view.state.selection.main;
    const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? sel.head;
    this.press = { from: sel.from, to: sel.to, pos, at: Date.now() };
  }

  /** Builds the menu for `pos` and opens it when the policy says so; false leaves the event to the browser. */
  open(e: MouseEvent | KeyboardEvent, via: 'mouse' | 'keyboard', pos: number, sel: { from: number; to: number }, anchor: MenuAnchor): boolean {
    const view = this.view;
    const hadSelection = sel.to > sel.from;
    const insideSelection = hadSelection && pos >= sel.from && pos <= sel.to;
    const target: MenuTarget = {
      view,
      pos,
      selection: { from: sel.from, to: sel.to, empty: !hadSelection },
      // Entries act on the selection only when the menu opened inside it.
      hadSelection: insideSelection,
      ctx: safeContext(view, pos),
      event: e,
      page: safePage(this.page),
    };
    const collected = collectMenu(this.entries, target);
    const input: MenuPolicyInput = {
      via,
      shiftKey: e.shiftKey,
      defaultPrevented: e.defaultPrevented,
      enabled: enabled(),
      touch: this.touch,
      insideSelection,
      claimed: collected.claimed,
      hasItems: collected.items.length > 0,
    };
    if (!menuPolicy(input)) return false;
    e.preventDefault();
    // A Mac's Control-click (or Chrome selecting the word under a right-click)
    // may have moved the selection the menu acts on: put the recorded one back.
    const now = view.state.selection.main;
    if (insideSelection && (now.from !== sel.from || now.to !== sel.to)) view.dispatch({ selection: { anchor: sel.from, head: sel.to } });
    const items = finishMenu(collected.items, {
      selectionEmpty: !hadSelection,
      readOnly: view.state.readOnly,
      via,
      mac: isMac,
      actions: { cut: () => clipboard(view, 'cut'), copy: () => clipboard(view, 'copy'), paste: () => void paste(view, this.page) },
    });
    this.menu?.close();
    this.menu = openMenu({
      items,
      anchor,
      label: 'Editor',
      testId: 'editor-context-menu',
      initialFocus: via === 'keyboard' ? 'first' : 'menu',
      instant: via === 'keyboard',
      returnFocus: view.contentDOM,
      onClose: () => { this.menu = null; },
    });
    return true;
  }

  destroy(): void {
    this.menu?.close();
  }
}

/** Cut and Copy through the browser's own command, so CodeMirror's clipboard filters (own-copy memory, Visual) run. */
function clipboard(view: EditorView, which: 'cut' | 'copy'): void {
  view.focus();
  document.execCommand(which);
}

/** Paste reads the clipboard and hands it to the editor as a paste event, so Visual's paste and the input filters run. */
async function paste(view: EditorView, page: () => EditorPageCtx | null): Promise<void> {
  view.focus();
  try {
    const text = await navigator.clipboard.readText();
    const data = new DataTransfer();
    data.setData('text/plain', text);
    view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  } catch {
    safePage(page)?.toast(`The browser blocked pasting from this menu. Press ${isMac ? '⌘V' : 'Ctrl+V'}.`, 'info');
  }
}

const isMenuKey = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey
  && ((e.key === 'ContextMenu' && !e.shiftKey) || (e.key === 'F10' && e.shiftKey));

export function contextMenuExtension(entries: readonly ContextMenuEntry[], page: () => EditorPageCtx | null): Extension {
  return ViewPlugin.define((view) => new ContextMenuHost(view, entries, page), {
    eventHandlers: {
      pointerdown(e) {
        this.touch = e.pointerType === 'touch';
        return false;
      },
      mousedown(e) {
        const ctrlClick = isMac && e.button === 0 && e.ctrlKey;
        // A Mac's Control-click is a right-click too.
        if (e.button === 2 || ctrlClick) this.record(e);
        else this.press = null;
        // CodeMirror reads a Control-click as a click and would collapse the
        // selection on mouseup, after the menu put it back; a native text field
        // keeps it. Only inside the selection, the case the menu acts on.
        const p = this.press;
        if (ctrlClick && p && !e.shiftKey && p.to > p.from && p.pos >= p.from && p.pos <= p.to && enabled()) {
          e.preventDefault();
          return true;
        }
        return false;
      },
      contextmenu(e) {
        const press = this.press;
        this.press = null;
        // Without a fresh press it came from the keyboard (handled on keydown) or a script: leave it.
        if (!press || Date.now() - press.at > PRESS_MS) return false;
        return this.open(e, 'mouse', press.pos, press, { type: 'point', x: e.clientX, y: e.clientY });
      },
      keydown(e, view) {
        if (!isMenuKey(e)) return false;
        const sel = view.state.selection.main;
        const at = view.coordsAtPos(sel.head) ?? view.contentDOM.getBoundingClientRect();
        return this.open(e, 'keyboard', sel.head, sel, { type: 'point', x: at.left, y: at.bottom });
      },
    },
  });
}
