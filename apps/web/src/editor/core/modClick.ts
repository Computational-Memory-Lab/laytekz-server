/**
 * Mod-click (WP04 input-core): ⌘-click on a Mac, Ctrl-click elsewhere,
 * follows what a feature's ModClickHandler recognises under the pointer (a
 * link, a label, a file). Over anything else the click adds a cursor, as
 * CodeMirror always did; with Alt it always does (the escape hatch).
 */
import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, showTooltip, type Tooltip } from '@codemirror/view';
import { isMac } from '../../platform';
import { matchesShortcut } from '../../keys/registry';
import type { ModClickHandler, ModClickTarget } from './types';

/** Features provide `modClick.of(handler)` (the editor host does it for
 *  EditorContribution.modClick, inside the feature's compartment). */
export const modClick: Facet<ModClickHandler, readonly ModClickHandler[]> = Facet.define<ModClickHandler>();

/** The keybinding (keys/registry.ts, default Alt+Enter) that follows at the caret. */
export const FOLLOW_BINDING = 'follow';
/** A press that travels further than this before its click is a drag, not a follow. */
export const MOD_CLICK_DRAG_PX = 5;
/** The hint comes this long after the underline, so a passing pointer shows no tooltip. */
export const HINT_DELAY_MS = 300;

export interface PickedTarget { handler: ModClickHandler; target: ModClickTarget }

const sortedCache = new WeakMap<readonly ModClickHandler[], readonly ModClickHandler[]>();

/** The handlers in `state`, highest priority first (ties keep facet order). */
export function modClickHandlers(state: EditorState): readonly ModClickHandler[] {
  const all = state.facet(modClick);
  let sorted = sortedCache.get(all);
  if (!sorted) {
    sorted = [...all].sort((a, b) => b.priority - a.priority);
    sortedCache.set(all, sorted);
  }
  return sorted;
}

function validTarget(t: ModClickTarget | null | undefined, length: number): t is ModClickTarget {
  return !!t && Number.isInteger(t.from) && Number.isInteger(t.to) && t.from >= 0 && t.from <= t.to && t.to <= length && typeof t.title === 'string';
}

/** The first handler, by priority, with a target at `pos`. A handler that
 *  throws or answers with a malformed span is skipped with a warning. */
export function pickTarget(handlers: readonly ModClickHandler[], view: EditorView, pos: number): PickedTarget | null {
  const length = view.state.doc.length;
  for (const handler of handlers) {
    try {
      const target = handler.target(view, pos);
      if (target == null) continue;
      if (validTarget(target, length)) return { handler, target };
      console.warn(`Mod-click ${handler.id}: malformed target`, target);
    } catch (err) {
      console.warn(`Mod-click ${handler.id}: target() failed`, err);
    }
  }
  return null;
}

/** What a mod-click at `pos` would follow, or null (a plain cursor). Visual
 *  widgets ask it before taking a mousedown, so they yield to a follow. */
export function modClickTargetAt(view: EditorView, pos: number): PickedTarget | null {
  const handlers = modClickHandlers(view.state);
  return handlers.length ? pickTarget(handlers, view, pos) : null;
}

/** The modifier that follows: ⌘ (without Ctrl, which makes a Mac's click a
 *  right-click) on a Mac, Ctrl elsewhere; never with Alt. */
export function modClickHeld(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }, mac = isMac): boolean {
  if (e.altKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey;
}

/** A mousedown that may follow: the main button with the modifier. */
export function isModClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, mac = isMac): boolean {
  return e.button === 0 && modClickHeld(e, mac);
}

/** The click lands within the drag threshold of its mousedown. */
export function withinDrag(down: { x: number; y: number }, up: { x: number; y: number }, px = MOD_CLICK_DRAG_PX): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= px;
}

// ---- The underline and the hint ----

interface Hover { from: number; to: number; title: string; error?: string; hint: boolean }

const setHover = StateEffect.define<Hover | null>();

const sameSpan = (a: Hover | null, t: ModClickTarget) => !!a && a.from === t.from && a.to === t.to && a.title === t.title && a.error === t.error;

function hintTooltip(h: Hover, length: number): Tooltip {
  return {
    pos: Math.min(h.from, length),
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-modclick-hint';
      dom.setAttribute('data-testid', 'modclick-hint');
      // Titles come from document text (URLs, labels): text nodes only.
      const title = document.createElement('div');
      title.textContent = h.title;
      dom.appendChild(title);
      const how = document.createElement('div');
      how.className = h.error ? 'cm-modclick-hint__error' : 'cm-modclick-hint__how';
      how.textContent = h.error ?? `${isMac ? '⌘' : 'Ctrl'}-click to follow`;
      dom.appendChild(how);
      return { dom };
    },
  };
}

const hoverField = StateField.define<Hover | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHover)) return e.value;
    return value && (tr.docChanged || tr.selection) ? null : value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (h) => (h && h.to > h.from
      ? Decoration.set([Decoration.mark({ class: h.error ? 'cm-modclick-target cm-modclick-target--error' : 'cm-modclick-target' }).range(h.from, h.to)])
      : Decoration.none)),
    showTooltip.compute([f], (s) => {
      const h = s.field(f);
      return h?.hint ? hintTooltip(h, s.doc.length) : null;
    }),
  ],
});

