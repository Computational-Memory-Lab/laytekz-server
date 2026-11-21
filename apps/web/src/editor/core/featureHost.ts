/**
 * The editor host (WP05 editor-host): runs the feature modules'
 * EditorContributions inside CodePane.
 *
 * - Each feature with an `editor` contribution for the open file gets a
 *   Compartment of its own, outside the mode compartment. A mode change or a
 *   change of a setting in its `deps` reconfigures it in place (the view is
 *   never remounted); a file change is a new pane, so a new host.
 * - Its keyChains and modClick handlers are provided inside that compartment,
 *   so they follow its files, modes and deps; its autoEditRules join one
 *   autoEditCore (in a compartment of its own) with every running feature's.
 * - Completion sources are appended to the core list in manifest order, and
 *   every result passes the running features' filters in manifest order
 *   (core/completion.ts holds the one autocompletion()).
 * - The input core is installed once: key chains, mod-click, the editor's
 *   keybindings, and the context menu (only while some feature has menu
 *   entries, so the native menu stays what V1 shows until one does).
 * - A feature that throws is skipped with a warning; a neighbour package that
 *   is not built yet (a stub that throws) leaves the V1 behaviour in place.
 */
import { Compartment, Prec, type ChangeSpec, type EditorState, type Extension, type StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { CompletionSource } from '@codemirror/autocomplete';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type {
  CodePaneFeatureHost, EditorContribution, EditorFeatureCtx, EditorMode, EditorPageCtx, FeatureId, FeatureModule,
} from '../../features/types';
import type { ContextMenuEntry, MenuItemSpec, PdfContextMenuEntry, PdfMenuTarget, PdfRect } from '../../contextmenu/types';
import type { AutoEditRule } from './types';
import { keyChains, keyChainsExtension } from './keyChains';
import { modClick, modClickExtension } from './modClick';
import { autoEditCore } from './autoEdit';
import { autoEditNotices } from './notices';
import { contextMenuExtension } from '../../contextmenu';
import { bindingFor } from '../../keys/registry';
import { isDesktop, DESKTOP_UA_TOKEN } from '../../util/desktop';
import { readSetting, watchSettings } from './editorSettings';
import type { CompletionFilter, CompletionParts, CompletionSlot } from './completion';
import { shortcut } from '../../platform';

/** The files a contribution runs in when it names none. */
export const DEFAULT_FEATURE_FILES = /\.(tex|ltx)$/i;
const BOTH_MODES: readonly EditorMode[] = ['source', 'visual'];

export type HostWarn = (message: string, err?: unknown) => void;
const consoleWarn: HostWarn = (message, err) => console.warn(`[editor] ${message}`, err ?? '');

/** Whether a contribution runs in `filePath`. */
export function runsIn(c: EditorContribution, filePath: string): boolean {
  const re = c.files ?? DEFAULT_FEATURE_FILES;
  re.lastIndex = 0; // a /g or /y pattern keeps state between tests
  return re.test(filePath);
}

/** Whether a contribution runs in `mode`. */
export const runsInMode = (c: EditorContribution, mode: EditorMode) => (c.modes ?? BOTH_MODES).includes(mode);

/** What a feature context reads from the pane that hosts it, live. */
export interface FeatureCtxSource {
  projectId: string;
  branch: string;
  filePath: string;
  rootFile: string | null;
  ydoc: Y.Doc;
  ytext: Y.Text;
  awareness: Awareness;
  undoManager: Y.UndoManager;
  identity(): { id: string | null; name: string; color: string };
  mode(): EditorMode;
  readOnly(): boolean;
  synced(): boolean;
  /** CodePane's `featureHost` prop as it is now. */
  host(): CodePaneFeatureHost | undefined;
}

/** The EditorFeatureCtx every contribution of one pane gets. Settings come
 *  from the settings store (core/editorSettings.ts readSetting). */
export function createEditorFeatureCtx(s: FeatureCtxSource): EditorFeatureCtx {
  return {
    projectId: s.projectId,
    branch: s.branch,
    filePath: s.filePath,
    rootFile: s.rootFile,
    ydoc: s.ydoc,
    ytext: s.ytext,
    awareness: s.awareness,
    undoManager: s.undoManager,
    get identity() { return s.identity(); },
    mode: () => s.mode(),
    readOnly: () => s.readOnly(),
    synced: () => s.synced(),
    setting: <T>(id: string) => readSetting<T>(id),
    projectSetting: <T>(id: string) => readSetting<T>(id),
    notify: (text, kind, action) => s.host()?.notify(text, kind, action),
    openSettings: (t) => s.host()?.openSettings(t),
    runCommand: (id) => s.host()?.runCommand(id) ?? false,
    page: () => s.host()?.page() ?? null,
  };
}

export interface EditorFeatureHostOptions {
  /** The enabled modules, in manifest order. */
  modules: readonly FeatureModule[];
  ctx: EditorFeatureCtx;
  filePath: string;
  mode: EditorMode;
  /** The completion list, which gets the running features' sources and filters. */
  completion?: CompletionSlot;
  page(): EditorPageCtx | null;
  runCommand(id: string): boolean;
  /** Skip 'native-menu' keybindings (the desktop app's menu has them); default: from the user agent. */
  desktop?: boolean;
  warn?: HostWarn;
}

interface Hosted {
  module: FeatureModule;
  editor: EditorContribution;
  comp: Compartment;
  /** In the current mode, and its extension built without throwing. */
  on: boolean;
  /** Its completion sources, made with its extension. */
  sources: CompletionSource[];
  filter: CompletionFilter | null;
}

function desktopNow(): boolean {
  try { return isDesktop(); } catch { return typeof navigator !== 'undefined' && navigator.userAgent.includes(` ${DESKTOP_UA_TOKEN}/`); }
}

export class EditorFeatureHost {
  /** The feature compartments and the auto-edit core: CodePane places them outside, before, the mode compartment. */
  readonly extension: Extension;
  /** Key chains, mod-click, the editor's keybindings and the context menu: CodePane places them right after Vim. */
  readonly input: Extension;
  /** keyChainsExtension() is installed: CodePane then leaves out its own Tab keys, which are the chain's Tab 100 and 0. */
  readonly keyChainsInstalled: boolean;

  private readonly hosted: Hosted[] = [];
  private readonly autoEditComp = new Compartment();
  private autoEditRulesNow: readonly AutoEditRule[] = [];
  private mode: EditorMode;
  private readonly warn: HostWarn;
  private readonly warned = new Set<string>();

  constructor(private readonly o: EditorFeatureHostOptions) {
    this.mode = o.mode;
    this.warn = o.warn ?? consoleWarn;
    for (const module of o.modules) {
      const editor = module.editor;
      if (!editor || !runsIn(editor, o.filePath)) continue;
      const filter = editor.completionFilter;
      this.hosted.push({ module, editor, comp: new Compartment(), on: false, sources: [], filter: filter ? (r, cx) => filter.call(editor, r, cx) : null });
    }
    const features = this.hosted.map((h) => h.comp.of(this.content(h)));
    this.autoEditRulesNow = this.rules();
    o.completion?.init(this.completionParts());
    this.extension = [...features, this.autoEditComp.of(this.autoEditExtension(this.autoEditRulesNow))];

    const input: Extension[] = [this.keybindingDispatcher()];
    let chains: Extension | null = null;
    try { chains = keyChainsExtension(); } catch (err) { this.warnOnce('key chains', err); }
    this.keyChainsInstalled = chains != null;
    if (chains) input.push(chains);
    try { input.push(modClickExtension()); } catch (err) { this.warnOnce('mod-click', err); }
    const menu = this.menuEntries();
    if (menu.length) {
      try { input.push(contextMenuExtension(menu, () => o.page())); } catch (err) { this.warnOnce('the context menu', err); }
    }
    this.input = input;
  }

  private warnOnce(what: string, err: unknown): void {
    if (this.warned.has(what)) return;
    this.warned.add(what);
    this.warn(`${what} could not start`, err);
  }

  /** A hosted feature's compartment content in the current mode (and its
   *  completion sources); marks it on or off. */
  private content(h: Hosted): Extension {
    h.on = false;
    h.sources = [];
    if (!runsInMode(h.editor, this.mode)) return [];
    let ext: Extension[];
    try {
      ext = [];
      if (h.editor.extension) ext.push(h.editor.extension(this.o.ctx));
      for (const e of h.editor.keyChains ?? []) ext.push(keyChains.of(e));
      for (const m of h.editor.modClick ?? []) ext.push(modClick.of(m));
    } catch (err) {
      this.warn(`the ${h.module.id} feature failed and is skipped in this editor`, err);
      return [];
    }
    h.on = true;
    for (const make of h.editor.completionSources ?? []) {
      try {
        h.sources.push(make(this.o.ctx));
      } catch (err) {
        this.warn(`a completion source of the ${h.module.id} feature failed and is skipped`, err);
      }
    }
    return ext;
  }

  private running(): Hosted[] {
    return this.hosted.filter((h) => h.on);
  }

  /** The ids of the features running in this editor now, in manifest order. */
  runningIds(): FeatureId[] {
    return this.running().map((h) => h.module.id);
  }

  private rules(): AutoEditRule[] {
    return this.running().flatMap((h) => h.editor.autoEditRules ?? []);
  }

  private autoEditExtension(rules: readonly AutoEditRule[]): Extension {
    if (!rules.length) return [];
    try {
      // autoEditCore's frozen signature has no notify: a rule's notice and the
      // "turn it off?" offer reach the page's toast through this facet (WP08).
      return [autoEditCore(rules), autoEditNotices.of((text, kind, action) => this.o.ctx.notify(text, kind, action))];
    } catch (err) {
      this.warnOnce('automatic edits', err);
      return [];
    }
  }

  /** The running features' completion sources and filters, in manifest order. */
  completionParts(): CompletionParts {
    const running = this.running();
    return {
      sources: running.flatMap((h) => h.sources),
      filters: running.flatMap((h) => (h.filter ? [h.filter] : [])),
    };
  }

  private menuEntries(): ContextMenuEntry[] {
    return this.o.modules.flatMap((m) => m.contextMenu ?? []);
  }

  /** The reconfigurations after the editor switched between Source and Visual. */
  setMode(mode: EditorMode): StateEffect<unknown>[] {
    if (mode === this.mode) return [];
    this.mode = mode;
    return this.reconfigure(this.hosted);
  }

  private reconfigure(which: readonly Hosted[]): StateEffect<unknown>[] {
    const effects: StateEffect<unknown>[] = which.map((h) => h.comp.reconfigure(this.content(h)));
    const rules = this.rules();
    if (!sameList(rules, this.autoEditRulesNow)) {
      this.autoEditRulesNow = rules;
      effects.push(this.autoEditComp.reconfigure(this.autoEditExtension(rules)));
    }
    const completion = this.o.completion?.update({ parts: this.completionParts() });
    if (completion) effects.push(completion);
    return effects;
  }

  /** The reconfigurations for one feature (its deps changed). */
  reconfigureFeature(id: FeatureId): StateEffect<unknown>[] {
    const h = this.hosted.filter((x) => x.module.id === id);
    return h.length ? this.reconfigure(h) : [];
  }

  /** Watches every hosted feature's `deps`; `apply` dispatches the effects. Returns the unsubscribe. */
  watch(apply: (effects: StateEffect<unknown>[]) => void): () => void {
    const offs = this.hosted
      .filter((h) => h.editor.deps?.length)
      .map((h) => watchSettings(h.editor.deps!, () => {
        const effects = this.reconfigureFeature(h.module.id);
        if (effects.length) apply(effects);
      }));
    return () => { for (const off of offs) off(); };
  }

  /** Some running feature has an afterFormat. */
  hasAfterFormat(): boolean {
    return this.running().some((h) => h.editor.afterFormat);
  }

  /**
   * Runs the running features' afterFormat, in manifest order, each on the
   * text the one before left, inside Format document's undo step (the caller
   * closes the step before and after). Returns whether any changed the text.
   */
  runAfterFormat(view: { state: EditorState; dispatch(spec: { changes: ChangeSpec; userEvent: string }): void }): boolean {
    let changed = false;
    for (const h of this.running()) {
      const after = h.editor.afterFormat;
      if (!after) continue;
      let spec: ChangeSpec | null;
      try {
        spec = after.call(h.editor, view.state);
      } catch (err) {
        this.warn(`Format document: the ${h.module.id} feature failed and is skipped`, err);
        continue;
      }
      if (spec == null) continue;
      const before = view.state.doc;
      view.dispatch({ changes: spec, userEvent: 'input.format' });
      if (view.state.doc !== before) changed = true;
    }
    return changed;
  }

  /** One keydown handler for the 'editor' keybindings (keys/registry.ts):
   *  highest precedence, so a binding beats the keymaps; Vim, placed before
   *  it, still sees every key first. */
  private keybindingDispatcher(): Extension {
    const keydown = editorKeybindingHandler((id) => this.o.runCommand(id), this.o.desktop ?? desktopNow(), (what, err) => this.warnOnce(what, err));
    return Prec.highest(EditorView.domEventHandlers({ keydown: (e) => keydown(e) }));
  }
}

/**
 * The editor's keydown dispatch: the feature's 'editor' binding the key
 * triggers, its command run; true when a command took the key. Core editor
 * bindings (ids without a '<featureId>.' prefix, such as 'follow') belong to
 * the extension that defines them (mod-click runs Alt+Enter and declines it
 * where there is nothing to follow), so they pass. A registry that throws
 * (not built yet) turns the dispatch off for this editor, once.
 */
export function editorKeybindingHandler(runCommand: (id: string) => boolean, desktop: boolean, warn: HostWarn = consoleWarn): (e: KeyboardEvent) => boolean {
  let broken = false;
  return (e) => {
    if (broken || e.defaultPrevented || e.isComposing) return false;
    let def;
    try {
      def = bindingFor(e, ['editor'], { desktop });
    } catch (err) {
      broken = true;
      warn('the editor keybindings', err);
      return false;
    }
    if (!def || !def.id.includes('.')) return false;
    try {
      return runCommand(def.command);
    } catch (err) {
      warn(`the command ${def.command}`, err);
      return true;
    }
  };
}

const sameList = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- The PDF pane's app menu and selection (README D2; feature 19) ----

/** The order of the menu's groups; Copy always ends it. */
export const PDF_MENU_GROUPS: readonly PdfContextMenuEntry['group'][] = ['annotate', 'navigate', 'copy'];

/** Every enabled module's PDF menu entries, in manifest order. */
export function pdfMenuEntries(modules: readonly FeatureModule[]): PdfContextMenuEntry[] {
  return modules.flatMap((m) => m.pdfContextMenu ?? []);
}

/**
 * The PDF app menu for `target`: the entries' items by group (annotate,
 * navigate, copy) and order, a separator between groups, then Copy. null
 * when no entry has an item here, and the native menu shows instead. An
 * entry that throws is skipped.
 */
export function pdfContextMenuItems(entries: readonly PdfContextMenuEntry[], target: PdfMenuTarget, copy: () => void, warn: HostWarn = consoleWarn): MenuItemSpec[] | null {
  const rank = (e: PdfContextMenuEntry) => PDF_MENU_GROUPS.indexOf(e.group);
  const sorted = entries.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e) - rank(b.e) || a.e.order - b.e.order || a.i - b.i);
  const out: MenuItemSpec[] = [];
  let group: string | null = null;
  for (const { e } of sorted) {
    let items: MenuItemSpec[] | null;
    try {
      items = e.items(target);
    } catch (err) {
      warn(`the PDF menu entry ${e.id} failed and is skipped`, err);
      continue;
    }
    if (!items?.length) continue;
    if (group !== null && group !== e.group) out.push({ kind: 'separator', id: `pdf-menu-${e.group}` });
    group = e.group;
    out.push(...items);
  }
  if (!out.length) return null;
  out.push({ kind: 'separator', id: 'pdf-menu-end' });
  out.push({ id: 'pdf-copy', label: 'Copy', shortcut: shortcut('C'), testId: 'pdf-context-copy', onSelect: copy });
  return out;
}

