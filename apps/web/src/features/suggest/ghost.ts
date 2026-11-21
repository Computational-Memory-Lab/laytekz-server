/**
 * The grey suggestion after the caret (WP40). It is a local decoration only:
 * never in the document, the awareness state or Yjs until accepted, so a
 * collaborator never sees it. Tab accepts all of it and Mod-→ the next word,
 * each as one undo step; Escape hides it. Typing its next characters uses it
 * up; any other edit, a caret move, blur, an open completion list or a
 * change on the caret's line from someone else clears it.
 */
import { StateEffect, StateField, Transaction, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { currentCompletions, hasNextSnippetField } from '@codemirror/autocomplete';
import { applyExplicitEdit } from '../../editor/core/autoEdit';

export interface Ghost {
  /** The caret position the text is drawn at. */
  pos: number;
  /** One line, never empty. */
  text: string;
}

/** Sets (or, with null, clears) the suggestion; positions are in the transaction's new document. */
export const setGhost = StateEffect.define<Ghost | null>();

/** The user event of an accepted suggestion (a completion, so closers it brings stay tracked). */
export const ACCEPT_EVENT = 'input.complete';

function valid(g: Ghost | null, state: EditorState): Ghost | null {
  if (!g || !g.text || g.text.includes('\n') || g.pos < 0 || g.pos > state.doc.length) return null;
  return g;
}

/** The suggestion after a local keystroke that typed its next characters, or null. */
function typedThrough(g: Ghost, tr: Transaction): Ghost | null {
  const parts: { fromA: number; toA: number; text: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => { parts.push({ fromA, toA, text: inserted.toString() }); });
  const sel = tr.state.selection;
  if (parts.length !== 1 || sel.ranges.length !== 1) return null;
  const { fromA, toA, text: t } = parts[0];
  if (fromA !== g.pos || toA !== g.pos || !t || !g.text.startsWith(t) || sel.main.head !== g.pos + t.length) return null;
  return t.length < g.text.length ? { pos: g.pos + t.length, text: g.text.slice(t.length) } : null;
}

/**
 * A completion list is on screen. Not the completion status: with
 * completions shown as you type, every typed letter leaves the sources
 * pending until their query returns, though no list opens in prose.
 */
export function completionListOpen(state: EditorState): boolean {
  return currentCompletions(state).length > 0;
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: GhostWidget) { return other.text === this.text; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ghost';
    span.setAttribute('data-testid', 'ghost-text');
    span.setAttribute('aria-hidden', 'true');
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() { return false; }
}

export const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(g, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return valid(e.value, tr.state);
    if (!g) return null;
    if (completionListOpen(tr.state)) return null;
    if (tr.docChanged) {
      if (tr.isUserEvent('input.type')) return typedThrough(g, tr);
      // any other local edit (paste, delete, undo key, a command) carries a user event
      if (tr.annotation(Transaction.userEvent) !== undefined) return null;
      // a collaborator's change (or a reload): cleared on the caret's line, kept elsewhere
      const line = tr.startState.doc.lineAt(g.pos);
      if (tr.changes.touchesRange(line.from, line.to)) return null;
      const pos = tr.changes.mapPos(g.pos, 1);
      const sel = tr.state.selection;
      return sel.ranges.length === 1 && sel.main.empty && sel.main.head === pos ? { pos, text: g.text } : null;
    }
    if (tr.selection) {
      const sel = tr.state.selection;
      if (sel.ranges.length !== 1 || !sel.main.empty || sel.main.head !== g.pos) return null;
    }
    return g;
  },
  provide: (f) => EditorView.decorations.from(f, (g) => (g
    ? Decoration.set([Decoration.widget({ widget: new GhostWidget(g.text), side: 1 }).range(g.pos)])
    : Decoration.none)),
});

const ghostTheme = EditorView.baseTheme({
  '.cm-ghost': { color: 'var(--text-3, #8b8b8b)', opacity: '0.9', pointerEvents: 'none', whiteSpace: 'pre' },
});

/** The field, its drawing, and clearing on blur. */
export function ghostExtension(): Extension {
  return [
    ghostField,
    ghostTheme,
    EditorView.focusChangeEffect.of((state, focusing) => (!focusing && state.field(ghostField, false) ? setGhost.of(null) : null)),
  ];
}

/** The suggestion Tab or Mod-→ may take now: at a lone caret, with no completion list or snippet field owning the key. */
export function ghostAtCaret(state: EditorState): Ghost | null {
  const g = state.field(ghostField, false);
  if (!g || state.readOnly) return null;
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty || sel.main.head !== g.pos) return null;
  if (completionListOpen(state) || hasNextSnippetField(state)) return null;
  return g;
}

/** Tab: inserts the whole suggestion as one undo step. */
export function acceptGhost(view: EditorView): boolean {
  const g = ghostAtCaret(view.state);
  if (!g) return false;
  applyExplicitEdit(view, {
    changes: { from: g.pos, insert: g.text },
    selection: { anchor: g.pos + g.text.length },
    effects: setGhost.of(null),
    scrollIntoView: true,
  }, ACCEPT_EVENT);
  return true;
}

/** The next word of a suggestion: a `\command`, a run of letters or digits, or one mark and the space after it (leading spaces included). */
export function nextWord(text: string): string {
  const m = /^\s*(?:\\[A-Za-z@]+\*?|[\p{L}\p{N}'’-]+|[^\s\p{L}\p{N}]\s?)/u.exec(text);
  return m && m[0] ? m[0] : text;
}

/** Mod-→: inserts the suggestion's next word as one undo step; the rest stays. */
export function acceptGhostWord(view: EditorView): boolean {
  const g = ghostAtCaret(view.state);
  if (!g) return false;
  const piece = nextWord(g.text);
  const rest = g.text.slice(piece.length);
  const pos = g.pos + piece.length;
  applyExplicitEdit(view, {
    changes: { from: g.pos, insert: piece },
    selection: { anchor: pos },
    effects: setGhost.of(rest ? { pos, text: rest } : null),
    scrollIntoView: true,
  }, ACCEPT_EVENT);
  return true;
}

/** Escape: hides the suggestion (a new one comes only with the next typed character). */
export function dismissGhost(view: EditorView): boolean {
  if (!view.state.field(ghostField, false)) return false;
  view.dispatch({ effects: setGhost.of(null) });
  return true;
}
