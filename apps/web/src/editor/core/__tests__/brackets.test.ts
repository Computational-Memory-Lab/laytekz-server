import { describe, it, expect } from 'vitest';
import { EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { closeBracketsKeymap, insertBracket } from '@codemirror/autocomplete';
import { latexLanguage } from '../language';
import { beginBraceExtensions, bracketExtensions, bracketKeymap } from '../brackets';

/** What typing `ch` at the caret (`|`) leaves, with the bracket extensions of `file`. */
function type(marked: string, ch: string, file = 'main.tex') {
  const at = marked.indexOf('|');
  const state = EditorState.create({ doc: marked.slice(0, at) + marked.slice(at + 1), selection: { anchor: at }, extensions: [latexLanguage(), bracketExtensions(file)] });
  const tr = insertBracket(state, ch);
  const next = tr ? tr.state : state.update({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 } }).state;
  const head = next.selection.main.head, text = next.doc.toString();
  return text.slice(0, head) + '|' + text.slice(head);
}

describe('bracket extensions', () => {
  it('close (, [ and { as V1 did, and " only in a .bib file', () => {
    expect(type('|', '{')).toBe('{|}');
    expect(type('|', '(')).toBe('(|)');
    expect(type('|', '[')).toBe('[|]');
    expect(type('|', '"')).toBe('"|');
    expect(type('title = |', '"', 'refs.bib')).toBe('title = "|"');
  });

  it('keep closeBrackets\' Backspace in the main keymap', () => {
    expect(bracketKeymap).toBe(closeBracketsKeymap);
  });

  it('close a \\begin{…} typed as text once, as V1 did, in V1\'s order', () => {
    const extensions: Extension = [bracketExtensions('main.tex'), latexLanguage(), beginBraceExtensions()];
    let state = EditorState.create({ extensions });
    const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } };
    for (const ch of '\\begin{itemize}') {
      const { from, to } = state.selection.main;
      const handled = state.facet(EditorView.inputHandler).some((h) => h(view as unknown as EditorView, from, to, ch, () => state.update({})));
      if (!handled) view.dispatch(state.replaceSelection(ch));
    }
    const text = state.doc.toString();
    expect(text.startsWith('\\begin{itemize}\n')).toBe(true);
    expect(text.match(/\\end\{itemize\}/g)).toHaveLength(1);
  });
});
