import { useEffect, useRef } from 'react';
import { withBase } from '../basePath';
// Galley: V2 (WP22) optional API additions: settings, the editor page, citation handles.
import type { EditorPageCtx } from '../features/types';
import type { SettingsTarget, SectionId } from '../settings/types';
import { getSetting, subscribeSetting, openSettings as openSettingsPage } from '../settings/store';
import { diffInsertion, revertInsertion, trackInsertion, type TrackedInsertion } from '../features/references/citeTrack';

/**
 * Aldine plugin host.
 * Plugins are ES modules served from /plugins/<id>/<entry> exporting:
 *   export default { activate(aldine: AldineAPI): void }
 * The API is intentionally small and stable; panels render vanilla DOM.
 */

export interface PluginPanel {
  id: string;
  title: string;
  mount(el: HTMLElement): void;
  /** Called each time the panel comes into view. */
  onShow?(): void;
}

/** A question the app asks in its own dialog; see AldineAPI.ui.confirm. */
export interface PluginConfirm {
  title: string;
  body?: string;
  /** Names the action: "Unlink", not "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Destroys something or cannot be taken back: a red button, and Enter takes the way out. */
  danger?: boolean;
}

/** A button a plugin adds to the header of the errors list. */
export interface PluginErrorsAction {
  id: string;
  label: string;
  title?: string;
  run(): void;
}

/** `explicit`: someone asked for this typeset (Typeset, ⌘S, the palette, a
 *  plugin), as opposed to auto-typeset, the run a project opens with, or a
 *  co-author's or an agent's run. */
type LastCompile = { ok: boolean; errors: Array<{ type: string; line: number | null; message: string; file?: string }>; log: string; explicit: boolean } | null;

/** A command a plugin adds to the editor's command palette. */
export interface PluginCommand {
  id: string;
  title: string;
  /** The palette section it is listed under; "Plugins" by default. */
  group?: string;
  keywords?: string;
  run(): void;
}

export interface PluginCtx {
  projectId: string;
  branch: string;
  getActiveFile(): string | null;
  getCompileResult(): LastCompile;
  insertAtCursor(text: string): void;
  insertCitation(key: string): CitationResult;
  refreshFiles(): Promise<unknown>;
  refreshProject(): Promise<unknown>;
  compile(): void;
  toast(text: string, kind?: 'info' | 'error' | 'ok'): void;
  /** `reveal`: also show a hidden sidebar. */
  showPanel(id: string, reveal?: boolean): void;
  confirm(o: PluginConfirm): Promise<boolean>;
}

/** What citing a key did: a new \cite, a key added to the citation at the
 *  cursor, a citation that has it already, or false when no TeX file is open
 *  in the editor to cite it in. */
export type CitationResult = 'inserted' | 'added' | 'present' | false;

// ---- Galley: V2 (WP22) optional plugin API additions; third-party plugins that ignore them keep working ----

/** A .bib a reference can go to (GET /api/projects/:id/references/targets). */
export interface PluginBibFile { path: string; exists: boolean; loaded: boolean; synced: boolean; editable: boolean }

/** What citeWithHandle did; pass it to revert() to take the citation back. Opaque. */
export interface CitationHandle { readonly key: string; readonly file: string | null }

/** A button on a toast. */
export interface PluginToastAction { label: string; run(): void }

const handles = new WeakMap<CitationHandle, TrackedInsertion>();

/** The editor page the plugins work against, bound by the references feature's activate(). */
let boundPage: EditorPageCtx | null = null;
const pageListeners = new Set<(page: EditorPageCtx | null) => void>();

/** Called from features/references activate(page); the returned function unbinds it. */
export function bindPluginPage(page: EditorPageCtx): () => void {
  boundPage = page;
  for (const fn of [...pageListeners]) fn(page);
  return () => {
    if (boundPage !== page) return;
    boundPage = null;
    for (const fn of [...pageListeners]) fn(null);
  };
}

/** Queries waiting for a plugin panel (`plugin:<id>`), and how to hand one over once it has rendered. */
const panelInbox = new Map<string, { deliver?: (query: string) => void; pending?: string }>();

