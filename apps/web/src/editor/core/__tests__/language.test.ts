import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { LATEX_LANGUAGE_OPTIONS, latexHighlighting, latexLanguage, packageCompletionSource } from '../language';

describe('the LaTeX language', () => {
  // Galley: V2 (WP31): the envclose feature closes environments, so the package's own auto-close is off.
  it('keeps the package\'s autocompletion, linting, tooltips and \\begin auto-close off', () => {
    expect(LATEX_LANGUAGE_OPTIONS).toEqual({ autoCloseTags: false, enableLinting: false, enableAutocomplete: false, enableTooltips: false });
  });

  it('parses LaTeX with the grammar it mounts', () => {
    const state = EditorState.create({ doc: '\\section{A}\n$x^2$\n', extensions: [latexLanguage(), latexHighlighting()] });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
    const names: string[] = [];
    tree.iterate({ enter: (n) => { names.push(n.name); } });
    expect(names).toContain('InlineMath');
  });

  it('offers the package\'s commands', async () => {
    const state = EditorState.create({ doc: '\\textb', extensions: [latexLanguage()] });
    const r = (await packageCompletionSource()(new CompletionContext(state, 6, true))) as CompletionResult | null;
    expect(r?.options.some((o) => /textbf/.test(o.label))).toBe(true);
  });
});
