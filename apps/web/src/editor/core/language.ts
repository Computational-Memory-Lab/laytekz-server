/**
 * The LaTeX language as the code editor mounts it (WP05 editor-host, core
 * extraction with no behaviour change): the grammar with Aldine's tags, the
 * highlighting, the newline indent, and the package's own completion source.
 * It groups what editor/latexHighlight.ts, editor/newlineIndent.ts and
 * codemirror-lang-latex export; those files are not changed here. CodePane
 * places each part where V1 had it.
 */
import type { Extension } from '@codemirror/state';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { CompletionSource } from '@codemirror/autocomplete';
import { latexCompletionSource } from 'codemirror-lang-latex';
import { aldineHighlight, aldineLatex } from '../latexHighlight';
import { latexNewlineIndent } from '../newlineIndent';

export { aldineHighlight, aldineLatex, latexCompletionSource };

/** How the grammar is configured: the package's own autocompletion, linting
 *  and tooltips stay off (the editor lists every completion source itself, and
 *  its \cite hover is the only hover). Its auto-close of \begin is off too
 *  (WP31): its Enter key, `}` key and completion filter added an \end even
 *  where one existed; editor/beginEnv.ts and the envclose feature close
 *  environments instead, once. */
export const LATEX_LANGUAGE_OPTIONS = { autoCloseTags: false, enableLinting: false, enableAutocomplete: false, enableTooltips: false } as const;

/** Aldine's highlight style, with CodeMirror's default under it for any tag it leaves out. */
export function latexHighlighting(): Extension {
  return [
    syntaxHighlighting(aldineHighlight),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  ];
}

/** The grammar and its indentation after a line break. */
export function latexLanguage(): Extension {
  return [
    aldineLatex({ ...LATEX_LANGUAGE_OPTIONS }),
    latexNewlineIndent,
  ];
}

/** The package's command and environment completions. Environment names
 *  insert `name}` alone: the envclose feature's completion filter adds the
 *  \end (WP31), so a name accepted inside an existing pair never doubles it. */
export function packageCompletionSource(): CompletionSource {
  return latexCompletionSource(false);
}
