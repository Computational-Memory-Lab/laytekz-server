import {
  ChangeSet, EditorSelection, StateEffect, StateField, Transaction,
  type ChangeSpec, type EditorState, type Extension, type Range,
} from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { completionStatus } from '@codemirror/autocomplete';
import { statsEdit } from '../../editor/core/autoEdit';
import { closeUndoStep } from '../../editor/visual/history';
import { formatValue, type Kind } from './core/format';
import { renderTemplate, type GreekMode, type InsertContext } from './core/render';
import type { StatsStyle } from './core/style';
import { statsConfig } from './config';

/**
 * The statistics fields (feature 16): after a statistic is inserted, its
 * numbers are entered in fields. Tab and Shift+Tab move between them, Enter
 * finishes, Escape stops; each field is formatted when it is left (by a key
 * or a click elsewhere), empty optional parts are removed at the finish, and
 * the caret ends after the statistic. Every edit made here carries
 * `statsEdit` (so automatic edits never react to it) and is an undo step of
 * its own: the first Undo after a formatting brings back what was typed.
 */

export interface StatField {
  label: string;
  kind: Kind;
  from: number;
  to: number;
  optional: number | null;
  warning?: string;
}

export interface StatSession {
  /** The template it was rendered from; null for converter output (nothing to prune). */
  template: string | null;
  context: InsertContext;
  sColumn: boolean;
  greek: GreekMode;
  style: StatsStyle;
  kinds?: Record<string, Kind>;
  /** The whole statistic. */
  from: number;
  to: number;
  fields: StatField[];
  active: number;
}

export const setSession = StateEffect.define<StatSession | null>();

/** A transaction a person or a command made here (a collaborator's arrives without a user event). */
const isLocal = (tr: Transaction) => tr.annotation(Transaction.userEvent) !== undefined;

function mapSession(s: StatSession, tr: Transaction): StatSession | null {
  const ch = tr.changes;
  if (ch.touchesRange(s.from, s.to) === 'cover' && !ch.empty && s.to > s.from) {
    // The whole statistic was replaced or deleted.
    let covered = false;
    ch.iterChangedRanges((fA, tA) => { if (fA <= s.from && tA >= s.to && tA > fA) covered = true; });
    if (covered) return null;
  }
  const fields = s.fields.map((f) => ({ ...f, from: ch.mapPos(f.from, -1), to: ch.mapPos(f.to, 1) }));
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].from > fields[i].to) return null;
    if (i && fields[i].from < fields[i - 1].to) return null;
  }
  const from = Math.min(ch.mapPos(s.from, -1), fields[0]?.from ?? Infinity);
  const to = Math.max(ch.mapPos(s.to, -1), fields[fields.length - 1]?.to ?? -Infinity);
  return { ...s, from, to, fields };
}

export const sessionField = StateField.define<StatSession | null>({
  create: () => null,
  update(s, tr) {
    let next = s;
    let set = false;
    for (const e of tr.effects) if (e.is(setSession)) { next = e.value; set = true; }
    if (set || !next || !tr.docChanged) return next;
    if (isLocal(tr) && !tr.annotation(statsEdit)) {
      let outside = false;
      tr.changes.iterChangedRanges((fA, tA) => { if (fA < next!.from || tA > next!.to) outside = true; });
      if (outside) return null;
    }
    return mapSession(next, tr);
  },
});

/** True when `pos` lies in a field of the statistic being filled in (other features leave those alone). */
export function inStatField(state: EditorState, pos: number): boolean {
  const s = state.field(sessionField, false);
  return !!s && s.fields.some((f) => pos >= f.from && pos <= f.to);
}

/** The field index holding `pos`, the active one first; -1 when none. */
export function fieldAt(s: StatSession, pos: number): number {
  const a = s.fields[s.active];
  if (a && pos >= a.from && pos <= a.to) return s.active;
  return s.fields.findIndex((f) => pos >= f.from && pos <= f.to);
}

// ---------- decorations ----------

class Ghost extends WidgetType {
  constructor(readonly label: string, readonly active: boolean) { super(); }
  eq(o: Ghost) { return o.label === this.label && o.active === this.active; }
  toDOM() {
    const el = document.createElement('span');
    el.className = `cm-stats-ghost cm-stats-ghost--widget${this.active ? ' cm-stats-ghost--active' : ''}`;
    el.dataset.statsGhost = this.label;
    el.setAttribute('aria-hidden', 'true');
    el.dataset.testid = 'stats-field-ghost';
    return el;
  }
  ignoreEvent() { return false; }
}

