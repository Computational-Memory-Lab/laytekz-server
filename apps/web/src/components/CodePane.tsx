import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
// Galley: V2 (WP05) gutters, active line, wrapping, brackets, completion and the language moved to editor/core/*.
import { EditorView, keymap, drawSelection, rectangularSelection, highlightSpecialChars, Decoration, DecorationSet } from '@codemirror/view';
import { EditorState, StateField, StateEffect, Compartment, Prec } from '@codemirror/state';
import { indentOnInput, indentUnit } from '@codemirror/language';
import { defaultKeymap, indentLess, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches } from '@codemirror/search';
import { acceptCompletion, completionKeymap } from '@codemirror/autocomplete';
import type * as Y from 'yjs';
import { yCollab, yUndoManagerKeymap, ySyncFacet, YRange } from 'y-codemirror.next';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { api, localUser } from '../api';
import { citeHoverTooltip, warmBib } from '../editor/latexExtras';
import { findKeymap, findPanel, gotoLineTop, openFind, restoreFind } from '../editor/findPanel';
import { formatChanges } from '../editor/formatChanges';
import { FORMAT_DOCUMENT_KEYS, matchesChord } from '../util/shortcuts';
import { spellcheckExtension } from '../editor/spellcheck';
import { setComments, CommentRange } from '../editor/commentsEffect';
import { visualExtensions, editAtCursor, publishEditorFocus, recordOwnCopies, type VisualDeps } from '../editor/visual';
import { agentHighlight } from '../editor/agentHighlight';
import { agentMarks, setAgentSeen } from '../editor/agentMarks';
import { toggleStyle, setSectionLevel, toggleItemize } from '../editor/visual/commands';
import { commentRangesField } from '../editor/visual/suggestions';
import { commentTips } from '../editor/commentTips';
import { documentOutline, OutlineEntry } from '../editor/visual/outline';
import type { PresenceUser } from './Presence';
import { useToast } from './Toast';
import type { Text } from '@codemirror/state';
import { safeStorage } from '../util/safeStorage';
import { loadVim, vimIfLoaded, vimWrite } from '../editor/vim';
import { diffGutter, setDiffBaseline, type DiffBaseline } from '../editor/diffGutter';
import { splitLines } from '../editor/lineDiff';
import { readOnlyDoc } from '../editor/readOnly';
import { openDoc, parkDoc } from '../editor/docCache';
import { captureSpot, clampSpot, fileSpots, spotScroll, spotSelection } from '../editor/fileSpots';
import { jumpEffects, jumpHold } from '../editor/jumpHold';
import { watchSync, reconnectProvider, type SyncState } from '../editor/syncStatus';
import { citationEdit } from '../editor/citeInsert';
// Galley: V2 (WP05) the editor host: feature compartments, the core extraction and the editor settings.
import { latexHighlighting, latexLanguage } from '../editor/core/language';
import { beginBraceExtensions, bracketExtensions, bracketKeymap } from '../editor/core/brackets';
import { CompletionSlot, coreCompletionSources } from '../editor/core/completion';
import { EDITOR_SETTING_ID_LIST, EditorSettingsSlots, readEditorSettings, watchSettings } from '../editor/core/editorSettings';
import { createEditorFeatureCtx, EditorFeatureHost } from '../editor/core/featureHost';
import { citeCommandFor } from '../editor/core/hooks';
import { undoBoundaryFrom } from '../editor/visual/history';
import type { CodePaneFeatureHandle, CodePaneFeatureHost } from '../features/types';
// Galley: V2 (WP02 R2) the settings whose CSS variables change the editor's metrics.
import { CORE_EXTRA_IDS } from '../settings/registry/core';

const TYPOGRAPHY_SETTING_IDS = [
  CORE_EXTRA_IDS.editorFont, CORE_EXTRA_IDS.editorFontSize, CORE_EXTRA_IDS.editorLineHeight, CORE_EXTRA_IDS.editorLigatures,
  CORE_EXTRA_IDS.uiScale, CORE_EXTRA_IDS.visualFontSize, CORE_EXTRA_IDS.visualWidth,
] as const;

export type EditorMode = 'source' | 'visual';

/**
 * Re-anchor a comment by its stored quote when its saved offset has drifted
 * (edits above it made while it wasn't being live-tracked — reload, another
 * user's edits). Uses the occurrence of the quote nearest the saved offset;
 * falls back to the clamped saved offset when the quote can't be found. With
 * `context` (a search match), an occurrence whose surrounding text still
 * reads the same is preferred: an insert above moves an earlier occurrence
 * onto the saved offset, and the nearest one is then the wrong one.
 */
function reanchor<R extends { from: number; to: number; quote?: string }>(doc: Text, r: R, context?: MatchContext): R {
  const len = doc.length;
  const from = Math.min(Math.max(0, r.from), len);
  const to = Math.min(Math.max(from, r.to), len);
  const quote = r.quote;
  if (!quote) return { ...r, from, to };
  const fits = (i: number) => !context
    || (doc.sliceString(Math.max(0, i - context.before.length), i) === context.before
      && doc.sliceString(i + quote.length, Math.min(len, i + quote.length + context.after.length)) === context.after);
  if (doc.sliceString(from, to) === quote && fits(from)) return { ...r, from, to }; // still exact
  const text = doc.toString();
  let best = -1, bestDist = Infinity;
  for (const strict of context ? [true, false] : [false]) {
    for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
      if (strict && !fits(i)) continue;
      const d = Math.abs(i - r.from);
      if (d < bestDist) { best = i; bestDist = d; }
    }
    if (best !== -1) break;
  }
  if (best === -1) return { ...r, from, to }; // quote gone — keep clamped offset
  return { ...r, from: best, to: best + quote.length };
}

