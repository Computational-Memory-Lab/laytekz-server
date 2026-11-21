/**
 * The automatic-edit core (WP08 typing-core). Rules (EditorContribution.autoEditRules)
 * are pure functions of one keystroke; this module decides when they run and
 * makes each result one undo step that Backspace reverts.
 * - Rules run after a single local `input.type` transaction (typing, or
 *   closeBrackets inserting or stepping over) with one cursor, in a writable
 *   document (the load gate keeps it read-only until the first sync), outside
 *   IME composition, without `statsEdit`. Enabled rules run highest priority
 *   first; the first result wins, so a keystroke makes at most one automatic
 *   edit. Remote and agent changes, undo and redo, pastes and completions are
 *   never `input.type`, so they never trigger a rule.
 * - The edit is dispatched from a microtask, only while the document is still
 *   the one the keystroke made, between two undo boundaries
 *   (visual/history.ts `undoBoundary`, Y.UndoManager.stopCapturing in the
 *   editor), as `input.auto`: one ⌘Z undoes it and leaves the keystroke.
 * - Backspace straight after (key chain, priority 100) applies the inverse
 *   and declines that spot for the rule. Any other local action, or a caret
 *   move, ends that chance; a collaborator's change elsewhere does not.
 */
import {
  Annotation, ChangeSet, Facet, Prec, StateEffect, StateField, Transaction,
  type AnnotationType, type EditorState, type Extension, type Text, type TransactionSpec,
} from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { undoBoundary } from '../visual/history';
import { getSetting } from '../../settings/store';
import { keyChains } from './keyChains';
import { noteAutoEditRevert, showAutoEditNotice } from './notices';
import { KEY_CHAIN_PRIORITY, type AutoEdit, type AutoEditRule, type TypedInput } from './types';

/** Transactions carrying it never trigger a rule (the statistics fields,
 *  WP38, mark their own edits with it; WP38 re-exports it from its api.ts). */
export const statsEdit: AnnotationType<boolean> = Annotation.define<boolean>();

/** Marks an edit Backspace may revert right after: the core's follow-ups carry
 *  their AutoEdit.rule; a command marks its applyExplicitEdit spec with it to
 *  get the same (its extension then includes autoEditCore([])). */
export const autoEditMark: AnnotationType<string> = Annotation.define<string>();

/** The setting behind a marked edit, for the offer to turn it off after reverts. */
const markSetting = Annotation.define<string>();

/** Whether a rule's setting is on. The default reads the settings store
 *  (anything but `false` is on); tests and the replay harness provide their own. */
export const autoEditSettings: Facet<(settingId: string) => boolean, (settingId: string) => boolean> = Facet.define<(settingId: string) => boolean, (settingId: string) => boolean>({
  combine: (fs) => fs[fs.length - 1] ?? settingFromStore,
});

function settingFromStore(id: string): boolean {
  try {
    return getSetting<unknown>(id) !== false;
  } catch {
    return true;
  }
}

/** What the core needs of an editor: an EditorView, or the headless one the tests use. */
export type AutoEditView = Pick<EditorView, 'state' | 'dispatch' | 'composing'>;

/** A command's own edit as exactly one undo step (undoBoundary before and
 *  after); `userEvent` defaults to the spec's, then 'input.auto'. */
export function applyExplicitEdit(view: EditorView, spec: TransactionSpec, userEvent?: string): void {
  view.state.facet(undoBoundary)();
  view.dispatch({ ...spec, userEvent: userEvent ?? spec.userEvent ?? 'input.auto' });
  view.state.facet(undoBoundary)();
}

interface LastAutoEdit { rule: string; inverse: ChangeSet; caretAfter: number }
interface Revertible extends LastAutoEdit { settingId?: string }

function touched(inverse: ChangeSet, changes: ChangeSet): boolean {
  let hit = false;
  inverse.iterChangedRanges((fromA, toA) => {
    if (!hit && changes.touchesRange(fromA, toA)) hit = true;
  });
  return hit;
}

/** The last automatic edit while it can still be reverted, mapped through
 *  later changes; null once the caret leaves it or anything else is typed. */
export const lastAutoEdit: StateField<{ rule: string; inverse: ChangeSet; caretAfter: number } | null> = StateField.define<LastAutoEdit | null>({
  create: () => null,
  update(value, tr) {
    const rule = tr.annotation(autoEditMark);
    if (rule !== undefined) {
      const sel = tr.state.selection;
      if (!tr.docChanged || sel.ranges.length !== 1 || !sel.main.empty) return null;
      const next: Revertible = { rule, inverse: tr.changes.invert(tr.startState.doc), caretAfter: sel.main.head, settingId: tr.annotation(markSetting) };
      return next;
    }
    if (!value) return null;
    // Typing, deleting, selecting, pasting: every local action carries a user event.
    if (tr.annotation(Transaction.userEvent) !== undefined) return null;
    let next = value as Revertible;
    if (tr.docChanged) {
      // A collaborator's change, or undo/redo: fine unless it touches the edit.
      if (touched(next.inverse, tr.changes)) return null;
      next = { ...next, inverse: next.inverse.map(tr.changes), caretAfter: tr.changes.mapPos(next.caretAfter, -1) };
    }
    const sel = tr.state.selection;
    if (sel.ranges.length !== 1 || !sel.main.empty || sel.main.head !== next.caretAfter) return null;
    return next;
  },
});