function decorationsFor(state: EditorState, s: StatSession | null): DecorationSet {
  if (!s) return Decoration.none;
  const out: Range<Decoration>[] = [];
  s.fields.forEach((f, i) => {
    const active = i === s.active;
    if (f.from === f.to) {
      // The placeholder is drawn by CSS before the next character, not as a
      // widget: with a widget beside the caret, Chrome put text typed after a
      // Tab into the previous field (CodeMirror left the DOM caret on an
      // element boundary next to the uneditable widget).
      const next = state.sliceDoc(f.from, f.from + 1);
      if (next && next !== '\n') {
        out.push(Decoration.mark({
          class: `cm-stats-ghost${active ? ' cm-stats-ghost--active' : ''}`,
          attributes: { 'data-stats-ghost': f.label, 'data-testid': 'stats-field-ghost' },
        }).range(f.from, f.from + 1));
      } else {
        out.push(Decoration.widget({ widget: new Ghost(f.label, active), side: -1 }).range(f.from));
      }
    } else {
      const cls = `cm-stats-field${active ? ' cm-stats-field--active' : ''}${f.warning ? ' cm-stats-field--warn' : ''}`;
      out.push(Decoration.mark({ class: cls, attributes: f.warning ? { title: f.warning } : {} }).range(f.from, f.to));
    }
  });
  return Decoration.set(out, true);
}

const fieldTheme = EditorView.baseTheme({
  '.cm-stats-field': { borderBottom: '1px dotted var(--accent, #2563eb)' },
  '.cm-stats-field--active': { outline: '1px solid var(--accent, #2563eb)', outlineOffset: '1px', borderRadius: '2px', borderBottom: 'none' },
  '.cm-stats-field--warn': { textDecoration: 'wavy underline var(--error, #dc2626)' },
  '.cm-stats-ghost::before': {
    content: 'attr(data-stats-ghost)',
    color: 'var(--text-3, #888)', fontStyle: 'italic', padding: '0 2px', margin: '0 1px', borderRadius: '2px',
    border: '1px dashed var(--hairline-strong, #aaa)', pointerEvents: 'none',
  },
  '.cm-stats-ghost--active::before': { borderColor: 'var(--accent, #2563eb)', borderStyle: 'solid' },
});

// ---------- editing ----------

function dispatchStep(view: EditorView, spec: { changes?: ChangeSpec; selection?: EditorSelection | { anchor: number; head?: number }; effects: StateEffect<unknown>[] }): void {
  const changed = spec.changes !== undefined && !(spec.changes instanceof ChangeSet && spec.changes.empty);
  if (changed) closeUndoStep(view.state);
  view.dispatch({
    ...(changed ? { changes: spec.changes } : {}),
    ...(spec.selection ? { selection: spec.selection } : {}),
    effects: spec.effects,
    annotations: statsEdit.of(true),
    userEvent: 'input.stats',
    scrollIntoView: true,
  });
  if (changed) closeUndoStep(view.state);
}

/** What leaving the field does to its text (nothing when formatting is off or nothing changes). */
function formatChange(state: EditorState, s: StatSession, index: number): { change: ChangeSpec | null; warning?: string } {
  const f = s.fields[index];
  if (!f) return { change: null };
  const raw = state.sliceDoc(f.from, f.to);
  if (!state.facet(statsConfig).formatOnLeave) return { change: null };
  const fmt = formatValue(f.kind, raw, s.style);
  let text = fmt.text;
  if (s.context === 'math' && f.kind === 'PC') text = text.replace(/\$([<>])\$/, '$1');
  if (fmt.warning || text === raw) return { change: null, ...(fmt.warning ? { warning: fmt.warning } : {}) };
  return { change: { from: f.from, to: f.to, insert: text } };
}

function withWarning(s: StatSession, index: number, warning: string | undefined): StatSession {
  const fields = s.fields.map((f, i) => {
    if (i !== index) return f;
    const { warning: _old, ...rest } = f;
    return warning ? { ...rest, warning } : rest;
  });
  return { ...s, fields };
}

function mapThrough(s: StatSession, changes: ChangeSet): StatSession {
  const fields = s.fields.map((f) => ({ ...f, from: changes.mapPos(f.from, -1), to: changes.mapPos(f.to, 1) }));
  return { ...s, fields, from: Math.min(changes.mapPos(s.from, -1), fields[0]?.from ?? Infinity), to: Math.max(changes.mapPos(s.to, -1), fields[fields.length - 1]?.to ?? -Infinity) };
}

/** Formats the active field and makes `target` active, selecting its text (or placing the caret when it is empty). */
export function moveToField(view: EditorView, target: number, o: { select?: boolean } = {}): boolean {
  const s = view.state.field(sessionField, false);
  if (!s || !s.fields[target]) return false;
  const { change, warning } = formatChange(view.state, s, s.active);
  const changes = ChangeSet.of(change ?? [], view.state.doc.length);
  let next = mapThrough(withWarning(s, s.active, warning), changes);
  next = { ...next, active: target };
  const f = next.fields[target];
  const select = o.select !== false;
  dispatchStep(view, {
    changes,
    ...(select ? { selection: EditorSelection.single(f.from, f.to) } : {}),
    effects: [setSession.of(next)],
  });
  return true;
}

