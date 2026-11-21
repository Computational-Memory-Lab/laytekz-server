import { EditorState, type Extension } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { latex } from 'codemirror-lang-latex';

export const latexLanguage = (): Extension =>
  latex({ autoCloseTags: false, enableLinting: false, enableAutocomplete: false, enableTooltips: false });

/** A fully parsed state of `src` with `¦` marking a position (taken out of the text); no `¦` is the end. */
export function at(src: string, extensions: Extension[] = []): { state: EditorState; pos: number } {
  const mark = src.indexOf('¦');
  const doc = mark < 0 ? src : src.slice(0, mark) + src.slice(mark + 1);
  const state = EditorState.create({ doc, extensions: [latexLanguage(), ...extensions] });
  if (!ensureSyntaxTree(state, doc.length, 5_000)) throw new Error('the parse did not finish');
  return { state, pos: mark < 0 ? doc.length : mark };
}

export const PREAMBLE = '\\documentclass{article}\n\\usepackage{amsmath}\n';

/** `body` inside a complete document, so the position is in the document body. */
export const inDoc = (body: string): string => `${PREAMBLE}\\begin{document}\n${body}\n\\end{document}\n`;