/** The text a search showed on either side of a match, on its line. */
export interface MatchContext { before: string; after: string }

// Galley: V2 (WP05) the handle gains view() (CodePaneFeatureHandle).
export interface CodePaneHandle extends CodePaneFeatureHandle {
  /** Deferred until the collab doc has synced: a fresh pane holds an empty
   *  document until then, and line N of nothing is line 1. */
  /** onClamped fires (with the line count) when `line` is past the end of the doc. */
  gotoLine(line: number, opts?: { flash?: boolean; onClamped?: (lines: number) => void }): void;
  /** Select from..to, re-anchored by `quote` (and the text around it) when
   *  edits moved it, and scroll it into view; deferred like gotoLine.
   *  Selection only: no document change. */
  selectRange(from: number, to: number, opts: { quote: string; focus: boolean; context?: MatchContext }): void;
  insertAtCursor(text: string): void;
  /** Cites `key` at the cursor (citeInsert.ts): 'inserted' a new \cite, 'added' to the citation there, or
   *  'present' already; null when the document cannot take it (no view, read-only). */
  insertCitation(key: string): 'inserted' | 'added' | 'present' | null;
  currentLine(): number | null;
  getSelection(): { from: number; to: number; quote: string } | null;
  setCommentRanges(ranges: CommentRange[]): void;
  revealPos(pos: number): void;
  format(action: 'bold' | 'italic' | 'list' | { section: 1 | 2 | 3 | 4 }): void;
  getOutline(): OutlineEntry[];
  /** Keyboard focus back to the text, the caret where it was. */
  focus(): void;
  /** Visual mode: opens the formula editor or the table grid at the caret. 'source': a formula
   *  that edits only as source, which the caret is already in; null: neither is at the caret. */
  editAtCursor(): 'opened' | 'source' | null;
  /** Open the collab connection again, on a fresh socket: after a sign-in
   *  in place, so edits this tab holds reach the server. */
  reconnect(): void;
  /** Changes the open document as `edit` says once it has synced, in one undo step of its own; `done` says whether anything changed. */
  editDocument(edit: (text: string) => Array<{ from: number; to: number; insert: string }> | null, done?: (changed: boolean) => void): void;
  /** In-file Find, its search (or replace) field focused; false without an editor to find in. */
  openFind(field?: 'search' | 'replace'): boolean;
  /** The Go to line prompt above the text. */
  gotoLinePrompt(): void;
  /** Runs `format` on the document's text and indent unit, then applies only
   *  the characters that differ, in one undo step of its own. 'stale': the
   *  document changed before `format` answered, and nothing was applied;
   *  null: no synced document this editor may change, or the pane moved on
   *  to another file. A rejection of `format` passes through. */
  formatDocument(format: (text: string, indent: string) => Promise<string>): Promise<'formatted' | 'unchanged' | 'stale' | null>;
}

/** Comment highlight decorations, updatable via an effect and tracking edits.
 *  Each carries its comment's id, which editor/commentTips and the tests read. */
const commentMark = (r: CommentRange) => Decoration.mark({ class: r.resolved ? 'cm-comment-range cm-comment-resolved' : 'cm-comment-range', attributes: { 'data-comment-id': r.id } });
const commentField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setComments)) {
        const docLen = tr.state.doc.length;
        deco = Decoration.set(
          e.value
            .filter((r) => r.from < r.to && r.to <= docLen)
            .sort((a, b) => a.from - b.from)
            .map((r) => commentMark(r).range(r.from, r.to)),
          true,
        );
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** One-shot line highlight for deep links (?file=&line=): a line decoration
 *  the CSS animates out; cleared by a timer, tracked through edits meanwhile. */
const FLASH_MS = 1600;
const flashLine = StateEffect.define<number>(); // doc offset of the line start
const clearFlash = StateEffect.define<null>();
const flashMark = Decoration.line({ class: 'cm-deeplink-flash', attributes: { 'data-testid': 'deeplink-flash' } });
const flashField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashLine)) deco = Decoration.set([flashMark.range(tr.state.doc.lineAt(e.value).from)]);
      else if (e.is(clearFlash)) deco = Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

