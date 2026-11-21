/**
 * What the citation commands do to the editor (WP19): open the picker on the
 * citation at the caret or for a new one, apply what the picker chose as one
 * undo step, switch narrative and parenthetical, and answer insertCitation's
 * command resolver. Every edit is explicit (the person pressed a key), local,
 * and minimal: a switch rewrites only the command name, an edit only the
 * characters that change, so a collaborator typing in the braces keeps their text.
 */
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { EditorPageCtx } from '../types';
import { getSetting } from '../../settings/store';
import { applyExplicitEdit } from '../../editor/core/autoEdit';
import {
  atSentenceStart, buildCitation, commandFor, detectFamilyIn, familyOfCommand, FAMILY_LABELS, minimalChange,
  parseCitationAt, styleOf, toggledCommand, wantsSpaceBefore, type CiteFamily, type CiteStyle, type ParsedCitation,
} from './citeCommands';
import { cachedSetup, loadSetup } from './refIndex';
import { CITATION_SETTINGS as ids, type FamilyChoice } from './settings';
import { openPicker, type PickerRequest } from './store';

const USER_EVENT = 'input.cite';

function setting<T>(id: string, fallback: T): T {
  try {
    const v = getSetting<T>(id);
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** The document's family: the setting when it names one, else the server's answer, else the open file's preamble, else plain BibTeX. */
export function documentFamily(projectId: string, branch: string, state: EditorState | null): { family: CiteFamily; label: string } {
  const choice = setting<FamilyChoice>(ids.family, 'auto');
  if (choice !== 'auto') return { family: choice, label: `${FAMILY_LABELS[choice]} (chosen in settings)` };
  const server = cachedSetup(projectId, branch);
  if (server) return { family: server.family, label: server.label };
  const local = state ? detectFamilyIn(state.doc.sliceString(0, Math.min(state.doc.length, 20_000))) : null;
  return { family: local ?? 'bibtex', label: FAMILY_LABELS[local ?? 'bibtex'] };
}

const isTex = (path: string | null) => !!path && /\.(tex|ltx)$/i.test(path);

/** The view to act on, or null with the reason told to the person. */
function editableView(page: EditorPageCtx): EditorView | null {
  const view = page.view();
  if (!view || !isTex(page.activeFile())) return null;
  if (!page.canEdit() || page.showcase()) { page.toast('You can only view this project.', 'info'); return null; }
  if (view.state.readOnly) { page.toast('This file cannot be edited right now.', 'info'); return null; }
  return view;
}

/** Each key cited in the text, with how often. */
export function citedKeys(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /\\[a-zA-Z]*[cC]ite[a-zA-Z]*\*?(?:<[^>\n]*>)?(?:\[[^\]\n]*\]){0,2}\{([^}]*)\}/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    for (const k of m[1].split(',')) {
      const key = k.trim();
      if (key) out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  return out;
}

/** ⇧⌘E: the picker, in edit mode when the caret is in a citation. */
export function startPicker(page: EditorPageCtx): void {
  const view = editableView(page);
  if (!view) return;
  void loadSetup(page.projectId, page.branch, true);
  const state = view.state;
  const text = state.doc.toString();
  const sel = state.selection.main;
  const citation = parseCitationAt(text, sel.head);
  if (citation && /cites\*?$/.test(citation.command)) {
    page.toast('Edit citations with several key groups in the source.', 'info');
    return;
  }
  const doc = documentFamily(page.projectId, page.branch, state);
  const selected = !citation && !sel.empty ? state.sliceDoc(sel.from, sel.to) : '';
  openPicker({
    page,
    mode: citation ? 'edit' : 'insert',
    family: (citation && familyOfCommand(citation.command)) || doc.family,
    familyLabel: doc.label,
    citation,
    query: selected.includes('\n') || selected.length > 100 ? '' : selected.trim(),
    cited: citedKeys(text),
  });
}

export interface PickerChoice {
  keys: readonly string[];
  style: CiteStyle;
  prenote: string;
  postnote: string;
}

/**
 * Writes the picker's choice as one undo step: a new citation at the caret
 * (replacing the selection), or the minimal change to the edited one. Reads
 * the live document, so text a collaborator typed meanwhile is kept.
 */
export function applyChoice(req: PickerRequest, choice: PickerChoice): boolean {
  const view = editableView(req.page);
  if (!view || !choice.keys.length) return false;
  const state = view.state;
  const text = state.doc.toString();
  const sel = state.selection.main;
  const capitalise = setting<boolean>(ids.capitalise, true);
  if (req.mode === 'edit') {
    const c = parseCitationAt(text, sel.head) ?? (req.citation ? parseCitationAt(text, Math.min(req.citation.to, text.length)) : null);
    if (c) {
      const family = familyOfCommand(c.command) ?? req.family;
      const kept = styleOf(c.command, family) === choice.style ? c.command : null;
      const command = kept ?? commandFor(family, choice.style, { sentenceStart: atSentenceStart(text.slice(0, c.from)), capitalise });
      if (!command) return false;
      const next = buildCitation({ command, keys: choice.keys, prenote: family === 'bibtex' ? '' : choice.prenote, postnote: choice.postnote, angle: c.angle !== null || family === 'apacite' });
      const change = minimalChange(text.slice(c.from, c.to), next, c.from);
      const end = c.from + next.length;
      if (change) applyExplicitEdit(view, { changes: change, selection: { anchor: end }, scrollIntoView: true }, USER_EVENT);
      else view.dispatch({ selection: { anchor: end }, scrollIntoView: true });
      view.focus();
      return true;
    }
  }
  const command = commandFor(req.family, choice.style, { sentenceStart: atSentenceStart(text.slice(0, sel.from)), capitalise });
  if (!command) return false;
  const citation = buildCitation({ command, keys: choice.keys, prenote: req.family === 'bibtex' ? '' : choice.prenote, postnote: choice.postnote, angle: req.family === 'apacite' });
  const space = setting<boolean>(ids.spacing, true) && wantsSpaceBefore(text.slice(Math.max(0, sel.from - 1), sel.from)) ? ' ' : '';
  const insert = space + citation;
  applyExplicitEdit(view, { changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, scrollIntoView: true }, USER_EVENT);
  view.focus();
  return true;
}

/** "Remove citation" in edit mode: the citation and the space before it, when one is left doubled or before punctuation. */
export function removeCitation(req: PickerRequest): boolean {
  const view = editableView(req.page);
  if (!view) return false;
  const text = view.state.doc.toString();
  const c = parseCitationAt(text, view.state.selection.main.head) ?? (req.citation ? parseCitationAt(text, Math.min(req.citation.to, text.length)) : null);
  if (!c) return false;
  const from = text[c.from - 1] === ' ' && /^(?:[ .,;:!?)]|$)/.test(text.slice(c.to, c.to + 1)) ? c.from - 1 : c.from;
  applyExplicitEdit(view, { changes: { from, to: c.to }, selection: { anchor: from }, scrollIntoView: true }, USER_EVENT);
  view.focus();
  return true;
}

