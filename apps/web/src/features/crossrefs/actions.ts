/**
 * What the cross-reference commands do to the editor (WP26): open the picker,
 * write the picked references as one undo step, and "Insert label here".
 * Every edit is explicit (the person pressed a key or chose a row) and local;
 * it reads the live document when it is applied, so text a collaborator
 * typed meanwhile is kept.
 */
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { EditorPageCtx } from '../types';
import { getSetting } from '../../settings/store';
import { applyExplicitEdit } from '../../editor/core/autoEdit';
import { atSentenceStart, cachedSetup } from '../citations/api';
import { cachedLabels } from './labelIndex';
import { labelPlan, labelsInText, uniqueName } from './labelSuggest';
import { buildReference, detectSetupIn, nameBefore, refSetupOf, type LabelDetail, type RefSetup, type RefStyle } from './refCommands';
import { CROSSREF_SETTINGS as ids, type CommandChoice } from './settings';
import { openRefPicker } from './store';

const isTex = (path: string | null) => !!path && /\.(tex|ltx)$/i.test(path);

export function setting<T>(id: string, fallback: T): T {
  try {
    const v = getSetting<T>(id);
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** The style Enter writes: the setting's choice. */
export function chosenStyle(): RefStyle {
  return setting<CommandChoice>(ids.command, 'auto');
}

/** The document's packages: the server's answer (WP15's cite-setup), else the open file's preamble. */
export function documentSetup(projectId: string, branch: string, state: EditorState | null): RefSetup {
  const server = refSetupOf(cachedSetup(projectId, branch) as unknown as Record<string, unknown> | null);
  if (server) return server;
  return detectSetupIn(state ? state.doc.sliceString(0, Math.min(state.doc.length, 20_000)) : '');
}

/** The view to act on, or null with the reason told to the person. */
function editableView(page: EditorPageCtx): EditorView | null {
  const view = page.view();
  if (!view || !isTex(page.activeFile())) return null;
  if (!page.canEdit() || page.showcase()) { page.toast('You can only view this project.', 'info'); return null; }
  if (view.state.readOnly) { page.toast('This file cannot be edited right now.', 'info'); return null; }
  return view;
}

/** ⇧⌘X: the picker. */
export function startRefPicker(page: EditorPageCtx): void {
  const view = editableView(page);
  if (!view) return;
  const sel = view.state.selection.main;
  const selected = sel.empty ? '' : view.state.sliceDoc(sel.from, sel.to);
  openRefPicker({
    page,
    query: selected.includes('\n') || selected.length > 80 ? '' : selected.trim(),
    file: page.activeFile() ?? '',
  });
}

/**
 * The change that writes `labels` at the selection of `state`: the
 * reference in `style` (bare `\ref` with `bare`), a space after a word, and
 * a tie after a kind name the person already typed ("Figure " → "Figure~").
 */
export function referenceChange(
  state: EditorState, labels: readonly LabelDetail[], setup: RefSetup,
  o: { style: RefStyle; bare?: boolean; capitalise?: boolean; spacing?: boolean },
): { from: number; to: number; insert: string } | null {
  if (!labels.length) return null;
  const sel = state.selection.main;
  const before = state.doc.sliceString(Math.max(0, sel.from - 400), sel.from);
  const style: RefStyle = o.bare ? 'ref' : o.style;
  const named = style === 'auto' || style === 'name' ? nameBefore(before, labels[0]) : null;
  const ref = buildReference(labels, { style, setup, sentenceStart: atSentenceStart(before), capitalise: o.capitalise, named: !!named });
  const spacing = o.spacing !== false;
  if (named) {
    if (named.sep === '~') return { from: sel.from, to: sel.to, insert: ref };
    if (spacing || !named.sep) return { from: sel.from - named.sep.length, to: sel.to, insert: `~${ref}` };
    return { from: sel.from, to: sel.to, insert: ref };
  }
  const space = spacing && /[\p{L}\p{N}]$/u.test(before) ? ' ' : '';
  return { from: sel.from, to: sel.to, insert: space + ref };
}

/** Writes the picked labels as one undo step. False when nothing could be written. */
export function applyReference(page: EditorPageCtx, labels: readonly LabelDetail[], style: RefStyle, bare: boolean): boolean {
  const view = editableView(page);
  if (!view || !labels.length) return false;
  const setup = documentSetup(page.projectId, page.branch, view.state);
  const change = referenceChange(view.state, labels, setup, {
    style, bare, capitalise: setting<boolean>(ids.capitalise, true), spacing: setting<boolean>(ids.spacing, true),
  });
  if (!change) return false;
  applyExplicitEdit(view, { changes: change, selection: { anchor: change.from + change.insert.length }, scrollIntoView: true }, 'input.ref');
  view.focus();
  return true;
}

/** The labels a new name must not repeat: this file's live text, and the project's other files. */
export function takenLabels(text: string, project: readonly LabelDetail[], file: string): Set<string> {
  const taken = new Set(labelsInText(text));
  for (const l of project) if (l.file !== file) taken.add(l.label);
  return taken;
}

const MOVED: Record<string, (what: string) => string> = {
  float: (w) => `The label goes after the caption, so it numbers the ${w}.`,
  heading: (w) => `The label goes after the ${w} heading.`,
  theorem: (w) => `The label goes at the start of the ${w}.`,
  item: () => 'The label goes right after \\item.',
};

/**
 * "Insert label here": a `\label{…}` named from the context, placed where it
 * numbers the right thing, with the slug selected so it can be typed over;
 * or, when the place already has a label, that label selected.
 */
export function insertLabelIn(view: EditorView, file: string, project: readonly LabelDetail[], notify: EditorPageCtx['toast']): boolean {
  const state = view.state;
  const text = state.doc.toString();
  const plan = labelPlan(text, state.selection.main.head);
  if (plan.existing) {
    view.dispatch({ selection: { anchor: plan.existing.from, head: plan.existing.to }, scrollIntoView: true });
    view.focus();
    notify(`This ${plan.what} already has a label.`, 'info');
    return false;
  }
  const name = uniqueName(plan.prefix, plan.slug, takenLabels(text, project, file));
  const insert = `${plan.pad}\\label{${name}}`;
  const nameFrom = plan.at + plan.pad.length + '\\label{'.length;
  applyExplicitEdit(view, {
    changes: { from: plan.at, insert },
    selection: { anchor: nameFrom + plan.prefix.length, head: nameFrom + name.length },
    scrollIntoView: true,
  }, 'input.label');
  view.focus();
  if (plan.moved && MOVED[plan.place]) notify(MOVED[plan.place](plan.what), 'info');
  return true;
}

/** The command: "Insert label here" in the open file. */
export function insertLabelHere(page: EditorPageCtx): void {
  const view = editableView(page);
  if (!view) return;
  insertLabelIn(view, page.activeFile() ?? '', cachedLabels(page.projectId, page.branch), page.toast);
}
