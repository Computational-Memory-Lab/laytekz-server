/**
 * Tab stops (WP31): while a completion's snippet fields are active, Tab and
 * Shift+Tab move between them and Escape leaves them. The key chains run
 * before CodeMirror's own snippet keymap (both are Prec.highest; the chains
 * were installed first), so these entries take Tab at 90 (above the pairs
 * feature's step-out at 72 and indenting at 0).
 */
import { clearSnippet, hasNextSnippetField, hasPrevSnippetField, nextSnippetField, prevSnippetField } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';

export function nextField(view: EditorView): boolean {
  return hasNextSnippetField(view.state) && nextSnippetField(view);
}

export function prevField(view: EditorView): boolean {
  return hasPrevSnippetField(view.state) && prevSnippetField(view);
}

export function leaveFields(view: EditorView): boolean {
  return (hasNextSnippetField(view.state) || hasPrevSnippetField(view.state)) && clearSnippet(view);
}
