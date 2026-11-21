import { describe, expect, it } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { latex } from 'codemirror-lang-latex';
import { canSuggestAt, promptContext, PREFIX_CHARS } from '../promptContext';

const language = latex({ autoCloseTags: false, enableLinting: false, enableAutocomplete: false, enableTooltips: false });

function allowed(src: string): boolean {
  const pos = src.indexOf('|');
  const doc = src.slice(0, pos) + src.slice(pos + 1);
  return canSuggestAt(EditorState.create({ doc, extensions: [language] }), pos);
}

describe('canSuggestAt', () => {
  it('allows prose, text arguments and table cells', () => {
    expect(allowed('\\begin{document}\nThe meas|\n\\end{document}')).toBe(true);
    expect(allowed('Some \\textbf{meas|} here')).toBe(true);
    expect(allowed('\\section{Intro|}')).toBe(true);
    expect(allowed('\\begin{tabular}{ll}\nmeas| & b \\\\\n\\end{tabular}')).toBe(true);
  });

  it('refuses math, comments, keys, labels, paths and the preamble', () => {
    expect(allowed('see $x + meas|$ here')).toBe(false);
    expect(allowed('\\begin{equation}\nmeas|\n\\end{equation}')).toBe(false);
    expect(allowed('% a comment meas|')).toBe(false);
    expect(allowed('\\cite{meas|}')).toBe(false);
    expect(allowed('\\ref{fig:meas|}')).toBe(false);
    expect(allowed('\\label{sec:meas|}')).toBe(false);
    expect(allowed('\\includegraphics{figures/meas|}')).toBe(false);
    expect(allowed('\\begin{itemi|}')).toBe(false);
    expect(allowed('\\documentclass{article}\n\\usepackage{amsm|}\n\\begin{document}\n\\end{document}')).toBe(false);
  });
});

describe('promptContext', () => {
  const line = 'This is a line of prose for the prompt window test.\n';
  const doc = Text.of((line.repeat(200)).split('\n'));

  it('keeps the prefix start fixed while typing on', () => {
    const at = 5000;
    const a = promptContext(doc, at);
    const b = promptContext(doc, at + 7);
    const c = promptContext(doc, at + 40);
    expect(b.start).toBe(a.start);
    expect(c.start).toBe(a.start);
    expect(a.prefix).toBe(doc.sliceString(a.start, at));
    expect(at - a.start).toBeGreaterThanOrEqual(PREFIX_CHARS - line.length);
    expect(doc.lineAt(a.start).from).toBe(a.start);
  });

  it('runs the suffix to the end of the next line, never into the preamble', () => {
    const src = '\\documentclass{article}\n\\usepackage{x}\n\\begin{document}\nHello there\nnext line\nlater';
    const d = Text.of(src.split('\n'));
    const pos = src.indexOf('there');
    const p = promptContext(d, pos);
    expect(p.prefix).toBe('\nHello ');
    expect(p.suffix).toBe('there\nnext line');
  });
});
