/**
 * Laytekz V2 feature-module contracts (WP01, frozen). Only the integrator
 * changes this file; a package that needs a change files a request
 * (docs/galley-v2/README.md). Type-only apart from FEATURE_IDS and FILES_MOVED_SIGNAL.
 */
import type { ComponentType } from 'react';
import type { ChangeSpec, EditorState, Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { AuthUser, Comment, CompileResult, ProjectDetail, TreeEntry } from '../api';
import type { CodePaneHandle, EditorMode } from '../components/CodePane';
import type { PromptOptions } from '../components/Dialogs';
import type { BranchPeer } from '../editor/branchSignal';
import type { PluginConfirm } from '../plugins/host';
import type { CommandDef } from '../commands/types';
import type { KeybindingDef } from '../keys/types';
import type { SlotItem } from '../slots/types';
import type { ContextMenuEntry, PdfContextMenuEntry, PdfTextSelection } from '../contextmenu/types';
import type { AutoEditRule, KeyChainEntry, ModClickHandler } from '../editor/core/types';
import type { SettingsTarget } from '../settings/types';

/** Every feature id, in manifest order. srv/features/types.ts repeats the
 *  list; scripts/v2/check-contracts.mjs keeps the copies equal. */
export const FEATURE_IDS = [
  'escape', 'automath', 'pairs', 'envclose', 'suggest', 'mathPreview', 'tables', 'citations', 'crossrefs',
  'links', 'references', 'libraries', 'rename', 'outputs', 'wordcount', 'pet', 'highlighter', 'stats',
  'agents', 'webShell', 'pdfComments', 'refManagers', '_probe',
] as const;
export type FeatureId = typeof FEATURE_IDS[number];

export type { EditorMode, PdfTextSelection };
export type PromptSpec = PromptOptions;

export type Notify = (text: string, kind?: 'info' | 'ok' | 'error', action?: { label: string; run(): void }) => void;

export interface FeatureModule {
  id: FeatureId;
  editor?: EditorContribution;
  commands?(page: EditorPageCtx): CommandDef[];
  keybindings?: readonly KeybindingDef[];
  slots?: readonly SlotItem[];
  contextMenu?: readonly ContextMenuEntry[];
  /** Entries of the PDF preview's app menu (feature 19). */
  pdfContextMenu?: readonly PdfContextMenuEntry[];
  /** Plugin panels to show as tabs on the sidebar's main row (feature 20). */
  pinnedPanels?: readonly PinnedPanel[];
  /** The first non-null reason, over every feature, makes the file read-only and shows as a banner. */
  readOnlyRules?: readonly ReadOnlyRule[];
  interceptors?: Partial<Interceptors>;
  /** Once per project+branch editor page; the returned function runs when it closes. */
  activate?(page: EditorPageCtx): void | (() => void);
  /** Once per tab, on every page, before the first render of a page. */
  boot?(app: AppCtx): void | (() => void);
}

export interface EditorContribution {
  /** Lives in its own Compartment, outside the mode compartment; reconfigured
   *  (never remounted) when the file, the mode or a setting in `deps` changes. */
  extension?(ctx: EditorFeatureCtx): Extension;
  /** Setting ids whose change reconfigures this feature's compartment only. */
  deps?: readonly string[];
  /** Files it runs in; default /\.(tex|ltx)$/i. */
  files?: RegExp;
  /** Default both. */
  modes?: readonly EditorMode[];
  /** Appended after the core sources in the autocompletion override. */
  completionSources?: readonly ((ctx: EditorFeatureCtx) => CompletionSource)[];
  /** Applied to every completion result, in manifest order. */
  completionFilter?(r: CompletionResult, cx: CompletionContext): CompletionResult;
  /** keyChains, modClick and autoEditRules follow the same files/modes/deps as `extension`. */
  keyChains?: readonly KeyChainEntry[];
  modClick?: readonly ModClickHandler[];
  autoEditRules?: readonly AutoEditRule[];
  /** Runs inside Format document's undo step, after the formatter's changes. */
  afterFormat?(state: EditorState): ChangeSpec | null;
}

export interface EditorFeatureCtx {
  readonly projectId: string;
  readonly branch: string;
  readonly filePath: string;
  readonly rootFile: string | null;
  readonly ydoc: Y.Doc;
  readonly ytext: Y.Text;
  readonly awareness: Awareness;
  readonly undoManager: Y.UndoManager;
  readonly identity: { id: string | null; name: string; color: string };
  mode(): EditorMode;
  readOnly(): boolean;
  /** The collab doc has synced at least once. */
  synced(): boolean;
  setting<T>(id: string): T;
  projectSetting<T>(id: string): T;
  notify: Notify;
  openSettings(t?: SettingsTarget): void;
  /** Runs a command by id (page or feature); false when none is available. */
  runCommand(id: string): boolean;
  page(): EditorPageCtx | null;
}

export interface PdfDocumentInfo { url: string; doc: PDFDocumentProxy }

export interface EditorPageCtx {
  readonly projectId: string;
  readonly branch: string;
  project(): ProjectDetail | null;
  user(): AuthUser | null;
  canEdit(): boolean;
  showcase(): boolean;
  activeFile(): string | null;
  view(): EditorView | null;
  files(): TreeEntry[];
  openFile(path: string, at?: { line?: number; pos?: number; find?: string }): void;
  insertAtCursor(text: string): void;
  editDocument: CodePaneHandle['editDocument'];
  compile(o?: { clean?: boolean }): void;
  lastCompile(): CompileResult | null;
  /** The PDF on screen, once pdf.js has opened it. */
  pdf(): PdfDocumentInfo | null;
  ui: {
    layout(): 'editor' | 'both' | 'pdf';
    sidebarHidden(): boolean;
    phone(): boolean;
    /** Shows a sidebar panel ('files', 'search', 'history', 'review', 'plugin:<id>', or a slot item's id); `query` seeds a search field. */
    showPanel(id: string, query?: string): void;
  };
  peers(): BranchPeer[];
  comments(): Comment[];
  toast: Notify;
  confirm(o: PluginConfirm): Promise<boolean>;
  prompt(o: PromptSpec): Promise<string | null>;
  openSettings(t?: SettingsTarget): void;
  /** Runs a command by id (a feature's, then the page's own); false when none may run here. */
  runCommand(id: string): boolean;
  refreshFiles(): Promise<void>;
  refreshProject(): Promise<void>;
  events: Emitter<PageEvents>;
}

export interface PageEvents {
  docChanged: { path: string; local: boolean };
  activeFile: { path: string | null };
  filesChanged: {};
  filesMoved: { moves: [string, string][]; by: string | null };
  compileRequested: { seq: number; trigger: 'user' | 'auto' | 'open' };
  compileFinished: { result: CompileResult; trigger: 'user' | 'auto' | 'open' | 'adopted'; own: boolean };
  agentWrite: { paths: string[] };
  projectChanged: {};
  projectSettingsChanged: { ids: string[] };
  rosterChanged: {};
  commentsChanged: {};
  visibility: { visible: boolean };
  /** The text selection in the PDF preview changed (null: cleared). Feature 19. */
  pdfSelection: { selection: PdfTextSelection | null };
  /** A comment was chosen in the Review panel (its anchor clicked). */
  commentRevealed: { id: string };
}

/** Branch-signal key and value for files moved on the server (WP28 sends it
 *  with collab.signalBranch; the page host, WP06, emits `filesMoved` from it).
 *  `by`: the mover's display name, null for an agent or the server. */
export const FILES_MOVED_SIGNAL = 'moves';
export interface FilesMovedSignal { moves: [string, string][]; by: string | null; at: number }

/** A typed event emitter (features/events.ts, WP06). `on` returns the unsubscribe. */
export interface Emitter<E> {
  on<K extends keyof E>(event: K, fn: (payload: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, payload: E[K]): void;
}

export interface ReadOnlyRule { id: string; reason(path: string, page: EditorPageCtx): string | null }

export interface PinnedPanel {
  /** The panel id: 'plugin:<pluginId>' for a plugin's panel. */
  id: string;
  title: string;
  icon: ComponentType;
  /** After the core pinned panels (references 100, zotero 200), ascending. */
  order: number;
}

/** 'handled': the feature did the rename and reported it; 'cancelled': the
 *  person called it off, so nothing changes; 'default': the page renames. */
export interface Interceptors {
  fileRename(r: { from: string; to: string; via: 'tree' | 'drag' | 'palette' }, p: EditorPageCtx): Promise<'handled' | 'default' | 'cancelled'>;
  /** `projectId` is set when there is no page (Home). */
  projectRename(r: { from: string; to: string; projectId?: string }, p: EditorPageCtx | null): Promise<'handled' | 'default'>;
}

/** GET /api/capabilities. Signed-out callers get the public subset. */
export interface Capabilities {
  /** The server's build revision; '' when unknown. */
  rev: string;
  accounts: boolean;
  /** Account preference sync is available to this caller. */
  prefs: boolean;
  mcp: boolean;
  oauthRegistration: boolean;
  /** Each server feature's own keys ('pet', 'libraries.mendeley', 'desktopUrl', …). */
  [feature: string]: unknown;
}

export interface AppCtx {
  user(): AuthUser | null;
  capabilities(): Capabilities;
  desktop: boolean;
  openSettings(t?: SettingsTarget): void;
  toast: Notify;
}

// ---- Seams between Editor.tsx (WP06) and CodePane/PdfPane (WP05) ----

/** CodePane's `featureHost` prop. Absent: no feature runs (today's editor). */
export interface CodePaneFeatureHost {
  /** The enabled modules in manifest order (WP06 drops `_probe` unless localStorage 'aldine.e2e.probe' is '1'). */
  readonly modules: readonly FeatureModule[];
  page(): EditorPageCtx | null;
  /** The signed-in account's id; null signed out or without accounts. */
  readonly userId: string | null;
  notify: Notify;
  openSettings(t?: SettingsTarget): void;
  runCommand(id: string): boolean;
}

/** Members CodePaneHandle gains (WP05). */
export interface CodePaneFeatureHandle {
  /** The live EditorView, or null while none is mounted. */
  view(): EditorView | null;
}

/** PdfPane's `featureHost` prop. Absent: no PDF app menu and no selection reports. */
export interface PdfPaneFeatureHost {
  readonly modules: readonly FeatureModule[];
  page(): EditorPageCtx | null;
  onTextSelection?(s: PdfTextSelection | null): void;
}

/** Members PdfPaneHandle gains (WP05). */
export interface PdfPaneFeatureHandle {
  pdf(): PdfDocumentInfo | null;
  textSelection(): PdfTextSelection | null;
}
