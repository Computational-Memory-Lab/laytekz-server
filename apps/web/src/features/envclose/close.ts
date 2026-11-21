/**
 * Closing environments (WP31). Every path asks editor/beginEnv.ts's planner,
 * which adds `\end{name}` only when no \end is waiting for the \begin:
 * - the `}` that finishes `\begin{name}` (typed, or stepped over after
 *   closeBrackets' own brace): an automatic-edit rule, so the \end block is
 *   an undo step of its own and Backspace right after takes it back;
 * - Enter at the end of a `\begin{name}…` line (Source mode);
 * - an environment completion (completion.ts calls closeAfterCompletion).
 * An argument environment (`tabular`) leaves the caret in `{¦}`: `}` steps
 * over that brace and Enter on the line then moves into the body.
 */
import { EditorState, Prec, StateField, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { insertNewlineAndIndent } from '@codemirror/commands';
import { completionStatus } from '@codemirror/autocomplete';
import { planEnterClose, planEnvClose } from '../../editor/beginEnv';
import { applyExplicitEdit, autoEditMark } from '../../editor/core/autoEdit';
import { trackClosers } from '../../editor/core/brackets';
import type { AutoEditRule } from '../../editor/core/types';
import { ARGS_RULE, CLOSE_RULE, envCloseConfig } from './config';
import { ENVCLOSE_SETTINGS } from './settings';

/** Below the escape and currency rules (50), above auto math (40); none of those acts on `}`. */
export const CLOSE_RULE_PRIORITY = 45;

/** The `}` of `\begin{name}` adds the \end block (one automatic edit). */
export const closeRule: AutoEditRule = {
  id: CLOSE_RULE,
  priority: CLOSE_RULE_PRIORITY,
  settingId: ENVCLOSE_SETTINGS.close,
  run(t) {
    if (t.char !== '}') return null;
    if (!t.after.facet(envCloseConfig).close) return null;
    const sel = t.after.selection.main;
    if (!sel.empty || t.after.sliceDoc(sel.head - 1, sel.head) !== '}') return null;
    const plan = planEnvClose(t.after, sel.head, { args: true });
    return plan && { rule: plan.args ? ARGS_RULE : CLOSE_RULE, changes: plan.changes, selection: plan.selection };
  },
};

function singleCaret(view: EditorView): number | null {
  const sel = view.state.selection;
  return sel.ranges.length === 1 && sel.main.empty ? sel.main.head : null;
}

/** After a completion that ends in `\begin{name}`: close it, as its own undo step. */
export function closeAfterCompletion(view: EditorView): void {
  const state = view.state;
  if (!state.facet(envCloseConfig).close || state.readOnly) return;
  const pos = singleCaret(view);
  if (pos == null) return;
  const plan = planEnvClose(state, pos, { args: true });
  if (!plan) return;
  applyExplicitEdit(view, {
    changes: plan.changes,
    selection: plan.selection,
    annotations: autoEditMark.of(plan.args ? ARGS_RULE : CLOSE_RULE),
    scrollIntoView: true,
  }, 'input.auto');
}

/** Enter at the end of a `\begin{name}…` line with no \end waiting: a new line, then the \end line as its own step. */
export function enterClose(view: EditorView): boolean {
  const state = view.state;
  const cfg = state.facet(envCloseConfig);
  if (!cfg.close || cfg.visual || state.readOnly || completionStatus(state) === 'active') return false;
  const pos = singleCaret(view);
  if (pos == null) return false;
  const plan = planEnterClose(state, pos);
  if (!plan || !insertNewlineAndIndent(view)) return false;
  const caret = view.state.selection.main.head;
  applyExplicitEdit(view, {
    changes: { from: caret, insert: `\n${plan.lead}\\end{${plan.name}}` },
    selection: { anchor: caret },
    annotations: autoEditMark.of(CLOSE_RULE),
    scrollIntoView: true,
  }, 'input.auto');
  return true;
}

// ---- an argument environment's `{¦}` ----

interface ArgSlot {
  /** The `}` of the argument. */
  close: number;
  /** The end of the body line below. */
  body: number;
}

/** Set by an ARGS_RULE edit; gone once the caret leaves the \begin line or the brace changes. */
export const argSlotField = StateField.define<ArgSlot | null>({
  create: () => null,
  update(value, tr) {
    if (tr.docChanged && tr.annotation(autoEditMark) === ARGS_RULE) {
      const head = tr.state.selection.main.head;
      const line = tr.state.doc.lineAt(head);
      if (tr.state.sliceDoc(head, head + 1) !== '}' || line.number >= tr.state.doc.lines) return null;
      return { close: head, body: tr.state.doc.line(line.number + 1).to };
    }
    if (!value) return null;
    const close = tr.docChanged ? tr.changes.mapPos(value.close, 1) : value.close;
    const body = tr.docChanged ? tr.changes.mapPos(value.body, 1) : value.body;
    if (tr.state.sliceDoc(close, close + 1) !== '}') return null;
    const line = tr.state.doc.lineAt(close);
    const head = tr.state.selection.main.head;
    if (tr.state.selection.ranges.length !== 1 || head < line.from || head > line.to) return null;
    return close === value.close && body === value.body ? value : { close, body };
  },
});

/** The argument's `}` is a tracked closer too, so the pairs feature's Tab steps out of it. */
const trackArgBrace = EditorState.transactionExtender.of((tr) => {
  if (!tr.docChanged || tr.annotation(autoEditMark) !== ARGS_RULE) return null;
  const head = tr.newSelection.main.head;
  return tr.newDoc.sliceString(head, head + 1) === '}' ? { effects: trackClosers.of([{ from: head, to: head + 1, text: '}' }]) } : null;
});

/** `}` typed right before the argument's own `}` steps over it. */
const argSlotInput = Prec.high(EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '}' || from !== to || view.state.selection.ranges.length !== 1) return false;
  const slot = view.state.field(argSlotField, false);
  if (!slot || slot.close !== from) return false;
  view.dispatch({ selection: { anchor: from + 1 }, userEvent: 'input.type', scrollIntoView: true });
  return true;
}));

/** Enter 90 on the \begin line of an argument environment just closed: the caret moves into the body. */
export function argJump(view: EditorView): boolean {
  const state = view.state;
  const slot = state.field(argSlotField, false);
  if (!slot || state.facet(envCloseConfig).visual || completionStatus(state) === 'active') return false;
  const pos = singleCaret(view);
  if (pos == null || pos < slot.close) return false;
  const rest = state.sliceDoc(pos, state.doc.lineAt(pos).to);
  if (!/^\}?[ \t]*$/.test(rest)) return false;
  view.dispatch({ selection: { anchor: slot.body }, userEvent: 'select', scrollIntoView: true });
  return true;
}

export const argSlotExtension: Extension = [argSlotField, argSlotInput, trackArgBrace];