interface Declined { from: number; to: number; rule: string }

const declineEffect = StateEffect.define<Declined>();
const MAX_DECLINED = 200;

/** Spots where a rule was reverted, mapped through edits without growing at their ends. */
const declinedField = StateField.define<readonly Declined[]>({
  create: () => [],
  update(list, tr) {
    if (tr.docChanged && list.length) {
      list = list.map((d) => {
        const from = tr.changes.mapPos(d.from, 1);
        return { from, to: Math.max(from, tr.changes.mapPos(d.to, -1)), rule: d.rule };
      });
    }
    for (const e of tr.effects) if (e.is(declineEffect)) list = [...list.slice(-(MAX_DECLINED - 1)), e.value];
    return list;
  },
});

/** Whether `rule` (an AutoEdit.rule) was reverted at `pos` before (a declined spot never fires again). */
export function declined(state: EditorState, pos: number, rule: string): boolean {
  return (state.field(declinedField, false) ?? []).some((d) => d.rule === rule && d.from <= pos && pos <= d.to);
}

function touchesDeclined(state: EditorState, changes: ChangeSet, rule: string): boolean {
  return (state.field(declinedField, false) ?? []).some((d) => d.rule === rule && changes.touchesRange(d.from, d.to) !== false);
}

/** The character each input handler call typed, by the state it was typed into. */
const typedInto = new WeakMap<EditorState, { char: string; from: number; to: number }>();

const recordTyped = Prec.highest(EditorView.inputHandler.of((view, from, to, text) => {
  typedInto.set(view.state, { char: text, from, to });
  return false;
}));

/** The keystroke a transaction is, or null when it is not one local `input.type` with one cursor. */
export function typedInputOf(tr: Transaction): TypedInput | null {
  if (!tr.isUserEvent('input.type') || tr.isUserEvent('input.type.compose')) return null;
  const before = tr.startState;
  const after = tr.state;
  if (before.selection.ranges.length !== 1 || after.selection.ranges.length !== 1) return null;
  const typed = typedInto.get(before);
  if (typed) return { ...typed, before, after };
  // Dispatched without the input handlers (a key binding that types, a test): read it off the change.
  const changes: { from: number; to: number; text: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => { changes.push({ from: fromA, to: toA, text: inserted.toString() }); });
  if (changes.length === 1 && changes[0].text) return { char: changes[0].text, from: changes[0].from, to: changes[0].to, before, after };
  const head = before.selection.main.head;
  if (!changes.length && before.selection.main.empty && after.selection.main.head === head + 1) {
    return { char: before.doc.sliceString(head, head + 1), from: head, to: head, before, after };
  }
  return null;
}

const rulesFacet = Facet.define<readonly AutoEditRule[], readonly AutoEditRule[]>({
  combine: (lists) => lists.flat().map((rule, i) => ({ rule, i }))
    .sort((a, b) => b.rule.priority - a.rule.priority || a.i - b.i)
    .map((x) => x.rule),
});

/** What the core will dispatch after a keystroke. */
export interface PlannedAutoEdit { edit: AutoEdit; changes: ChangeSet; settingId: string; doc: Text }

/** The automatic edit `tr` calls for, or null; pure apart from reading which settings are on. */
export function planAutoEdit(tr: Transaction): PlannedAutoEdit | null {
  const rules = tr.state.facet(rulesFacet);
  if (!rules.length || tr.annotation(statsEdit) || tr.state.readOnly) return null;
  const input = typedInputOf(tr);
  if (!input) return null;
  const enabled = tr.state.facet(autoEditSettings);
  for (const rule of rules) {
    if (!enabled(rule.settingId)) continue;
    let result: { edit: AutoEdit; changes: ChangeSet } | null = null;
    try {
      const edit = rule.run(input);
      if (edit) {
        const changes = input.after.changes(edit.changes);
        const sel = edit.selection;
        if (sel && (sel.anchor > changes.newLength || (sel.head ?? sel.anchor) > changes.newLength)) throw new RangeError('selection outside the document');
        result = { edit, changes };
      }
    } catch (err) {
      console.warn(`Automatic edit ${rule.id} failed`, err);
      continue;
    }
    if (!result || result.changes.empty) continue;
    const ruleName = result.edit.rule || rule.id;
    if (touchesDeclined(input.after, result.changes, ruleName)) continue;
    return { edit: { ...result.edit, rule: ruleName }, changes: result.changes, settingId: rule.settingId, doc: input.after.doc };
  }
  return null;
}

