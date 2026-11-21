import { describe, it, expect } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { closeBrackets } from '@codemirror/autocomplete';
import { closeBeginBraceInput } from '../beginEnv';
// Galley: V2 (WP31) the scans and the planner behind the one closer.
import { envCloseOwned, envNameAt, envPartner, innermostOpenEnv, planEnvClose } from '../beginEnv';

/** Text typed as input events, as a `}` needing Option arrives: no key
 *  binding runs, only the input handlers, then the plain insertion. */
function typeText(doc: string, text: string, extensions = [closeBeginBraceInput, closeBrackets()]) {
  let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions });
  const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } };
  for (const ch of text) {
    const { from, to } = state.selection.main;
    const handled = state.facet(EditorView.inputHandler).some((h) => h(view as unknown as EditorView, from, to, ch, () => state.update({})));
    if (!handled) view.dispatch(state.replaceSelection(ch));
  }
  return state;
}

describe('closing \\begin{…} with a } typed as text', () => {
  it('closes the environment once when the } needs Option', () => {
    const s = typeText('', '\\begin{itemize}');
    expect(s.doc.toString()).toBe('\\begin{itemize}\n  \n\\end{itemize}');
    expect(s.selection.main.head).toBe('\\begin{itemize}\n  '.length);
  });

  it('keeps the indentation of the line', () => {
    const s = typeText('  ', '\\begin{enumerate}');
    expect(s.doc.toString()).toBe('  \\begin{enumerate}\n    \n  \\end{enumerate}');
  });

  it('only steps over the brace anywhere else', () => {
    expect(typeText('', '\\textbf{x}').doc.toString()).toBe('\\textbf{x}');
  });

  it('left out, closeBrackets steps over the brace and the environment stays open', () => {
    expect(typeText('', '\\begin{itemize}', [closeBrackets()]).doc.toString()).toBe('\\begin{itemize}');
  });
});

// Galley: V2 (WP31) one closer for every path: no second \end, and the envclose feature takes over.
describe('closing \\begin{…} without the envclose feature (WP31)', () => {
  it('closes without closeBrackets too (the brace is inserted)', () => {
    expect(typeText('', '\\begin{itemize}', [closeBeginBraceInput]).doc.toString()).toBe('\\begin{itemize}\n  \n\\end{itemize}');
  });

  it('adds no second \\end when one is waiting', () => {
    const doc = '\\begin{document}\n\n\\item a\n\\end{itemize}\n\\end{document}';
    let state = EditorState.create({ doc, selection: { anchor: '\\begin{document}\n'.length }, extensions: [closeBeginBraceInput, closeBrackets()] });
    const view = { get state() { return state; }, dispatch(spec: TransactionSpec) { state = state.update(spec).state; } };
    for (const ch of '\\begin{itemize}') {
      const { from, to } = state.selection.main;
      const handled = state.facet(EditorView.inputHandler).some((h) => h(view as unknown as EditorView, from, to, ch, () => state.update({})));
      if (!handled) view.dispatch(state.replaceSelection(ch));
    }
    expect(state.doc.toString()).toBe(doc.replace('document}\n', 'document}\n\\begin{itemize}'));
  });

  it('never closes in a comment', () => {
    expect(typeText('', '% \\begin{itemize}').doc.toString()).toBe('% \\begin{itemize}');
  });

  it('stands aside while the envclose feature runs', () => {
    expect(typeText('', '\\begin{itemize}', [envCloseOwned.of(true), closeBeginBraceInput, closeBrackets()]).doc.toString()).toBe('\\begin{itemize}');
  });
});

describe('environment scans (WP31)', () => {
  const state = (doc: string) => EditorState.create({ doc });

  it('pairs \\begin and \\end by position, skipping comments, \\verb and verbatim', () => {
    const doc = '\\begin{a}\n% \\end{a}\n\\verb|\\end{a}|\n\\begin{verbatim}\\end{b}\\end{verbatim}\n\\end{a}';
    const s = state(doc);
    const begin = envNameAt(s, '\\begin{'.length)!;
    expect(begin.name).toBe('a');
    expect(envPartner(s, begin)!.from).toBe(doc.lastIndexOf('\\end{a}'));
  });

  it('plans a close only where no \\end waits', () => {
    expect(planEnvClose(state('\\begin{x}'), 9)?.changes.insert).toBe('\n  \n\\end{x}');
    expect(planEnvClose(state('\\begin{x}\n\\end{x}'), 9)).toBeNull();
    expect(planEnvClose(state('\\\\begin{x}'), 10)).toBeNull();
    expect(planEnvClose(state('\\begin{tabular}'), 15, { args: true })?.changes.insert).toBe('{}\n  \n\\end{tabular}');
    expect(innermostOpenEnv(state('\\begin{a}\\begin{b}\\end{b}\\begin{c}'), 34)).toBe('c');
  });
});
