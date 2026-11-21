import { EditorSelection, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { pickedCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { statsEdit } from '../../editor/core/autoEdit';
import { closeUndoStep } from '../../editor/visual/history';
import { CATALOGUE, entryByTrigger, type StatEntry } from './core/catalogue';
import { parseDecimal, passesThrough } from './core/format';
import { convertStatistics, recognise } from './core/parse';
import { render, sample, templateFields } from './core/render';
import { greekFor, insertionAt, paperMacros, statsConfig } from './config';
import { setSession, type StatSession } from './fields';

/**
 * Inserting a statistic (feature 16): from a trigger (`\pval`) through the
 * completion list or Tab, or from the picker. The text is plain LaTeX in the
 * house style; in prose each statistic has its own `$…$`, inside math there
 * are no `$`, and in a table cell values take the table form.
 */

export interface InsertResult { inserted: boolean; fields: number }

/** Inserts `entry` over from..to and starts its fields. `values` prefill fields by label. */
export function insertStatistic(
  view: EditorView, entry: StatEntry, range: { from: number; to: number },
  o: { values?: Record<string, string>; completion?: Completion } = {},
): InsertResult {
  const state = view.state;
  if (state.readOnly) return { inserted: false, fields: 0 };
  const cfg = state.facet(statsConfig);
  const where = insertionAt(state, range.from);
  const greek = greekFor(state, cfg.style);
  const r = render(entry, { context: where.context, style: cfg.style, greek, sColumn: where.sColumn, ...(o.values ? { values: o.values } : {}) });
  const fields = r.fields.map((f) => ({ ...f, from: f.from + range.from, to: f.to + range.from }));
  const end = range.from + r.text.length;
  const firstOpen = fields.findIndex((f) => f.from === f.to || (f.kind === 'LVL' && !o.values?.[f.label]));
  const filledAll = o.values && fields.every((f) => f.from < f.to);
  const session: StatSession | null = fields.length && !filledAll ? {
    template: entry.template, context: where.context, sColumn: where.sColumn, greek, style: cfg.style,
    from: range.from, to: end, fields, active: Math.max(0, firstOpen),
  } : null;
  const active = session ? session.fields[session.active] : null;
  closeUndoStep(state);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: r.text },
    selection: active ? EditorSelection.single(active.from, active.to) : EditorSelection.cursor(end),
    effects: setSession.of(session),
    annotations: [statsEdit.of(true), ...(o.completion ? [pickedCompletion.of(o.completion)] : [])],
    userEvent: 'input.complete',
    scrollIntoView: true,
  });
  closeUndoStep(view.state);
  return { inserted: true, fields: session ? session.fields.length : 0 };
}

/**
 * Inserts at the selection, as the picker does: a selection that reads as
 * statistics is converted instead; a single number fills the first value
 * field. With several cursors only the main one gets the statistic.
 */
export function insertAtSelection(view: EditorView, entry: StatEntry): InsertResult | { converted: number } {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to).trim();
  if (selected) {
    if (recognise(selected).length) {
      const n = convertRange(view, { from, to });
      if (n) return { converted: n };
    }
    if (!passesThrough(selected) && parseDecimal(selected)) {
      const first = templateFields(entry.template).find((f) => f.kind !== 'LVL');
      if (first) return insertStatistic(view, entry, { from, to }, { values: { [first.label]: selected } });
    }
  }
  return insertStatistic(view, entry, { from, to });
}

/** Converts recognised output in from..to to the house style as one undo step; returns how many blocks changed. */
export function convertRange(view: EditorView, range: { from: number; to: number }): number {
  const state = view.state;
  if (state.readOnly) return 0;
  const cfg = state.facet(statsConfig);
  const text = state.sliceDoc(range.from, range.to);
  const out = convertStatistics(text, { style: cfg.style, greek: greekFor(state, cfg.style) });
  if (!out.count || out.text === text) return 0;
  // Values the output lacked (the chi-square N) become fields to fill in.
  const empty = out.fields.filter((f) => f.from === f.to).map((f) => ({ ...f, from: f.from + range.from, to: f.to + range.from }));
  const session: StatSession | null = empty.length ? {
    template: null, context: 'prose', sColumn: false, greek: greekFor(state, cfg.style), style: cfg.style,
    from: range.from, to: range.from + out.text.length, fields: empty, active: 0,
  } : null;
  closeUndoStep(state);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: out.text },
    selection: session ? EditorSelection.cursor(session.fields[0].from) : EditorSelection.cursor(range.from + out.text.length),
    effects: setSession.of(session),
    annotations: statsEdit.of(true),
    userEvent: 'input.stats',
    scrollIntoView: true,
  });
  closeUndoStep(view.state);
  return out.count;
}