const FLASH_MS = 900;
const flashEffect = StateEffect.define<readonly { from: number; to: number }[]>();
const flashEnd = StateEffect.define<null>();
const flashMark = Decoration.mark({ class: 'cm-auto-edit' });

/** The characters an automatic edit wrote, marked for a moment (the CSS animates the mark once). */
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(flashEffect)) return Decoration.set(e.value.map((r) => flashMark.range(r.from, r.to)));
      if (e.is(flashEnd)) return Decoration.none;
    }
    return deco === Decoration.none || tr.docChanged || tr.selection ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const flashTheme = EditorView.baseTheme({
  '.cm-auto-edit': { animation: 'cm-auto-edit-flash 0.9s ease-out' },
  '@keyframes cm-auto-edit-flash': {
    from: { backgroundColor: 'var(--auto-edit-flash, rgba(234, 179, 8, 0.35))' },
    to: { backgroundColor: 'transparent' },
  },
  '[data-motion="reduce"] & .cm-auto-edit': { animation: 'none' },
  '@media (prefers-reduced-motion: reduce)': { '.cm-auto-edit': { animation: 'none' } },
});

/** Dispatches `plan` if the document is still the one its keystroke made; true when it did. */
export function applyPlannedAutoEdit(view: AutoEditView, plan: PlannedAutoEdit): boolean {
  const state = view.state;
  if (state.doc !== plan.doc || state.readOnly || view.composing || state.selection.ranges.length !== 1) return false;
  const marks: { from: number; to: number }[] = [];
  plan.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => { if (toB > fromB) marks.push({ from: fromB, to: toB }); });
  state.facet(undoBoundary)();
  view.dispatch({
    changes: plan.changes,
    selection: plan.edit.selection,
    annotations: [autoEditMark.of(plan.edit.rule), markSetting.of(plan.settingId)],
    effects: marks.length ? flashEffect.of(marks) : [],
    userEvent: 'input.auto',
    scrollIntoView: true,
  });
  view.state.facet(undoBoundary)();
  if (plan.edit.notice) showAutoEditNotice(view.state, plan.edit.notice);
  const flash = view.state.field(flashField, false);
  if (flash && flash !== Decoration.none) {
    setTimeout(() => {
      try {
        if (view.state.field(flashField, false) === flash) view.dispatch({ effects: flashEnd.of(null) });
      } catch { /* the editor is gone */ }
    }, FLASH_MS);
  }
  return true;
}

/** Backspace right after an automatic edit: puts back what was there and declines the spot. */
export function revertAutoEdit(view: AutoEditView): boolean {
  const last = view.state.field(lastAutoEdit, false) as Revertible | null | undefined;
  if (!last || view.state.readOnly) return false;
  const sel = view.state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty || sel.main.head !== last.caretAfter) return false;
  const caret = last.inverse.mapPos(last.caretAfter, -1);
  let from = caret;
  let to = caret;
  last.inverse.iterChangedRanges((_fromA, _toA, fromB, toB) => { from = Math.min(from, fromB); to = Math.max(to, toB); });
  view.state.facet(undoBoundary)();
  view.dispatch({
    changes: last.inverse,
    selection: { anchor: caret },
    effects: declineEffect.of({ from, to, rule: last.rule }),
    userEvent: 'delete.backward',
    scrollIntoView: true,
  });
  view.state.facet(undoBoundary)();
  noteAutoEditRevert(view.state, last.rule, last.settingId);
  return true;
}

const scheduler = EditorView.updateListener.of((u) => {
  if (u.transactions.length !== 1 || u.view.composing) return;
  const plan = planAutoEdit(u.transactions[0]);
  if (!plan) return;
  const view = u.view;
  queueMicrotask(() => {
    try {
      applyPlannedAutoEdit(view, plan);
    } catch (err) {
      console.warn(`Automatic edit ${plan.edit.rule} could not be applied`, err);
    }
  });
});

/** One instance, so autoEditCore in several compartments installs it once. */
const machinery: Extension = [
  recordTyped,
  lastAutoEdit,
  declinedField,
  flashField,
  flashTheme,
  scheduler,
  keyChains.of({ key: 'Backspace', priority: KEY_CHAIN_PRIORITY.Backspace.autoEditRevert, id: 'autoEdit.revert', run: revertAutoEdit }),
];

/** Installed by the editor host with the rules of the features that run in
 *  the current file and mode; reconfigured when those change. */
export function autoEditCore(rules: readonly AutoEditRule[]): Extension {
  return [rulesFacet.of(rules), machinery];
}
