/**
 * The `\label{` suggestion (WP26): while the argument is empty or a prefix of
 * the suggestion, the completion list offers the name "Insert label here"
 * would choose (fig:mean-reaction-times, sec:method, eq:3), with the detail
 * "suggested". Nothing is written until the person accepts it.
 */
import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { EditorFeatureCtx } from '../types';
import { takenLabels } from './actions';
import { loadLabels } from './labelIndex';
import { suggestedName } from './labelSuggest';
import { CROSSREF_SETTINGS } from './settings';

/** The argument being typed in `\label{…` before `pos`, or null. */
export function labelArgAt(lineText: string, column: number): { typed: string; start: number } | null {
  const m = /\\label\s*\{([^{}\\%]*)$/.exec(lineText.slice(0, column));
  return m ? { typed: m[1], start: column - m[1].length } : null;
}

/** The suggestion for the caret in `text`, or null when it does not extend what is typed. */
export function labelSuggestion(text: string, pos: number, lineFrom: number, lineText: string, taken: Set<string>): { from: number; name: string } | null {
  const arg = labelArgAt(lineText, pos - lineFrom);
  if (!arg) return null;
  const rest = /^[^{}\n]*/.exec(text.slice(pos))?.[0] ?? '';
  taken.delete(arg.typed + rest);
  const name = suggestedName(text, pos, taken);
  if (!name.startsWith(arg.typed) || name === arg.typed) return null;
  return { from: lineFrom + arg.start, name };
}

function enabled(ctx: EditorFeatureCtx): boolean {
  try {
    return ctx.setting<boolean>(CROSSREF_SETTINGS.suggest) !== false;
  } catch {
    return true;
  }
}

export function labelCompletionSource(ctx: EditorFeatureCtx): CompletionSource {
  return async (cx: CompletionContext): Promise<CompletionResult | null> => {
    if (!enabled(ctx)) return null;
    const line = cx.state.doc.lineAt(cx.pos);
    if (!labelArgAt(line.text, cx.pos - line.from)) return null;
    const project = await loadLabels(ctx.projectId, ctx.branch);
    if (cx.aborted) return null;
    const text = cx.state.doc.toString();
    const s = labelSuggestion(text, cx.pos, line.from, line.text, takenLabels(text, project, ctx.filePath));
    if (!s) return null;
    const { name } = s;
    return {
      from: s.from,
      filter: false,
      validFor: (typed: string) => name.startsWith(typed) && typed !== name,
      options: [{
        label: name,
        detail: 'suggested',
        type: 'variable',
        boost: 99,
        apply: (view: EditorView, _c, from: number, to: number) => {
          const close = view.state.sliceDoc(to, to + 1) === '}' ? '' : '}';
          view.dispatch({
            changes: { from, to, insert: name + close },
            selection: { anchor: from + name.length + 1 },
            userEvent: 'input.complete',
          });
        },
      }],
    };
  };
}