/** The paragraph around the caret (between blank lines). */
export function paragraphAt(state: EditorState, pos: number): { from: number; to: number } {
  let first = state.doc.lineAt(pos), last = first;
  while (first.number > 1) {
    const prev = state.doc.line(first.number - 1);
    if (!prev.text.trim()) break;
    first = prev;
  }
  while (last.number < state.doc.lines) {
    const next = state.doc.line(last.number + 1);
    if (!next.text.trim()) break;
    last = next;
  }
  return { from: first.from, to: last.to };
}

// ---------- triggers ----------

const TRIGGER_BEFORE = /\\([A-Za-z]+\d*)$/;

/** An odd run of backslashes before `at` escapes the next one (`\\pval` is a line break and a word). */
function escaped(text: string, at: number): boolean {
  let n = 0;
  for (let i = at - 1; i >= 0 && text[i] === '\\'; i--) n++;
  return n % 2 === 1;
}

/** Whether triggers may expand here at all: the setting, a .tex file's text, a table cell or math. */
function triggersHere(state: EditorState, from: number): boolean {
  if (!state.facet(statsConfig).triggers) return false;
  return insertionAt(state, from).triggerOk;
}

/** A complete trigger ending at `pos` (`\pval|`), when it may expand there. */
export function triggerBefore(state: EditorState, pos: number): { from: number; to: number; entry: StatEntry } | null {
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(Math.max(0, pos - line.from - 40), pos - line.from);
  const m = TRIGGER_BEFORE.exec(before);
  if (!m || escaped(before, m.index)) return null;
  if (/[A-Za-z0-9]/.test(state.sliceDoc(pos, pos + 1))) return null;
  const entry = entryByTrigger(`\\${m[1]}`);
  if (!entry) return null;
  const from = pos - m[0].length;
  if (paperMacros(state).has(m[1])) return null;
  if (!triggersHere(state, from)) return null;
  return { from, to: pos, entry };
}

/** Tab (priority 85) right after a typed trigger expands it. */
export function expandTrigger(view: EditorView): boolean {
  const sel = view.state.selection;
  if (sel.ranges.length > 1 || !sel.main.empty || view.state.readOnly) return false;
  const t = triggerBefore(view.state, sel.main.head);
  if (!t) return false;
  return insertStatistic(view, t.entry, t).inserted;
}

/**
 * Below a real command that matches as well (`\ci` lists `\circ` and `\cite`
 * first), above one that only matches loosely (`\pv` puts `\pval` above
 * `\providecommand`). A completion section would sink every statistic below
 * every loose match, so Enter after `\pv` would not insert `\pval`.
 */
const BOOST = -5;

function plainSample(entry: StatEntry): string {
  return sample(entry).replace(/\$/g, '').replace(/\\mathit\{([^}]*)\}|\\mathrm\{([^}]*)\}/g, '$1$2').replace(/\\%/g, '%').replace(/~/g, ' ');
}

function option(entry: StatEntry): Completion {
  const info = [`Laytekz statistic: ${plainSample(entry)}`, entry.rule].filter(Boolean).join('\n');
  const c: Completion = {
    label: entry.trigger!,
    detail: `${entry.title} · statistic`,
    info,
    type: 'stats',
    boost: BOOST,
    apply: (view, completion, from, to) => { insertStatistic(view, entry, { from, to }, { completion }); },
  };
  return c;
}

/** The statistics in the `\` completion list, below the real commands. */
export function statsCompletionSource(cx: CompletionContext): CompletionResult | null {
  const m = cx.matchBefore(/\\[A-Za-z]*\d*/);
  if (!m || (m.text.length < 2 && !cx.explicit)) return null;
  const line = cx.state.doc.lineAt(m.from);
  if (escaped(line.text, m.from - line.from)) return null;
  if (!triggersHere(cx.state, m.from)) return null;
  const hidden = paperMacros(cx.state);
  const options = CATALOGUE
    .filter((e) => e.trigger && e.trigger.startsWith(m.text) && !hidden.has(e.trigger.slice(1)))
    .map(option);
  if (!options.length) return null;
  return { from: m.from, options, validFor: /^\\[A-Za-z]*\d*$/ };
}