/** The change that removes empty optional parts, when the statistic's text is still what was rendered. */
function pruneChange(state: EditorState, s: StatSession): ChangeSpec | null {
  if (!s.template || !s.fields.some((f) => f.optional !== null)) return null;
  const values: Record<string, string> = {};
  for (const f of s.fields) values[f.label] = state.sliceDoc(f.from, f.to);
  const o = { context: s.context, style: s.style, greek: s.greek, values, format: false, sColumn: s.sColumn, ...(s.kinds ? { kinds: s.kinds } : {}) };
  const whole = renderTemplate(s.template, o).text;
  if (whole !== state.sliceDoc(s.from, s.to)) return null;
  const pruned = renderTemplate(s.template, { ...o, prune: true }).text;
  if (pruned === whole) return null;
  let a = 0;
  while (a < whole.length && a < pruned.length && whole[a] === pruned[a]) a++;
  let b = 0;
  while (b < whole.length - a && b < pruned.length - a && whole[whole.length - 1 - b] === pruned[pruned.length - 1 - b]) b++;
  return { from: s.from + a, to: s.to - b, insert: pruned.slice(a, pruned.length - b) };
}

/** Formats the active field, removes empty optional parts and ends the fields. `caretAfter`: put the caret after the statistic. */
export function finishSession(view: EditorView, o: { caretAfter: boolean }): boolean {
  const s = view.state.field(sessionField, false);
  if (!s) return false;
  const { change } = s.active >= 0 ? formatChange(view.state, s, s.active) : { change: null };
  const first = ChangeSet.of(change ?? [], view.state.doc.length);
  const mid = mapThrough(s, first);
  const midState = first.empty ? view.state : view.state.update({ changes: first }).state;
  const prune = pruneChange(midState, mid);
  const second = ChangeSet.of(prune ?? [], midState.doc.length);
  const all = first.compose(second);
  const end = second.mapPos(mid.to, 1);
  dispatchStep(view, {
    changes: all,
    ...(o.caretAfter ? { selection: EditorSelection.cursor(end) } : {}),
    effects: [setSession.of(null)],
  });
  return true;
}

/** Ends the fields, keeping the text as it is. */
export function stopSession(view: EditorView): boolean {
  if (!view.state.field(sessionField, false)) return false;
  view.dispatch({ effects: setSession.of(null), annotations: statsEdit.of(true) });
  return true;
}

function caretIn(view: EditorView, s: StatSession): boolean {
  const { head } = view.state.selection.main;
  return head >= s.from && head <= s.to;
}

/** Tab (priority 90) and Shift+Tab: the next or previous field; Tab after the last one finishes. */
export function nextField(view: EditorView, dir: 1 | -1 = 1): boolean {
  const s = view.state.field(sessionField, false);
  if (!s || completionStatus(view.state) === 'active' || view.composing || !caretIn(view, s)) return false;
  const at = fieldAt(s, view.state.selection.main.head);
  const current = at >= 0 ? at : s.active;
  const target = current + dir;
  if (target >= s.fields.length) return finishSession(view, { caretAfter: true });
  if (target < 0) return true;
  if (current !== s.active) {
    // The caret was moved into another field by a click: leave from there.
    view.dispatch({ effects: setSession.of({ ...s, active: current }), annotations: statsEdit.of(true) });
  }
  return moveToField(view, target);
}

/** Enter (priority 95): finish, caret after the statistic. */
export function finishField(view: EditorView): boolean {
  const s = view.state.field(sessionField, false);
  if (!s || completionStatus(view.state) === 'active' || view.composing || !caretIn(view, s)) return false;
  return finishSession(view, { caretAfter: true });
}

/** Escape (priority 95): stop the fields, keeping the text. */
export function escapeFields(view: EditorView): boolean {
  const s = view.state.field(sessionField, false);
  if (!s || completionStatus(view.state) === 'active') return false;
  return stopSession(view);
}

/**
 * A click or arrow key that leaves the active field formats it: into another
 * field, that field becomes active; out of the statistic, the fields finish
 * where they are. Runs after the transaction (a view cannot dispatch inside
 * an update), and only if nothing changed in between.
 */
const leaveWatcher = EditorView.updateListener.of((u) => {
  if (!u.selectionSet || u.transactions.some((tr) => tr.annotation(statsEdit) || tr.effects.some((e) => e.is(setSession)))) return;
  const s = u.state.field(sessionField, false);
  if (!s || s.active < 0) return;
  const head = u.state.selection.main.head;
  const active = s.fields[s.active];
  if (active && head >= active.from && head <= active.to) return;
  const state = u.state;
  const view = u.view;
  queueMicrotask(() => {
    if (view.state !== state || view.composing) return;
    const now = view.state.field(sessionField, false);
    if (now !== s) return;
    if (head < s.from || head > s.to) { finishSession(view, { caretAfter: false }); return; }
    const target = fieldAt(s, head);
    if (target >= 0 && target !== s.active) moveToField(view, target, { select: false });
  });
});

export function fieldsExtension(): Extension {
  return [
    sessionField,
    EditorView.decorations.compute(['doc', sessionField], (state) => decorationsFor(state, state.field(sessionField))),
    leaveWatcher,
    fieldTheme,
  ];
}

/** Starts filling in a statistic whose text was just inserted (the session's positions are in the new document). */
export function sessionEffect(s: StatSession | null): StateEffect<StatSession | null> {
  return setSession.of(s);
}