interface Props {
  projectId: string;
  branch: string;
  filePath: string;
  /** Project root file — figure previews resolve image paths against its dir. */
  rootFile?: string;
  onUsers(users: PresenceUser[]): void;
  /** Fires on every doc change; `local` is false for applied remote updates. */
  onDocChanged?(local: boolean): void;
  onStats?(stats: { words: number; selWords: number | null }): void;
  spellcheck?: boolean;
  /** The spellcheck dictionary's language; '' follows the browser. */
  spellLang?: string;
  /** The open .tex file's headings and the one the caret is under (-1: none), when either changes. */
  onOutline?(outline: { entries: OutlineEntry[]; current: number }): void;
  /** Vim keybindings (this browser's choice). */
  vim?: boolean;
  /** Vim's :w, :wq and :x. */
  onWrite?(): void;
  /** The collab server refused this session the document: the owner took
   *  this account's access away, or the session ended. */
  onAccessDenied?(): void;
  mode?: EditorMode;
  /** Who this client is to collaborators (awareness): the account when
   *  signed in; without one the browser's anonymous "Writer N". */
  identity?: { name: string; color: string; avatar?: string };
  /** A read-only showcase: nothing typed or inserted here changes the text. */
  readOnly?: boolean;
  /** Whether this file's edits have reached the server; on every change. */
  onSync?(s: SyncState): void;
  /** What the server lets this socket do, on every (re)connect: a role the
   *  owner changed while the pane is open shows here first. */
  onScope?(readOnly: boolean): void;
  /** "Open in Review" on a commented text's card. */
  onOpenComment?(id: string): void;
  /** The comment the caret is in, whenever that changes (null: none). */
  onCommentCaret?(id: string | null): void;
  /** This person's agent review mark (server ms): Claude's changes after it
   *  are marked in the gutter. Null while unknown. */
  agentSeenAt?: number | null;
  /** Mark the lines changed since the branch's last checkpoint (source mode). */
  changeMarks?: boolean;
  /** Bumped when the branch's history may have moved: the baseline is asked again. */
  baselineVersion?: number;
  /** Format document's keys (Shift+Alt+F) in the text. */
  onFormat?(): void;
  /** The project commits by hand: the baseline is the last commit. */
  manualCommits?: boolean;
  // Galley: V2 (WP05) the feature modules and the page they run on.
  /** The enabled feature modules and the page around the pane; absent, no
   *  feature runs. Read when a file opens: a change applies to the next file. */
  featureHost?: CodePaneFeatureHost;
}

/** Approximate word count for LaTeX prose: strips comments, commands, math. */
export function latexWordCount(src: string): number {
  const stripped = src
    .replace(/(^|[^\\])%.*$/gm, '$1')            // comments
    .replace(/\\begin\{[^}]*\}|\\end\{[^}]*\}/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, ' EQN ') // math counts as one word
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])*/g, ' ')   // commands (keep brace contents)
    .replace(/[{}~]/g, ' ');
  const words = stripped.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu);
  return words ? words.length : 0;
}

const aldineTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg-panel)', color: 'var(--text)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
  // remote collaborator caret + always-visible name label (y-codemirror.next)
  '.cm-ySelectionCaret': { position: 'relative', borderLeftWidth: '1.5px', borderRightWidth: '1.5px', marginLeft: '-1px', marginRight: '-1px', boxSizing: 'border-box' },
  '.cm-ySelectionInfo': {
    position: 'absolute', top: '-1.35em', left: '-1px', fontSize: '10px', fontWeight: '600', lineHeight: 'normal',
    color: '#fff', padding: '1px 5px', borderRadius: '4px 4px 4px 0', whiteSpace: 'nowrap', opacity: '1',
    userSelect: 'none', pointerEvents: 'none', zIndex: '20', fontFamily: 'var(--font-sans)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-panel)',
    border: '1px solid var(--hairline)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow-pop)',
    fontFamily: 'var(--font-ui)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-fill)', color: 'var(--on-accent)' },
  '.cm-completionDetail': { fontStyle: 'normal', opacity: 0.65, fontSize: '11px' },
  '.cm-panels': { backgroundColor: 'var(--bg-inset)', color: 'var(--text)', borderColor: 'var(--hairline)' },
});

/** The heading `line` is under: the last one at or above it, -1 above the first. */
function headingAt(entries: OutlineEntry[], line: number): number {
  let at = -1;
  for (let i = 0; i < entries.length && entries[i].line <= line; i++) at = i;
  return at;
}

const sameOutline = (a: OutlineEntry[], b: OutlineEntry[]) =>
  a.length === b.length && a.every((h, i) => h.line === b[i].line && h.level === b[i].level && h.title === b[i].title && h.pos === b[i].pos);