function showHint(view: EditorView, t: ModClickTarget): void {
  view.dispatch({ effects: setHover.of({ from: t.from, to: t.to, title: t.title, error: t.error, hint: true }) });
}

function follow(view: EditorView, picked: PickedTarget, e: MouseEvent | KeyboardEvent): void {
  // Recognised but not followable: say why instead.
  if (picked.target.error) { showHint(view, picked.target); return; }
  try {
    picked.handler.run(view, picked.target, e);
  } catch (err) {
    console.warn(`Mod-click ${picked.handler.id}: run() failed`, err);
  }
}

/** Follows the target at the caret (Alt+Enter, or a palette command with no
 *  event of its own); false when there is none, so the key does what it did. */
export function followAtCaret(view: EditorView, e?: KeyboardEvent): boolean {
  const picked = modClickTargetAt(view, view.state.selection.main.head);
  if (!picked) return false;
  follow(view, picked, e ?? new KeyboardEvent('keydown', { key: 'Enter', altKey: true }));
  return true;
}

class ModClickPlugin {
  /** The pointer over the text, in client coordinates; null outside it. */
  pointer: { x: number; y: number } | null = null;
  held = false;
  pending: { picked: PickedTarget; x: number; y: number } | null = null;
  frame = 0;
  hintTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly view: EditorView) {
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKey, true);
    window.addEventListener('blur', this.onBlur);
  }

  // The modifier can go down while focus is elsewhere (the PDF, the tree): window, not the editor.
  onKey = (e: KeyboardEvent) => {
    const held = modClickHeld(e);
    if (held === this.held) return;
    this.held = held;
    this.schedule();
  };

  onBlur = () => {
    this.held = false;
    this.pending = null;
    this.schedule();
  };

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.refresh(); });
  }

  refresh(): void {
    const view = this.view;
    const current = view.state.field(hoverField, false) ?? null;
    const picked = this.held && this.pointer ? this.targetAt(this.pointer) : null;
    if (!picked) {
      clearTimeout(this.hintTimer);
      if (current) view.dispatch({ effects: setHover.of(null) });
      return;
    }
    const t = picked.target;
    if (sameSpan(current, t)) return;
    view.dispatch({ effects: setHover.of({ from: t.from, to: t.to, title: t.title, error: t.error, hint: false }) });
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      const now = view.state.field(hoverField, false) ?? null;
      if (now && !now.hint && sameSpan(now, t)) view.dispatch({ effects: setHover.of({ ...now, hint: true }) });
    }, HINT_DELAY_MS);
  }

  targetAt(p: { x: number; y: number }): PickedTarget | null {
    const pos = this.view.posAtCoords(p);
    return pos == null ? null : modClickTargetAt(this.view, pos);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
    window.removeEventListener('blur', this.onBlur);
    if (this.frame) cancelAnimationFrame(this.frame);
    clearTimeout(this.hintTimer);
  }
}

const modClickPlugin = ViewPlugin.fromClass(ModClickPlugin, {
  eventHandlers: {
    mousemove(e) {
      this.pointer = { x: e.clientX, y: e.clientY };
      const held = modClickHeld(e);
      // Nothing to do while no modifier is held and nothing is underlined.
      if (!held && !this.held && !this.view.state.field(hoverField, false)) return false;
      this.held = held;
      this.schedule();
      return false;
    },
    mouseleave() {
      this.pointer = null;
      this.schedule();
      return false;
    },
    mousedown(e) {
      this.pending = null;
      if (!isModClick(e)) return false;
      const picked = this.targetAt({ x: e.clientX, y: e.clientY });
      if (!picked) return false;
      // No added cursor, no focus change, no drag selection: the click follows.
      e.preventDefault();
      this.pending = { picked, x: e.clientX, y: e.clientY };
      return true;
    },
    click(e, view) {
      const p = this.pending;
      this.pending = null;
      if (!p || !withinDrag(p, { x: e.clientX, y: e.clientY })) return false;
      // On click, not mousedown: the user activation a popup blocker wants is still fresh.
      e.preventDefault();
      follow(view, p.picked, e);
      return true;
    },
    keydown(e, view) {
      if (!matchesShortcut(e, FOLLOW_BINDING)) return false;
      return followAtCaret(view, e);
    },
  },
});

const modClickTheme = EditorView.baseTheme({
  '.cm-modclick-target': { textDecoration: 'underline', textUnderlineOffset: '2px', cursor: 'pointer' },
  '.cm-modclick-target--error': { textDecorationColor: 'var(--error, #c62828)', textDecorationStyle: 'dotted', cursor: 'default' },
  '.cm-tooltip.cm-modclick-hint': { padding: '4px 8px', maxWidth: '36em', overflowWrap: 'anywhere', fontFamily: 'var(--font-ui, system-ui)', fontSize: 'var(--text-xs, 12px)' },
  '.cm-modclick-hint__how': { color: 'var(--text-3, #777)' },
  '.cm-modclick-hint__error': { color: 'var(--error, #c62828)' },
});

/** The arbiter: a modifier mousedown over a target prevents the added cursor,
 *  the follow runs on click, the hint shows while the modifier is held,
 *  Alt+Enter follows at the caret. The editor host installs it once. */
export function modClickExtension(): Extension {
  return [hoverField, Prec.highest(modClickPlugin), modClickTheme];
}