/** The narrative/parenthetical switch for the citation at `pos`: the name's span and its replacement, or the reason it cannot switch. */
export function toggleAt(text: string, pos: number, family: CiteFamily): { from: number; to: number; insert: string } | { error: string } {
  const c: ParsedCitation | null = parseCitationAt(text, pos);
  if (!c) return { error: 'Put the cursor in a citation to switch it.' };
  const next = toggledCommand(c.command, family);
  if (!next) return { error: 'Only narrative and parenthetical citations switch.' };
  return { from: c.nameFrom, to: c.nameTo, insert: next };
}

/** ⇧⌘Space: switches the citation at the caret, keeping its keys and notes. */
export function toggleAtCaret(page: EditorPageCtx): void {
  const view = editableView(page);
  if (!view) return;
  const { family } = documentFamily(page.projectId, page.branch, view.state);
  const r = toggleAt(view.state.doc.toString(), view.state.selection.main.head, family);
  if ('error' in r) { page.toast(r.error, 'info'); return; }
  applyExplicitEdit(view, { changes: r, scrollIntoView: true }, USER_EVENT);
}

/** insertCitation's command (the Cite and Zotero panels): the document's parenthetical one, or null (\cite) when the switch is off. */
export function panelCommand(projectId: string, branch: string, state: EditorState): string | null {
  if (!setting<boolean>(ids.panels, true)) return null;
  void loadSetup(projectId, branch);
  const { family } = documentFamily(projectId, branch, state);
  return commandFor(family, 'parenthetical');
}
