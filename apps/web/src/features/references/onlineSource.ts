/**
 * "Search online for …" as the last citation suggestion (WP22). It is offered
 * inside a citation command's key argument once at least three characters of
 * the key are typed, and it never touches the network: choosing it removes
 * the half-typed key and opens the References panel with it as the query, so
 * the paper the panel adds lands in this citation.
 */
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';

/** A citation command's key argument up to the caret; group 1 is what is typed so far (as latexExtras' CITE_RE). */
const CITE_ARG = /\\[a-zA-Z]*[cC]ite[a-zA-Z]*\*?(?:\s*\[[^\]\n]*\]){0,2}\s*\{([^}]*)$/;
export const MIN_QUERY = 3;
/** Sorts after every key the project already has (boost runs from -99 to 99). */
const LAST = -99;

/** The key being typed inside a citation at `pos`: its start and text, or null outside one. */
export function citeQueryAt(lineBefore: string, pos: number): { from: number; query: string } | null {
  const m = CITE_ARG.exec(lineBefore);
  if (!m) return null;
  const segment = m[1];
  const query = segment.slice(segment.lastIndexOf(',') + 1).trimStart();
  // A trailing space ends the word: CodeMirror's filter could no longer match the label.
  if (!query || /\s$/.test(query)) return null;
  return { from: pos - query.length, query };
}

export interface OnlineSourceDeps {
  /** "Look up references online" and "Offer Search online": both must be on. */
  enabled(): boolean;
  /** Opens the References panel with `query` in its search box. */
  open(query: string): void;
}

export const searchLabel = (query: string) => `Search online for “${query}”`;

export function onlineCiteSource(deps: OnlineSourceDeps): CompletionSource {
  return (cx: CompletionContext): CompletionResult | null => {
    if (!deps.enabled()) return null;
    const line = cx.state.doc.lineAt(cx.pos);
    const at = citeQueryAt(cx.state.sliceDoc(line.from, cx.pos), cx.pos);
    if (!at || at.query.length < MIN_QUERY) return null;
    const { query } = at;
    const option: Completion = {
      // The label carries the typed text, so CodeMirror's own filter keeps it
      // (as a weak match, after the project's keys) without a second request.
      label: searchLabel(query),
      detail: 'References panel',
      type: 'text',
      boost: LAST,
      apply: (view: EditorView, _c: Completion, from: number, to: number) => {
        view.dispatch({ changes: { from, to, insert: '' }, userEvent: 'delete' });
        deps.open(query);
      },
    };
    return { from: at.from, options: [option] };
  };
}
