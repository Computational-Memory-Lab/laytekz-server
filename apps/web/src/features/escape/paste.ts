/**
 * Feature 1 (WP10): pasting plain text in Source mode. Prose is escaped with
 * Visual mode's own rules (visual/clipboard.ts pasteText), except that `&`
 * stays raw at the top level of a table cell; math, comments, verbatim,
 * literal arguments and code take the text as copied, and so do the editor's
 * own copies and text that already looks like LaTeX. The paste lands as
 * copied first and the escaping follows as its own undo step, so one ⌘Z (or
 * Backspace right after) leaves the text exactly as copied.
 *
 * ⌘⇧V / Ctrl+Shift+V (the browsers' "paste as plain text" chord) pastes
 * exactly as copied in both modes: a keydown observer notes the chord and
 * the paste handler that follows reads it.
 */
import { Prec, type EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { contextAt } from '../../editor/texContext';
import { applyExplicitEdit, autoEditMark } from '../../editor/core/autoEdit';
import { showAutoEditNotice } from '../../editor/core/notices';
import { isOwnCopy, pasteText } from '../../editor/visual/clipboard';
import { looksLikeLatex } from '../../editor/visual/html2latex';
import { matchesShortcut } from '../../keys/registry';
import { ESCAPE_SETTING } from './rules';

export const PASTE_RAW_BINDING = 'escape.pasteRaw';
/** A private-use character stands in for a table's `&` while the rest is escaped. */
const CELL_SEP = '';
/** How long after the raw-paste chord its paste event may arrive. */
const RAW_WINDOW_MS = 1000;

/**
 * What pasting `text` at `pos` should store, or null to paste it as copied.
 * `escapeProse` is pasteText's plain-text path (injectable for tests).
 */
export function escapedPaste(state: EditorState, pos: number, text: string,
  escapeProse: (text: string, doc: string) => string | null = (t, doc) => pasteText('', t, doc)): string | null {
  if (!text || isOwnCopy(text) || looksLikeLatex(text)) return null;
  const cx = contextAt(state, pos);
  if (!cx || (cx.kind !== 'text' && cx.kind !== 'table')) return null;
  const doc = state.doc.toString();
  if (cx.kind === 'table') {
    if (text.includes(CELL_SEP)) return null;
    const out = escapeProse(text.replace(/&/g, CELL_SEP), doc);
    if (out == null) return null;
    const back = out.split(CELL_SEP).join('&');
    return back === text ? null : back;
  }
  const out = escapeProse(text, doc);
  return out == null || out === text ? null : out;
}

let rawChordAt = -Infinity;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Notes the raw-paste chord; the browser's own paste follows it. */
const rawChordObserver = EditorView.domEventObservers({
  keydown(e) {
    try {
      if (matchesShortcut(e, PASTE_RAW_BINDING)) rawChordAt = now();
    } catch { /* no registry: the chord is not known here */ }
  },
});

function takeRawChord(): boolean {
  const raw = now() - rawChordAt < RAW_WINDOW_MS;
  rawChordAt = -Infinity;
  return raw;
}

function insertAsCopied(view: EditorView, text: string): void {
  view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true });
}

/** Pastes `text` as copied, then its escaped form as a separate, revertible step. */
export function pasteEscaped(view: EditorView, text: string, escaped: string): void {
  const from = view.state.selection.main.from;
  insertAsCopied(view, text);
  applyExplicitEdit(view, {
    changes: { from, to: from + text.length, insert: escaped },
    selection: { anchor: from + escaped.length },
    annotations: autoEditMark.of(ESCAPE_SETTING.paste),
    scrollIntoView: true,
  });
  showAutoEditNotice(view.state, {
    kind: ESCAPE_SETTING.paste,
    text: 'Pasted text was escaped for LaTeX. Backspace undoes it, and ⌘⇧V (Ctrl+Shift+V) pastes exactly as copied.',
    settingId: ESCAPE_SETTING.paste,
  });
}

/**
 * The paste handler. `escape` is false when the paste setting is off or the
 * editor is in Visual mode (which keeps its own paste); the raw chord still works then.
 */
export function pasteExtension(escape: boolean): Extension {
  return [
    rawChordObserver,
    Prec.highest(EditorView.domEventHandlers({
      paste(e, view) {
        // Line breaks as the document stores them, so the pasted range's length is the text's.
        const text = e.clipboardData?.getData('text/plain').replace(/\r\n?/g, '\n') ?? '';
        if (!text) return false;
        const raw = takeRawChord();
        if (view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
        if (raw) {
          insertAsCopied(view, text);
          return true;
        }
        if (!escape) return false;
        let escaped: string | null = null;
        try {
          escaped = escapedPaste(view.state, view.state.selection.main.from, text);
        } catch (err) {
          console.warn('Escaping the paste failed', err);
        }
        if (escaped == null) return false;
        pasteEscaped(view, text, escaped);
        return true;
      },
    })),
  ];
}