function deliverQuery(panelId: string, query: string): void {
  const box = panelInbox.get(panelId) ?? {};
  if (box.deliver) box.deliver(query);
  else panelInbox.set(panelId, { ...box, pending: query });
}

/**
 * Show a plugin's panel, with `query` handed to its `onQuery` (a feature's way
 * in: the references feature opens the References panel from \cite completion).
 */
export function showPluginPanel(page: EditorPageCtx | null, pluginPanel: string, query?: string): void {
  const id = pluginPanel.startsWith('plugin:') ? pluginPanel : `plugin:${pluginPanel}`;
  if (typeof query === 'string') deliverQuery(id, query);
  page?.ui.showPanel(id);
}

const SECTION_RE = /^[a-z-]+$/;

export interface AldineAPI {
  version: 1;
  project: {
    readonly id: string;
    readonly branch: string;
    activeFile(): string | null;
    lastCompile(): LastCompile;
    refreshFiles(): Promise<unknown>;
    refresh(): Promise<unknown>;
    /**
     * Calls `listener` each time the editor has re-read the branch's file
     * list: after a file is added, removed, renamed or rewritten here, in
     * another tab, by a collaborator or on the server (an import, a sync, a
     * pull). Returns a function that stops the calls.
     */
    onFilesChanged(listener: () => void): () => void;
    /** Galley: V2 (WP22) every .bib on the branch a reference could go to. */
    bibFiles?(): Promise<PluginBibFile[]>;
    /** Galley: V2 (WP22) false for viewers and showcases: they may read and search, never add. */
    canEdit?(): boolean;
    /** Galley: V2 (WP22) called after each typeset finishes (anyone's); returns a function that stops the calls. */
    onCompiled?(listener: () => void): () => void;
  };
  editor: {
    insertAtCursor(text: string): void;
    /** Cite `key` at the cursor of the open TeX file: in the citation there, else as \cite{key}. */
    insertCitation(key: string): CitationResult;
    /** Galley: V2 (WP22) insertCitation, plus a handle that revert() takes back (null when nothing changed). */
    citeWithHandle?(key: string): { result: CitationResult; handle: CitationHandle | null };
    /** Galley: V2 (WP22) remove a citation citeWithHandle made, while its text is unchanged. False when it could not. */
    revert?(handle: CitationHandle): boolean;
  };
  compile(): void;
  /** Galley: V2 (WP22) `action` adds a button (Undo) to the toast. */
  toast(text: string, kind?: 'info' | 'error' | 'ok', action?: PluginToastAction): void;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Galley: V2 (WP22) read-only view of Laytekz settings (the settings page's ids). */
  settings?: {
    get(id: string): unknown;
    /** Returns a function that stops the calls. */
    onChange(ids: string | string[], listener: () => void): () => void;
  };
  ui: {
    /** `render` runs once, when the panel is first shown; `onShow` each time
     *  it comes into view, which is the moment to re-read what may have changed.
     *  Galley: V2 (WP22) `onQuery` receives a query another part of the app
     *  opened the panel with (after `render`). */
    registerSidebarPanel(panel: { id: string; title: string; render(el: HTMLElement): void; onShow?(): void; onQuery?(query: string): void }): void;
    /** Select one of this plugin's panels by the id it registered. A hidden
     *  sidebar is shown too, unless `reveal` is false. Galley: V2 (WP22)
     *  `query` is handed to the panel's onQuery. */
    showPanel(id: string, opts?: { reveal?: boolean; query?: string }): void;
    /** Galley: V2 (WP22) open Laytekz settings at a section ('references') or a row. */
    openSettings?(target?: SectionId | SettingsTarget): void;
    /** Add a button to the header of the errors list, shown while the last
     *  typeset failed. */
    registerErrorsAction(action: { id: string; label: string; title?: string; run(): void }): void;
    /** Add a command to the editor's command palette. */
    registerCommand(command: PluginCommand): void;
    /** Ask in the app's own dialog. Resolves true when confirmed; false on the
     *  way out, Escape or a click outside. */
    confirm(o: PluginConfirm): Promise<boolean>;
  };
}

interface Props {
  ctx: PluginCtx;
  onPanels(panels: PluginPanel[]): void;
  onErrorsActions?(actions: PluginErrorsAction[]): void;
  onCommands?(commands: PluginCommand[]): void;
  /** The branch's file list; a new value each time the editor re-reads it. */
  files: unknown;
}

export function PluginHost({ ctx, onPanels, onErrorsActions, onCommands, files }: Props) {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const filesListeners = useRef(new Set<() => void>());

  useEffect(() => {
    let cancelled = false;
    const panels: PluginPanel[] = [];
    const actions: PluginErrorsAction[] = [];
    const commands: PluginCommand[] = [];
    const listeners = new Set<() => void>();
    filesListeners.current = listeners;
    // Galley: V2 (WP22) the bound editor page, only while it is this project and branch.
    const page = (): EditorPageCtx | null => {
      const p = boundPage;
      return p && p.projectId === ctxRef.current.projectId && p.branch === ctxRef.current.branch ? p : null;
    };
    const compiledListeners = new Set<() => void>();
    let offCompiled: (() => void) | null = null;
    const watchCompiles = (p: EditorPageCtx | null) => {
      offCompiled?.();
      offCompiled = p ? p.events.on('compileFinished', () => {
        for (const fn of [...compiledListeners]) {
          try { fn(); } catch (err) { console.error('[plugins] onCompiled listener failed', err); }
        }
      }) : null;
    };
    watchCompiles(page());
    pageListeners.add(watchCompiles);
    const ownPanels: string[] = [];

    const api: AldineAPI = {
      version: 1,
      project: {
        get id() { return ctxRef.current.projectId; },
        get branch() { return ctxRef.current.branch; },
        activeFile: () => ctxRef.current.getActiveFile(),
        lastCompile: () => ctxRef.current.getCompileResult(),
        refreshFiles: () => ctxRef.current.refreshFiles(),
        refresh: () => ctxRef.current.refreshProject(),
        onFilesChanged: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        // ---- Galley: V2 (WP22) ----
        bibFiles: async () => {
          const { projectId, branch } = ctxRef.current;
          const res = await fetch(withBase(`/api/projects/${encodeURIComponent(projectId)}/references/targets?branch=${encodeURIComponent(branch)}`));
          if (!res.ok) return [];
          const body = await res.json() as { targets?: PluginBibFile[] };
          return Array.isArray(body.targets) ? body.targets : [];
        },
        canEdit: () => page()?.canEdit() ?? true,
        onCompiled: (listener) => {
          compiledListeners.add(listener);
          return () => { compiledListeners.delete(listener); };
        },
      },
      editor: {
        insertAtCursor: (t) => ctxRef.current.insertAtCursor(t),
        insertCitation: (key) => ctxRef.current.insertCitation(key),
        // Galley: V2 (WP22) the citation's exact change, found by comparing the text before and after.
        citeWithHandle: (key) => {
          const view = page()?.view() ?? null;
          const file = ctxRef.current.getActiveFile();
          const before = view ? view.state.doc.toString() : null;
          const result = ctxRef.current.insertCitation(key);
          if (!view || before === null || !result || result === 'present') return { result, handle: null };
          const ins = diffInsertion(before, view.state.doc.toString());
          if (!ins) return { result, handle: null };
          const handle: CitationHandle = Object.freeze({ key, file });
          handles.set(handle, trackInsertion(view, file, ins));
          return { result, handle };
        },
        revert: (handle) => {
          const t = handles.get(handle);
          const view = page()?.view() ?? null;
          if (!t || !view || ctxRef.current.getActiveFile() !== t.file) return false;
          if (!revertInsertion(view, t)) return false;
          handles.delete(handle);
          return true;
        },
      },
      compile: () => ctxRef.current.compile(),
      // Galley: V2 (WP22) a toast with a button goes through the page, whose toast takes one.
      toast: (t, k, action) => {
        const p = page();
        if (action && typeof action.run === 'function' && typeof action.label === 'string' && p) p.toast(t, k, { label: action.label, run: () => action.run() });
        else ctxRef.current.toast(t, k);
      },
      // Galley: V2 (WP22) read-only settings
      settings: {
        get: (settingId) => {
          try { return getSetting<unknown>(String(settingId)); } catch { return undefined; }
        },
        onChange: (ids, listener) => {
          try { return subscribeSetting(ids, () => { try { listener(); } catch (err) { console.error('[plugins] settings listener failed', err); } }); } catch { return () => {}; }
        },
      },
      // plugins address the API root-relatively; the base path is the host's concern
      fetch: (url, init) => fetch(url.startsWith('/') ? withBase(url) : url, init),
      ui: {
        registerSidebarPanel(panel) {
          const onShow = typeof panel.onShow === 'function'
            ? () => { try { panel.onShow!(); } catch (err) { console.error(`[plugins] ${panel.id}: onShow failed`, err); } }
            : undefined;
          // Galley: V2 (WP22) a query sent before the panel rendered waits for it.
          const id = `plugin:${panel.id}`;
          const onQuery = typeof panel.onQuery === 'function' ? panel.onQuery.bind(panel) : null;
          if (onQuery) ownPanels.push(id);
          const mount = (el: HTMLElement) => {
            panel.render(el);
            if (!onQuery) return;
            const deliver = (q: string) => { try { onQuery(q); } catch (err) { console.error(`[plugins] ${panel.id}: onQuery failed`, err); } };
            const pending = panelInbox.get(id)?.pending;
            panelInbox.set(id, { deliver });
            if (typeof pending === 'string') deliver(pending);
          };
          panels.push({ id, title: panel.title, mount, onShow });
        },
        showPanel: (panelId, opts) => {
          // Galley: V2 (WP22) query
          if (typeof opts?.query === 'string') deliverQuery(`plugin:${panelId}`, opts.query);
          ctxRef.current.showPanel(`plugin:${panelId}`, opts?.reveal !== false);
        },
        // Galley: V2 (WP22)
        openSettings: (target) => {
          const t: SettingsTarget | undefined = typeof target === 'string'
            ? (SECTION_RE.test(target) ? { section: target } : undefined)
            : target && typeof target === 'object' ? { section: target.section, setting: target.setting } : undefined;
          const p = page();
          if (p) p.openSettings(t);
          else openSettingsPage(t);
        },
        registerErrorsAction(action) {
          actions.push({ id: action.id, label: action.label, title: action.title, run: () => action.run() });
        },
        registerCommand(command) {
          if (command && typeof command.run === 'function' && command.id && command.title) commands.push(command);
        },
        confirm: (o) => {
          if (!o || typeof o.title !== 'string' || typeof o.confirmLabel !== 'string') return Promise.reject(new TypeError('confirm needs a title and a confirmLabel'));
          return ctxRef.current.confirm({ title: o.title, body: o.body, confirmLabel: o.confirmLabel, cancelLabel: o.cancelLabel, danger: !!o.danger });
        },
      },
    };

    (async () => {
      try {
        const res = await fetch(withBase('/api/plugins'));
        const manifests = (await res.json()) as Array<{ id: string; entry: string; enabled?: boolean }>;
        for (const m of manifests) {
          if (m.enabled === false) continue;
          try {
            const mod = await import(/* @vite-ignore */ withBase(`/plugins/${m.id}/${m.entry}`));
            mod.default?.activate?.(api);
          } catch (err) {
            console.error(`[plugins] failed to load ${m.id}`, err);
          }
        }
        if (!cancelled) { onPanels([...panels]); onErrorsActions?.([...actions]); onCommands?.([...commands]); }
      } catch (err) {
        console.error('[plugins] registry unavailable', err);
      }
    })();

    return () => {
      cancelled = true; listeners.clear(); onPanels([]); onErrorsActions?.([]); onCommands?.([]);
      // Galley: V2 (WP22)
      pageListeners.delete(watchCompiles); offCompiled?.(); compiledListeners.clear();
      for (const id of ownPanels) panelInbox.delete(id);
    };
    // re-activate per project/branch so panels rebuild against fresh context
  }, [ctx.projectId, ctx.branch]);

  useEffect(() => {
    for (const listener of [...filesListeners.current]) {
      try { listener(); } catch (err) { console.error('[plugins] onFilesChanged listener failed', err); }
    }
  }, [files]);

  return null;
}
