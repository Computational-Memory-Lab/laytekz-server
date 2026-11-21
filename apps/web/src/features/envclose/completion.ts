/**
 * The envclose feature's completion filter (WP31):
 * - Environment names after `\begin{`/`\end{` replace only the name (the
 *   brace that follows stays), as a local `input.complete` edit, so a name
 *   accepted inside an existing pair is mirrored to its partner (envSync)
 *   instead of adding a second environment. A new `\begin{name}` is then
 *   closed (close.ts) as its own undo step.
 * - After `\end{`, the innermost open environment comes first.
 * - Commands with several arguments (\frac, \href, \multicolumn …) insert
 *   tab stops: Tab moves to the next pair of braces, then past the last.
 */
import { pickedCompletion, snippet, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { innermostOpenEnv } from '../../editor/beginEnv';
import { closeAfterCompletion } from './close';
import { envCloseConfig } from './config';

/**
 * The mandatory arguments of the listed commands that take two or more: the
 * core list's (editor/latexExtras.ts ARGUMENTS) and the everyday list's
 * (editor/completions.ts EVERYDAY). Commands with one argument keep their
 * apply; Tab steps out of their brace already (pairs feature).
 */
export const MULTI_ARGUMENTS: Readonly<Record<string, number>> = {
  '\\textcolor': 2, '\\colorbox': 2, '\\frac': 2, '\\multicolumn': 3, '\\multirow': 3,
  '\\newcommand': 2, '\\renewcommand': 2, '\\newenvironment': 3, '\\renewenvironment': 3,
  '\\href': 2, '\\captionof': 2, '\\setlength': 2, '\\addtolength': 2, '\\newtheorem': 2,
  '\\providecommand': 2, '\\DeclareMathOperator': 2, '\\dfrac': 2, '\\tfrac': 2, '\\binom': 2,
  '\\stackrel': 2, '\\overset': 2, '\\underset': 2,
};

type Apply = (view: EditorView, completion: Completion, from: number, to: number) => void;

const snippetApplies = new Map<string, Apply>();

/** `\name{¦}{}` with tab stops, or the name alone when braces already follow (renaming a command). */
export function tabStopApply(name: string, args: number): Apply {
  const cached = snippetApplies.get(name);
  if (cached) return cached;
  const template = name + Array.from({ length: args }, (_, i) => `{\${${i + 1}}}`).join('') + '${0}';
  const insert = snippet(template);
  const apply: Apply = (view, completion, from, to) => {
    if (/^[{[*]/.test(view.state.sliceDoc(to, to + 1))) {
      view.dispatch({
        changes: { from, to, insert: name },
        selection: { anchor: from + name.length },
        annotations: pickedCompletion.of(completion),
        userEvent: 'input.complete',
      });
      return;
    }
    insert(view, completion, from, to);
  };
  snippetApplies.set(name, apply);
  return apply;
}

/** Accepting an environment name: replace the name only (the rest of an existing name too), keep or add the `}`. */
export function envNameApply(name: string, kind: 'begin' | 'end'): Apply {
  return (view, completion, from, to) => {
    const state = view.state;
    const lineEnd = state.doc.lineAt(to).to;
    const rest = /^[A-Za-z0-9@:*-]*(?=\})/.exec(state.sliceDoc(to, lineEnd));
    const end = rest ? to + rest[0].length : to;
    const closes = !!rest;
    view.dispatch({
      changes: { from, to: end, insert: closes ? name : `${name}}` },
      selection: { anchor: from + name.length + 1 },
      annotations: pickedCompletion.of(completion),
      userEvent: 'input.complete',
    });
    if (kind === 'begin') closeAfterCompletion(view);
  };
}

/** The package's `\begin{equation}` command (math mode): insert it, then close it. */
function beginCommandApply(label: string): Apply {
  return (view, completion, from, to) => {
    const closes = view.state.sliceDoc(to, to + 1) === '}';
    view.dispatch({
      changes: { from, to: closes ? to + 1 : to, insert: label },
      selection: { anchor: from + label.length },
      annotations: pickedCompletion.of(completion),
      userEvent: 'input.complete',
    });
    closeAfterCompletion(view);
  };
}

const ENV_NAME_BEFORE = /\\(begin|end)[ \t]*\{([A-Za-z0-9@:*-]*)$/;

export function envCompletionFilter(r: CompletionResult, cx: CompletionContext): CompletionResult {
  const cfg = cx.state.facet(envCloseConfig);
  if (!cfg.on) return r;
  const env = cx.matchBefore(ENV_NAME_BEFORE);
  if (env) {
    const m = ENV_NAME_BEFORE.exec(env.text)!;
    const kind = m[1] as 'begin' | 'end';
    const nameFrom = env.to - m[2].length;
    if (r.from !== nameFrom || !r.options.some((o) => o.type === 'class')) return r;
    const innermost = kind === 'end' ? innermostOpenEnv(cx.state, env.from) : null;
    let options = r.options.map((o) => {
      if (o.type !== 'class') return o;
      const wrapped: Completion = { ...o, apply: envNameApply(o.label, kind) };
      return o.label === innermost ? { ...wrapped, boost: 99 } : wrapped;
    });
    if (innermost && !options.some((o) => o.label === innermost) && innermost.startsWith(m[2])) {
      options = [{ label: innermost, type: 'class', detail: 'open here', boost: 99, apply: envNameApply(innermost, 'end') }, ...options];
    }
    return { ...r, options };
  }
  if (!r.options.some((o) => /^\\begin\{[^}]+\}$/.test(o.label) || (cfg.tabStops && MULTI_ARGUMENTS[o.label]))) return r;
  return {
    ...r,
    options: r.options.map((o) => {
      if (o.type === 'function' && /^\\begin\{[^}]+\}$/.test(o.label)) return { ...o, apply: beginCommandApply(o.label) };
      const args = cfg.tabStops ? MULTI_ARGUMENTS[o.label] : undefined;
      return args ? { ...o, apply: tabStopApply(o.label, args) } : o;
    }),
  };
}