/** Whether (x, y) falls in one of `rects` (client pixels), with `slop` around each. */
export function pointInRects(rects: readonly { left: number; top: number; right: number; bottom: number }[], x: number, y: number, slop = 2): boolean {
  return rects.some((r) => x >= r.left - slop && x <= r.right + slop && y >= r.top - slop && y <= r.bottom + slop);
}

/** One box per line: boxes whose heights overlap by half the smaller one are a line. */
export function mergeLineRects(rects: readonly PdfRect[]): PdfRect[] {
  const lines: PdfRect[] = [];
  const sorted = rects.filter((r) => r.right > r.left && r.bottom > r.top).sort((a, b) => a.top - b.top || a.left - b.left);
  for (const r of sorted) {
    const line = lines.find((l) => Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) >= 0.5 * Math.min(l.bottom - l.top, r.bottom - r.top));
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ ...r });
    }
  }
  return lines.sort((a, b) => a.top - b.top || a.left - b.left);
}

/** `box` (client pixels) in the PDF points of a page drawn at `pageBox`, `scale` CSS pixels per point, clamped to the page. */
export function toPdfRect(box: { left: number; top: number; right: number; bottom: number }, pageBox: { left: number; top: number }, scale: number, page: { width: number; height: number }): PdfRect {
  const x = (v: number) => Math.min(Math.max(0, (v - pageBox.left) / scale), page.width);
  const y = (v: number) => Math.min(Math.max(0, (v - pageBox.top) / scale), page.height);
  return { left: x(box.left), top: y(box.top), right: x(box.right), bottom: y(box.bottom) };
}
