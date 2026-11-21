/**
 * The links feature's mod-click handler (WP20): it tells WP04's arbiter what
 * a ⌘/Ctrl-click at a spot follows (the underline and hint come from the
 * arbiter) and does it on click: open an address, open a project file, go to
 * a label or a .bib entry, or find a key's references. It only reads the
 * document: no follow changes the text.
 */
import { EditorSelection, Facet, type EditorState, type Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { EditorFeatureCtx } from '../types';
import type { ModClickHandler, ModClickTarget } from '../../editor/core/types';
import { findLink, modeFor, type LinkHit } from './detect';
import { ctanUrl, graphicsPathsIn, referencePattern, resolveFile } from './targets';
import { loadIndex, peekIndex, type BibEntry, type LabelEntry } from './indexes';
import { openExternal } from './open';
import { markRegexSeed } from './searchSeed';
import { LINKS_SETTINGS } from './settings';

/** The feature context of the editor the handler runs in (the feature's extension provides it). */
export const linksCtx = Facet.define<EditorFeatureCtx, EditorFeatureCtx | null>({ combine: (v) => v[0] ?? null });

/** What a click does, decided when the target was found. */
export type LinkAction =
  | { kind: 'external'; href: string }
  | { kind: 'file'; path: string }
  | { kind: 'local'; from: number; to: number }
  | { kind: 'ref'; key: string }
  | { kind: 'cite'; key: string }
  | { kind: 'references'; key: string };

export interface Resolved { target: ModClickTarget; action: LinkAction; hit: LinkHit }

const actions = new WeakMap<ModClickTarget, Resolved>();

/** A switch is on unless the store says false (an unreadable store counts as on). */
export function settingOn(ctx: EditorFeatureCtx, id: string): boolean {
  try {
    return ctx.setting<boolean>(id) !== false;
  } catch {
    return true;
  }
}

/** Lines longer than this (minified data, base64) are not scanned. */
const MAX_LINE = 10_000;

const docText = new WeakMap<Text, string>();
function textOf(doc: Text): string {
  let s = docText.get(doc);
  if (s === undefined) { s = doc.toString(); docText.set(doc, s); }
  return s;
}

/** A field of the .bib entry around `pos` (eprinttype, archiveprefix), lower case; null when absent. */
function bibField(state: EditorState, pos: number, name: string): string | null {
  const doc = state.doc;
  const at = doc.lineAt(pos).number;
  let first = at;
  for (let n = at; n >= Math.max(1, at - 200); n--) {
    first = n;
    if (/^\s*@/.test(doc.line(n).text)) break;
  }
  const re = new RegExp(`\\b${name}\\s*=\\s*[{"]?\\s*([A-Za-z]+)`, 'i');
  for (let n = first; n <= Math.min(doc.lines, at + 200); n++) {
    const text = doc.line(n).text;
    if (n > first && /^\s*@/.test(text)) break;
    const m = re.exec(text);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** The link hit at `pos` for a file at `path`, in document offsets. */
export function hitAt(state: EditorState, pos: number, path: string): LinkHit | null {
  if (pos < 0 || pos > state.doc.length) return null;
  const line = state.doc.lineAt(pos);
  if (line.length > MAX_LINE) return null;
  const hit = findLink(line.text, pos - line.from, modeFor(path), { field: (name) => bibField(state, pos, name) });
  return hit ? { ...hit, from: hit.from + line.from, to: hit.to + line.from } : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `\label{key}` (or `\bibitem…{key}`, or a .bib entry's head) in this document; its span or null. */
function localDefinition(doc: Text, key: string, kind: 'label' | 'bibitem' | 'entry'): { from: number; to: number } | null {
  const text = textOf(doc);
  const re = kind === 'label'
    ? new RegExp(`\\\\label\\s*\\{\\s*${escapeRe(key)}\\s*\\}`)
    : kind === 'bibitem'
      ? new RegExp(`\\\\bibitem\\s*(?:\\[[^\\]]*\\])?\\s*\\{\\s*${escapeRe(key)}\\s*\\}`)
      : new RegExp(`@\\s*[A-Za-z]+\\s*[{(]\\s*${escapeRe(key)}\\s*,`);
  const m = re.exec(text);
  return m ? { from: m.index, to: m.index + m[0].length } : null;
}

const lineOf = (doc: Text, pos: number) => doc.lineAt(pos).number;

/** What a hit leads to and the hint's text; null when it leads nowhere this feature may go. */
export function describeHit(hit: LinkHit, ctx: EditorFeatureCtx, state: EditorState): { title: string; error?: string; action: LinkAction } | null {
  if (hit.kind === 'url') return { title: `Open ${hit.href}`, action: { kind: 'external', href: hit.href } };
  if (!settingOn(ctx, LINKS_SETTINGS.project)) return null;
  const page = ctx.page();
  const files = (page?.files() ?? []).filter((f) => f.type === 'file').map((f) => f.path);
  const env = () => ({
    currentFile: ctx.filePath,
    rootFile: ctx.rootFile,
    files,
    graphicsPaths: hit.kind === 'file' && hit.command === 'includegraphics' ? graphicsPathsIn(textOf(state.doc)) : [],
  });
  switch (hit.kind) {
    case 'file': {
      const path = resolveFile(hit.name, hit.command, env());
      if (path) return { title: `Open ${path}`, action: { kind: 'file', path } };
      if (hit.fallbackHref) return { title: `Open ${hit.fallbackHref}`, action: { kind: 'external', href: hit.fallbackHref } };
      return { title: hit.name, error: `No file ${hit.name} in this project`, action: { kind: 'file', path: '' } };
    }
    case 'package': {
      const path = resolveFile(hit.name, hit.command, env());
      if (path) return { title: `Open ${path}`, action: { kind: 'file', path } };
      if (hit.command === 'bibliographystyle') return null;
      const href = ctanUrl(hit.name);
      return { title: `Open ${href}`, action: { kind: 'external', href } };
    }
    case 'ref': {
      const local = localDefinition(state.doc, hit.key, 'label');
      if (local) return { title: `Go to \\label{${hit.key}}, line ${lineOf(state.doc, local.from)}`, action: { kind: 'local', ...local } };
      const { data, fresh } = peekIndex<LabelEntry>('labels', ctx.projectId, ctx.branch);
      const found = data?.find((l) => l.label === hit.key);
      if (found) return { title: `Go to ${hit.key} in ${found.file}${found.line ? `, line ${found.line}` : ''}`, action: { kind: 'ref', key: hit.key } };
      if (data && fresh) return { title: hit.key, error: `No \\label{${hit.key}} in this project`, action: { kind: 'ref', key: hit.key } };
      return { title: `Go to \\label{${hit.key}}`, action: { kind: 'ref', key: hit.key } };
    }
    case 'cite':
    case 'bibkey': {
      const local = localDefinition(state.doc, hit.key, hit.kind === 'cite' ? 'bibitem' : 'entry');
      if (local) return { title: `Go to ${hit.key}, line ${lineOf(state.doc, local.from)}`, action: { kind: 'local', ...local } };
      const { data, fresh } = peekIndex<BibEntry>('bib', ctx.projectId, ctx.branch);
      const found = data?.find((b) => b.key === hit.key);
      if (found) return { title: `Open ${hit.key} in ${found.file}`, action: { kind: 'cite', key: hit.key } };
      if (data && fresh) return { title: hit.key, error: `No bibliography entry for ${hit.key}`, action: { kind: 'cite', key: hit.key } };
      return { title: `Go to the entry for ${hit.key}`, action: { kind: 'cite', key: hit.key } };
    }
    case 'label':
      return { title: `Find references to ${hit.key}`, action: { kind: 'references', key: hit.key } };
  }
}

/** The target at `pos`, remembered with what its click does; null when nothing follows here. */
export function resolveAt(view: { state: EditorState }, pos: number): Resolved | null {
  const ctx = view.state.facet(linksCtx);
  if (!ctx || !settingOn(ctx, LINKS_SETTINGS.follow)) return null;
  const hit = hitAt(view.state, pos, ctx.filePath);
  if (!hit) return null;
  const d = describeHit(hit, ctx, view.state);
  if (!d) return null;
  const target: ModClickTarget = { from: hit.from, to: hit.to, title: d.title, ...(d.error ? { error: d.error } : {}) };
  const r = { target, action: d.action, hit };
  actions.set(target, r);
  return r;
}

const isZoteroFile = (path: string) => /(^|\/)zotero(-[^/]*)?\.bib$/i.test(path);

/** Seeds the Search panel with the key's references (the regex is used for this search only). */
export function findReferences(ctx: EditorFeatureCtx, key: string): void {
  const page = ctx.page();
  if (!page) return;
  const pattern = referencePattern(key);
  markRegexSeed(pattern);
  page.ui.showPanel('search', pattern);
}

function selectLocal(view: EditorView, from: number, to: number): void {
  view.dispatch({ selection: EditorSelection.single(from, to), effects: EditorView.scrollIntoView(from, { y: 'center' }) });
  view.focus();
}

/** Does what a resolved target's click does. */
export async function runAction(view: EditorView, action: LinkAction): Promise<void> {
  const ctx = view.state.facet(linksCtx);
  if (!ctx) return;
  const page = ctx.page();
  switch (action.kind) {
    case 'external':
      if (!openExternal(action.href)) ctx.notify('Laytekz opens only web and email links', 'error');
      return;
    case 'file':
      if (action.path && page) page.openFile(action.path);
      return;
    case 'local':
      selectLocal(view, action.from, action.to);
      return;
    case 'references':
      findReferences(ctx, action.key);
      return;
    case 'ref': {
      let labels = await loadIndex<LabelEntry>('labels', ctx.projectId, ctx.branch);
      let found = labels.find((l) => l.label === action.key);
      if (!found) {
        labels = await loadIndex<LabelEntry>('labels', ctx.projectId, ctx.branch, true);
        found = labels.find((l) => l.label === action.key);
      }
      if (!found) { ctx.notify(`No \\label{${action.key}} in this project`, 'error'); return; }
      if (found.file === ctx.filePath) {
        const local = localDefinition(view.state.doc, action.key, 'label');
        if (local) { selectLocal(view, local.from, local.to); return; }
      }
      page?.openFile(found.file, { find: `\\label{${action.key}}` });
      return;
    }
    case 'cite': {
      let bib = await loadIndex<BibEntry>('bib', ctx.projectId, ctx.branch);
      let found = bib.find((b) => b.key === action.key);
      if (!found) {
        bib = await loadIndex<BibEntry>('bib', ctx.projectId, ctx.branch, true);
        found = bib.find((b) => b.key === action.key);
      }
      if (!found) { ctx.notify(`No bibliography entry for ${action.key}`, 'error'); return; }
      if (found.file === ctx.filePath) {
        const local = localDefinition(view.state.doc, action.key, 'entry');
        if (local) { selectLocal(view, local.from, local.to); return; }
      }
      page?.openFile(found.file, found.line ? { line: found.line } : { find: `{${action.key},` });
      if (isZoteroFile(found.file)) ctx.notify(`${found.file.split('/').pop()} is rewritten by each Zotero sync: change this entry in Zotero.`, 'info');
      return;
    }
  }
}

/** The handler WP04's arbiter asks: highest of the links feature's, below nothing else planned. */
export const linkHandler: ModClickHandler = {
  id: 'links.follow',
  priority: 50,
  target: (view, pos) => resolveAt(view, pos)?.target ?? null,
  run: (view, t) => {
    const r = actions.get(t) ?? resolveAt(view, t.from);
    if (!r || r.target.error) return;
    void runAction(view, r.action);
  },
};

/** The key (label, reference or citation) at `pos`, for Find references. */
export function keyAt(state: EditorState, pos: number, path: string): string | null {
  const hit = hitAt(state, pos, path);
  return hit && (hit.kind === 'ref' || hit.kind === 'cite' || hit.kind === 'label' || hit.kind === 'bibkey') ? hit.key : null;
}