const CodePane = forwardRef<CodePaneHandle, Props>(function CodePane({ projectId, branch, filePath, rootFile, onUsers, onDocChanged, onStats, spellcheck = false, spellLang = '', onOutline, vim = false, onWrite, onAccessDenied, mode = 'source', identity, readOnly = false, onSync, onScope, onOpenComment, onCommentCaret, agentSeenAt = null, changeMarks = false, baselineVersion = 0, manualCommits = false, onFormat, featureHost }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const cbRef = useRef({ onDocChanged, onStats, onWrite, onAccessDenied, onSync, onOutline, onScope, onOpenComment, onCommentCaret, onFormat });
  cbRef.current = { onDocChanged, onStats, onWrite, onAccessDenied, onSync, onOutline, onScope, onOpenComment, onCommentCaret, onFormat };
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  // Per-mount reconfiguration handles: compartments + the deps visualExtensions needs.
  // Galley: V2 (WP05) plus the editor settings' compartments, the completion list and the feature host.
  const reconfRef = useRef<{
    modeComp: Compartment; spellComp: Compartment; vimComp: Compartment; diffComp: Compartment; deps: VisualDeps;
    settings: EditorSettingsSlots; completion: CompletionSlot; features: EditorFeatureHost | null;
  } | null>(null);
  // Galley: V2 (WP05) what the feature context and the late-bound handle methods read live.
  const featureHostRef = useRef(featureHost);
  featureHostRef.current = featureHost;
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  /** The open file's change-mark baseline, once loaded; null: no marks. */
  const baselineRef = useRef<DiffBaseline | null>(null);
  const readOnlyRef = useRef<{ comp: Compartment; ydoc: Y.Doc; on: boolean } | null>(null);
  const lastCommentRanges = useRef<CommentRange[]>([]);
  const agentSeenRef = useRef(agentSeenAt);
  agentSeenRef.current = agentSeenAt;
  const syncedRef = useRef(false);
  const pendingGoto = useRef<
    | { kind: 'line'; line: number; flash: boolean; onClamped?: (lines: number) => void }
    | { kind: 'range'; from: number; to: number; quote: string; focus: boolean; context?: MatchContext }
    | null
  >(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoRef = useRef<Y.UndoManager | null>(null);
  const pendingEdits = useRef<Array<() => void>>([]);

  const applyRange = (view: EditorView, from: number, to: number, quote: string, focus: boolean, context?: MatchContext) => {
    const r = reanchor(view.state.doc, { from, to, quote }, context);
    view.dispatch({ selection: { anchor: r.from, head: r.to }, effects: jumpEffects(r.from) });
    if (focus) view.focus();
  };

  const applyGoto = (view: EditorView, line: number, flash: boolean, onClamped?: (lines: number) => void) => {
    const l = Math.min(Math.max(1, line), view.state.doc.lines);
    if (line > view.state.doc.lines) onClamped?.(view.state.doc.lines);
    const pos = view.state.doc.line(l).from;
    const effects = [...jumpEffects(pos), ...(flash ? [flashLine.of(pos)] : [])];
    view.dispatch({ selection: { anchor: pos }, effects });
    view.focus();
    if (flash) {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => {
        flashTimer.current = null;
        if (viewRef.current === view) view.dispatch({ effects: clearFlash.of(null) });
      }, FLASH_MS);
    }
  };

  useImperativeHandle(ref, () => ({
    gotoLine(line: number, opts?: { flash?: boolean; onClamped?: (lines: number) => void }) {
      const view = viewRef.current;
      // Before the view exists (handle is live from the first commit, the
      // view from the mount effect) or before the doc has synced: queue it.
      if (!view || !syncedRef.current) { pendingGoto.current = { kind: 'line', line, flash: !!opts?.flash, onClamped: opts?.onClamped }; return; }
      applyGoto(view, line, !!opts?.flash, opts?.onClamped);
    },
    selectRange(from: number, to: number, opts: { quote: string; focus: boolean; context?: MatchContext }) {
      const view = viewRef.current;
      if (!view || !syncedRef.current) { pendingGoto.current = { kind: 'range', from, to, quote: opts.quote, focus: opts.focus, context: opts.context }; return; }
      applyRange(view, from, to, opts.quote, opts.focus, opts.context);
    },
    insertAtCursor(text: string) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
    },
    insertCitation(key: string) {
      const view = viewRef.current;
      if (!view || view.state.readOnly) return null;
      const sel = view.state.selection.main;
      // Galley: V2 (WP05, WP19) a new citation uses the command the document calls for (core/hooks.ts; \cite by default).
      const edit = citationEdit(view.state.doc.toString(), sel.from, key, sel.to, citeCommandFor(view.state, filePathRef.current));
      if (edit.kind === 'present') view.dispatch({ selection: { anchor: edit.cursor }, scrollIntoView: true });
      else view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: { anchor: edit.cursor }, scrollIntoView: true, userEvent: 'input' });
      view.focus();
      return edit.kind === 'insert' ? 'inserted' : edit.kind === 'add' ? 'added' : 'present';
    },
    currentLine() {
      const view = viewRef.current;
      if (!view) return null;
      return view.state.doc.lineAt(view.state.selection.main.head).number;
    },
    getSelection() {
      const view = viewRef.current;
      if (!view) return null;
      const sel = view.state.selection.main;
      if (sel.empty) return null;
      return { from: sel.from, to: sel.to, quote: view.state.sliceDoc(sel.from, sel.to) };
    },
    setCommentRanges(ranges) {
      lastCommentRanges.current = ranges; // remember for a re-apply once the doc syncs
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ effects: setComments.of(ranges.map((r) => reanchor(view.state.doc, r))) });
    },
    revealPos(pos) {
      const view = viewRef.current;
      if (!view) return;
      const p = Math.min(Math.max(0, pos), view.state.doc.length);
      view.dispatch({ selection: { anchor: p }, effects: jumpEffects(p) });
      view.focus();
    },
    format(action) {
      const view = viewRef.current;
      if (!view) return;
      if (action === 'bold') toggleStyle('bold')(view);
      else if (action === 'italic') toggleStyle('italic')(view);
      else if (action === 'list') toggleItemize(view);
      else setSectionLevel(action.section)(view);
      view.focus();
    },
    getOutline() {
      const view = viewRef.current;
      return view ? documentOutline(view.state) : [];
    },
    focus() {
      viewRef.current?.focus();
    },
    editAtCursor() {
      const view = viewRef.current;
      return view ? editAtCursor(view) : null;
    },
    reconnect() {
      if (providerRef.current) reconnectProvider(providerRef.current);
    },
    editDocument(edit, done) {
      const run = () => {
        const view = viewRef.current;
        const changes = view ? edit(view.state.doc.toString()) : null;
        if (!view || !changes?.length) { done?.(false); return; }
        undoRef.current?.stopCapturing();
        view.dispatch({ changes, userEvent: 'input' });
        undoRef.current?.stopCapturing();
        done?.(true);
      };
      if (viewRef.current && syncedRef.current) run();
      else pendingEdits.current.push(run);
    },
    openFind(field) {
      const view = viewRef.current;
      return view ? openFind(view, field) : false;
    },
    gotoLinePrompt() {
      const view = viewRef.current;
      if (view) gotoLineTop(view);
    },
    async formatDocument(format) {
      const view = viewRef.current;
      if (!view || !syncedRef.current || view.state.readOnly) return null;
      const doc = view.state.doc;
      const before = doc.toString();
      const after = await format(before, view.state.facet(indentUnit));
      if (viewRef.current !== view) return null;
      // Any edit meanwhile, here or a collaborator's, makes a new doc.
      if (view.state.doc !== doc) return 'stale';
      const changes = formatChanges(before, after);
      // Galley: V2 (WP05) the features' afterFormat runs inside the same undo step.
      const features = reconfRef.current?.features ?? null;
      const more = !!features?.hasAfterFormat();
      if (!changes.length && !more) return 'unchanged';
      undoRef.current?.stopCapturing();
      if (changes.length) view.dispatch({ changes, userEvent: 'input.format' });
      const moved = more && features!.runAfterFormat(view);
      undoRef.current?.stopCapturing();
      return changes.length || moved ? 'formatted' : 'unchanged';
    },
    // Galley: V2 (WP05) the live view, for the page context (CodePaneFeatureHandle).
    view() {
      return viewRef.current;
    },
  }), []);

  // A layout effect: the view is in place before the browser paints the
  // switch, and the cleanup reads the scroll position while the pane is
  // still in the document.
  useLayoutEffect(() => {
    if (!hostRef.current) return;
    let statsTimer: ReturnType<typeof setTimeout> | null = null;
    let outlineTimer: ReturnType<typeof setTimeout> | null = null;
    let outline: { entries: OutlineEntry[]; current: number } | null = null;
    // Read again only after the typing stops: the whole file is parsed for it.
    const reportOutline = (reparse: boolean) => {
      const view = viewRef.current;
      if (!view || !cbRef.current.onOutline || !/\.tex$/i.test(filePath)) return;
      const entries = reparse || !outline ? documentOutline(view.state) : outline.entries;
      const current = headingAt(entries, view.state.doc.lineAt(view.state.selection.main.head).number);
      if (outline && outline.current === current && sameOutline(outline.entries, entries)) return;
      outline = { entries: outline && sameOutline(outline.entries, entries) ? outline.entries : entries, current };
      cbRef.current.onOutline(outline);
    };
    warmBib(projectId, branch); // so \cite hover tooltips have data immediately
    const docName = `${projectId}::${branch}::${filePath}`;
    // A file left recently comes back from editor/docCache already synced,
    // with its undo history; any other loads empty until 'synced'.
    const doc = openDoc(docName);
    const { ydoc, ytext, provider, undoManager } = doc;
    // Doc-change notifications come from the Y level, not the CM update
    // listener: tr.local distinguishes this client's edits from applied remote
    // updates, so auto-typeset can react to typing without every collaborator
    // recompiling on every remote keystroke.
    const onYChange = (_e: unknown, tr: { local: boolean }) => cbRef.current.onDocChanged?.(tr.local);
    ytext.observe(onYChange);
    const user = identity ?? localUser();
    provider.setAwarenessField('user', { name: user.name, color: user.color, colorLight: user.color + '55', ...('avatar' in user && user.avatar ? { avatar: user.avatar } : {}) });

    const awareness = provider.awareness!;
    const modeComp = new Compartment();
    const spellComp = new Compartment();
    const vimComp = new Compartment();
    const diffComp = new Compartment();
    const readOnlyComp = new Compartment();
    // Until the first sync the editor holds an empty document: an edit made to
    // it would land at the top of the file once the server's text arrives.
    const loadGate = new Compartment();
    const deps: VisualDeps = { projectId, branch, rootFile, ydoc, awareness, undoManager, notify: (text, kind) => toastRef.current(text, kind) };
    undoRef.current = undoManager;
    // Galley: V2 (WP05) the editor settings, the completion list and the feature host of this pane.
    const editorSettings = readEditorSettings();
    const settings = new EditorSettingsSlots(editorSettings, mode, provider.isSynced ? ytext.toString() : null);
    const completion = new CompletionSlot(coreCompletionSources(projectId, branch, () => filePath), editorSettings.completion,
      (_f, err) => console.warn('[editor] a completion filter failed', err));
    const host = featureHostRef.current;
    const features = host ? new EditorFeatureHost({
      modules: host.modules,
      ctx: createEditorFeatureCtx({
        projectId, branch, filePath, rootFile: rootFile ?? null, ydoc, ytext, awareness, undoManager,
        identity: () => {
          const who = identityRef.current ?? localUser();
          return { id: featureHostRef.current?.userId ?? null, name: who.name, color: who.color };
        },
        mode: () => modeRef.current,
        readOnly: () => viewRef.current?.state.readOnly ?? true,
        synced: () => syncedRef.current,
        host: () => featureHostRef.current,
      }),
      filePath,
      mode,
      completion,
      page: () => featureHostRef.current?.page() ?? null,
      runCommand: (id) => featureHostRef.current?.runCommand(id) ?? false,
    }) : null;
    const chains = !!features?.keyChainsInstalled;
    // First-seen times per agent client, so the presence tooltip can say when
    // the session started; entries drop with the awareness state so the next
    // session (same server-side clientID) gets a fresh start time. A start
    // time the server sends wins: it predates this page's load.
    const agentSince = new Map<number, number>();
    const reportUsers = () => {
      // key by Yjs clientID so two collaborators with the same display name stay distinct
      const byClient = new Map<number, PresenceUser>();
      awareness.getStates().forEach((s, clientId) => {
        const u = (s as { user?: PresenceUser }).user;
        if (!u?.name) return;
        if (u.isAgent && !agentSince.has(clientId)) agentSince.set(clientId, Date.now());
        byClient.set(clientId, u.isAgent ? { ...u, startedAt: u.startedAt ?? agentSince.get(clientId) } : u);
      });
      for (const cid of [...agentSince.keys()]) if (!byClient.has(cid)) agentSince.delete(cid);
      onUsers(Array.from(byClient.values()));
    };
    awareness.on('change', reportUsers);
    reportUsers();

    // A kept doc opens where its pane left it; a loading one once it syncs.
    const spot = fileSpots.get(docName);
    const start = provider.isSynced && spot ? clampSpot(spot, ytext.length) : null;
    let restore = provider.isSynced ? null : spot;
    const view = new EditorView({
      parent: hostRef.current,
      scrollTo: start ? spotScroll(start) : undefined,
      state: EditorState.create({
        doc: ytext.toString(),
        selection: start ? spotSelection(start) : undefined,
        extensions: [
          // first, though its own precedence already puts it ahead of every keymap
          vimComp.of((vim && vimIfLoaded()) || []),
          vimWrite.of(() => cbRef.current.onWrite?.()),
          // Galley: V2 (WP05) each setting-driven extension in a compartment where V1 had it (core/editorSettings.ts).
          settings.slot('numbers'),
          // Visual hides the gutters: the marks are a Source view only.
          diffComp.of(changeMarks && mode === 'source' ? diffGutter(provider.isSynced ? baselineRef.current : null, manualCommits ? 'commit' : 'checkpoint') : []),
          settings.slot('activeLineGutter'),
          highlightSpecialChars(),
          settings.slot('whitespace'),
          settings.slot('fold'),
          drawSelection(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          latexHighlighting(),
          bracketExtensions(filePath),
          rectangularSelection(),
          settings.slot('activeLine'),
          jumpHold,
          highlightSelectionMatches(),
          // Galley: V2 (WP05) the one autocompletion(): core sources, then the features' (core/completion.ts).
          completion.extension,
          latexLanguage(),
          beginBraceExtensions(),
          citeHoverTooltip(projectId, branch),
          // Galley: V2 (WP05) with the feature host, the key chains own Tab (completion 100, indent 0);
          // its editor keybindings, mod-click and context menu go here too.
          features ? features.input : [],
          // Tab takes the highlighted completion; with no list open it indents
          chains ? [] : Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
          // ahead of defaultKeymap, whose Mod-i selects the parent syntax node
          Prec.high(keymap.of([
            { key: 'Mod-b', run: toggleStyle('bold') },
            { key: 'Mod-i', run: toggleStyle('italic') },
          ])),
          // VS Code's Format Document keys, by physical key: CodeMirror's keymap
          // reads Option+Shift+F on a Mac as the character it types (Ï).
          EditorView.domEventHandlers({
            keydown: (e) => {
              const f = cbRef.current.onFormat;
              if (!f || !matchesChord(e, FORMAT_DOCUMENT_KEYS)) return false;
              e.preventDefault();
              f();
              return true;
            },
          }),
          findPanel(),
          keymap.of([
            ...bracketKeymap,
            // Mod-Enter typesets (the editor page's keys), after Visual's formula and table editors
            ...defaultKeymap.filter((b) => b.key !== 'Mod-Enter'),
            ...findKeymap,
            ...yUndoManagerKeymap,
            ...completionKeymap,
            // Galley: V2 (WP05) the chains' indent 0 has Tab; Shift-Tab still outdents when no chain entry takes it.
            chains ? { key: 'Shift-Tab', run: indentLess } : indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged || u.selectionSet) {
              if (statsTimer) clearTimeout(statsTimer);
              statsTimer = setTimeout(() => {
                const state = viewRef.current?.state;
                if (!state || !cbRef.current.onStats) return;
                const sel = state.selection.main;
                cbRef.current.onStats({
                  words: latexWordCount(state.doc.toString()),
                  selWords: sel.empty ? null : latexWordCount(state.sliceDoc(sel.from, sel.to)),
                });
              }, 350);
            }
            if (u.docChanged) {
              if (outlineTimer) clearTimeout(outlineTimer);
              outlineTimer = setTimeout(() => { outlineTimer = null; reportOutline(true); }, 400);
            } else if (u.selectionSet && !outlineTimer) {
              reportOutline(false);
            }
          }),
          commentField,
          // outside the mode compartment: a copy in Source pastes as source in Visual
          recordOwnCopies,
          // outside the mode compartment: Visual's inline suggestions read it when they mount
          commentRangesField,
          commentTips((id) => cbRef.current.onOpenComment?.(id), (id) => cbRef.current.onCommentCaret?.(id)),
          flashField,
          aldineTheme,
          settings.slot('wrap'), // Galley: V2 (WP05) EditorView.lineWrapping, unless Source wrapping is off
          // browser-native spellcheck on prose (only meaningful for .tex/.md)
          spellComp.of(spellcheckExtension(spellcheck, spellLang, filePath)),
          EditorView.contentAttributes.of({ 'aria-label': `Text of ${filePath}` }),
          readOnlyComp.of(readOnly ? readOnlyDoc(ydoc) : []),
          loadGate.of(provider.isSynced ? [] : readOnlyDoc(ydoc)),
          // Galley: V2 (WP05) indentation, Source mode's undo boundary, and the feature compartments, outside the mode compartment.
          settings.slot('indent'),
          undoBoundaryFrom(undoManager),
          features ? features.extension : [],
          modeComp.of(mode === 'visual' ? visualExtensions(deps) : settings.sourceMode()),
          yCollab(ytext, awareness, { undoManager }),
          publishEditorFocus(awareness),
          agentMarks(ydoc, ytext, agentSeenRef.current),
          ...(safeStorage.get('aldine.experimental.agentPresence') === '1'
            ? [agentHighlight(ydoc, ytext, () => provider.isSynced)]
            : []),
        ],
      }),
    });
    viewRef.current = view;
    reconfRef.current = { modeComp, spellComp, vimComp, diffComp, deps, settings, completion, features };
    // Galley: V2 (WP05) settings changes reconfigure their compartments in place.
    const offSettings = watchSettings(EDITOR_SETTING_ID_LIST, () => {
      const values = readEditorSettings();
      const effects = settings.update({ values });
      const list = completion.update({ activation: values.completion });
      if (list) effects.push(list);
      if (effects.length && viewRef.current === view) view.dispatch({ effects });
    });
    const offFeatures = features ? features.watch((effects) => { if (viewRef.current === view) view.dispatch({ effects }); }) : () => {};
    // Galley: V2 (WP02 R2) the typography settings are CSS variables on <html>
    // (settings/apply.ts), which CodeMirror never notices: without a measure
    // the caret and line heights keep the old size until a scroll or resize.
    const offTypography = watchSettings(TYPOGRAPHY_SETTING_IDS, () => {
      requestAnimationFrame(() => { if (viewRef.current === view) view.requestMeasure(); });
    });
    restoreFind(view);
    readOnlyRef.current = { comp: readOnlyComp, ydoc, on: readOnly };

    // Undo steps from an earlier pane on this doc keep their selection under
    // that pane's binding, which this one cannot read: the caret is put
    // where the step was here.
    const earlier = new WeakSet<object>([...undoManager.undoStack, ...undoManager.redoStack]);
    const onPopped = ({ stackItem }: { stackItem: { meta: Map<unknown, unknown> } }) => {
      if (!earlier.has(stackItem)) return;
      const range = [...stackItem.meta.values()].find((v): v is YRange => v instanceof YRange);
      if (!range) return;
      try {
        const sel = view.state.facet(ySyncFacet).fromYRange(range);
        view.dispatch({ selection: sel, effects: EditorView.scrollIntoView(sel) });
      } catch { /* a position from before the server replaced the text */ }
    };
    undoManager.on('stack-item-popped', onPopped);

    syncedRef.current = provider.isSynced;
    const initialStats = () => {
      // 'synced' also fires when the connection drops, with nothing loaded yet.
      if (!provider.isSynced) return;
      syncedRef.current = true;
      const goto = pendingGoto.current;
      pendingGoto.current = null;
      const back = restore;
      restore = null;
      if (goto?.kind === 'line') applyGoto(view, goto.line, goto.flash, goto.onClamped);
      else if (goto?.kind === 'range') applyRange(view, goto.from, goto.to, goto.quote, goto.focus, goto.context);
      else if (back) {
        const s = clampSpot(back, view.state.doc.length);
        view.dispatch({ selection: spotSelection(s), effects: spotScroll(s) });
      }
      for (const run of pendingEdits.current.splice(0)) run();
      // Galley: V2 (WP05) "Detect from the file" reads the text it now has.
      const detected = settings.update({ doc: view.state.doc });
      if (detected.length) view.dispatch({ effects: detected });
      // Compared only against the server's text: the empty doc before it
      // would mark the whole baseline removed.
      if (baselineRef.current) view.dispatch({ effects: setDiffBaseline.of(baselineRef.current) });
      cbRef.current.onStats?.({ words: latexWordCount(view.state.doc.toString()), selWords: null });
      reportOutline(true);
      // Re-anchor comments against the now-populated doc: a push that arrived
      // before the Yjs sync ran against an empty document.
      if (lastCommentRanges.current.length) {
        view.dispatch({ effects: setComments.of(lastCommentRanges.current.map((r) => reanchor(view.state.doc, r))) });
      }
    };
    if (provider.isSynced) initialStats();
    provider.on('synced', initialStats);
    const onDenied = () => cbRef.current.onAccessDenied?.();
    provider.on('authenticationFailed', onDenied);
    const onAuthed = () => cbRef.current.onScope?.(provider.authorizedScope === 'readonly');
    provider.on('authenticated', onAuthed);
    if (provider.isAuthenticated) onAuthed();
    // The open file's spot, for a reload or the next visit; the others were
    // kept when their panes let go of them.
    const keepSpot = () => {
      if (document.visibilityState !== 'hidden' || !provider.isSynced) return;
      const s = captureSpot(view);
      if (s) fileSpots.set(docName, s);
    };
    document.addEventListener('visibilitychange', keepSpot);
    // Without accounts a refused document closes the socket as Forbidden (a
    // project in the trash): the project route then says why.
    const onClosed = ({ event }: { event: { code: number } }) => { if (event?.code === 4403) cbRef.current.onAccessDenied?.(); };
    provider.on('close', onClosed);
    providerRef.current = provider;
    // A kept doc is synced already: it opens without the load gate.
    let gated = !provider.isSynced;
    if (!gated) view.dom.parentElement?.setAttribute('data-loaded', 'true');
    const sync = watchSync(provider, ydoc, (s) => {
      if (gated && s.loaded) {
        gated = false;
        view.dispatch({ effects: loadGate.reconfigure([]) });
        view.dom.parentElement?.setAttribute('data-loaded', 'true');
      }
      cbRef.current.onSync?.(s);
    });

    return () => {
      offSettings(); // Galley: V2 (WP05)
      offFeatures(); // Galley: V2 (WP05)
      offTypography(); // Galley: V2 (WP02 R2)
      if (statsTimer) clearTimeout(statsTimer);
      if (outlineTimer) clearTimeout(outlineTimer);
      if (flashTimer.current) { clearTimeout(flashTimer.current); flashTimer.current = null; }
      pendingGoto.current = null;
      document.removeEventListener('visibilitychange', keepSpot);
      undoManager.off('stack-item-popped', onPopped);
      pendingEdits.current = [];
      ytext.unobserve(onYChange);
      provider.off('synced', initialStats);
      provider.off('authenticationFailed', onDenied);
      provider.off('close', onClosed);
      provider.off('authenticated', onAuthed);
      sync.dispose();
      providerRef.current = null;
      awareness.off('change', reportUsers);
      // The roster is this file's: a preview, or no open file, has nobody in it.
      onUsers([]);
      if (provider.isSynced) {
        const s = captureSpot(view);
        if (s) fileSpots.set(docName, s);
      }
      // yCollab gives each binding an UndoManager of its own that nothing
      // uses; on a doc that outlives the pane it would stay subscribed.
      view.state.facet(ySyncFacet).undoManager.destroy();
      view.destroy();
      parkDoc(doc);
      viewRef.current = null;
      reconfRef.current = null;
      readOnlyRef.current = null;
    };
  }, [projectId, branch, filePath]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setAgentSeen.of(agentSeenAt) });
  }, [agentSeenAt]);

  useEffect(() => {
    const view = viewRef.current, rc = reconfRef.current;
    if (!view || !rc) return;
    const on = changeMarks && mode === 'source';
    view.dispatch({ effects: rc.diffComp.reconfigure(on ? diffGutter(syncedRef.current ? baselineRef.current : null, manualCommits ? 'commit' : 'checkpoint') : []) });
  }, [changeMarks, mode, manualCommits]);
  // The baseline moves with the branch's checkpoints (commits, with manual
  // commits); `since` keeps an unmoved one from being sent again.
  useEffect(() => {
    if (!changeMarks) return;
    let live = true;
    api.diffBaseline(projectId, branch, filePath, baselineRef.current?.commit).then((r) => {
      if (!live || r.unchanged) return;
      const next: DiffBaseline | null = r.commit && !r.large ? { commit: r.commit, lines: r.content == null ? null : splitLines(r.content) } : null;
      baselineRef.current = next;
      const view = viewRef.current;
      if (view && syncedRef.current) view.dispatch({ effects: setDiffBaseline.of(next) });
    }, () => { /* no marks until the next try */ });
    return () => { live = false; };
  }, [projectId, branch, filePath, baselineVersion, changeMarks, manualCommits]);

  // Mode and spellcheck are presentation-only: swap them at runtime through
  // compartments so the Yjs doc, collab socket, scroll, and cursor survive.
  useEffect(() => {
    const view = viewRef.current, rc = reconfRef.current;
    if (!view || !rc) return;
    // Galley: V2 (WP05) Source's content comes from the settings; wrapping and the features follow the mode.
    view.dispatch({ effects: [
      rc.modeComp.reconfigure(mode === 'visual' ? visualExtensions(rc.deps) : rc.settings.sourceMode()),
      ...rc.settings.update({ mode }),
      ...(rc.features?.setMode(mode) ?? []),
    ] });
  }, [mode]);
  useEffect(() => {
    const view = viewRef.current, rc = reconfRef.current;
    if (!view || !rc) return;
    view.dispatch({ effects: rc.spellComp.reconfigure(spellcheckExtension(spellcheck, spellLang, filePath)) });
  }, [spellcheck, spellLang, filePath]);
  // Vim is keybindings only: switching it changes how keys move and edit,
  // never the document, so it swaps in place like the two above.
  useEffect(() => {
    const view = viewRef.current, rc = reconfRef.current;
    if (!view || !rc) return;
    if (!vim) { view.dispatch({ effects: rc.vimComp.reconfigure([]) }); return; }
    let live = true;
    loadVim().then((ext) => {
      if (live && viewRef.current === view && rc.vimComp.get(view.state) !== ext) view.dispatch({ effects: rc.vimComp.reconfigure(ext) });
    }, () => {
      if (live) toastRef.current('Could not load the Vim keybindings — check the connection and turn them on again', 'error');
    });
    return () => { live = false; };
  }, [vim, projectId, branch, filePath]);
  // A name changed while the file is open reaches co-authors' avatars at once.
  useEffect(() => {
    if (identity) providerRef.current?.setAwarenessField('user', { name: identity.name, color: identity.color, colorLight: identity.color + '55', ...(identity.avatar ? { avatar: identity.avatar } : {}) });
  }, [identity?.name, identity?.color, identity?.avatar]);
  // The project's details load again while its pane is open, and the
  // showcase flag in them can have changed.
  useEffect(() => {
    const view = viewRef.current, ro = readOnlyRef.current;
    if (!view || !ro || ro.on === readOnly) return;
    ro.on = readOnly;
    view.dispatch({ effects: ro.comp.reconfigure(readOnly ? readOnlyDoc(ro.ydoc) : []) });
  }, [readOnly]);

  return <div ref={hostRef} className="code-pane" data-testid="code-pane" />;
});

export default CodePane;
