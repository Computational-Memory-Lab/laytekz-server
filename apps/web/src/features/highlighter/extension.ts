/**
 * The highlighter in the editor (WP32): reads the doc's HIGHLIGHTS_KEY map,
 * draws the marks, and writes a person's own paints and erasures.
 *
 * - Between Yjs updates the drawn ranges follow CodeMirror's changes the way
 *   the anchors do (start assoc 0 sticks right, end assoc −1 sticks left, so
 *   typing at either edge never grows a highlight). Any change to the map,
 *   and any remote text change (debounced), re-resolves from the anchors, so
 *   every peer draws exactly what the shared data says.
 * - Writes go through `ydoc.transact(…, HL_ORIGIN)` between two
 *   `stopCapturing()` calls: one Mod+Z takes back one highlight action, and
 *   remote highlight changes never enter this person's undo history.
 * - Undo after a deletion: Yjs follows restored ("redone") characters only
 *   for the client that undid (followUndoneDeletions). After each local undo
 *   or redo, anchors whose answer differs with and without following are
 *   rewritten onto the restored characters, under an untracked origin, so
 *   every peer sees the highlight come back.
 * - Nothing here touches the Y.Text: highlights never change the file.
 */
import * as Y from 'yjs';
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view';
import { Facet, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { relAt, resolveMany } from '../../editor/yAnchor';
import type { Notify } from '../types';
import {
  HIGHLIGHTS_KEY, HIGHLIGHTS_MAX, HL_ORIGIN, colorName, drawnColor, isPreset, newKey, readEntry, type Entry, type Run,
} from './model';
import { flatten, isPainted, normalizeRanges, paint, type PaintOp, type Range } from './paint';
import './highlighter.css';

/** Origin of the undo repair's anchor rewrites: never tracked by any undo manager. */
export const HL_REPAIR_ORIGIN = 'laytekz-highlight-repair';

export type Strength = 'light' | 'medium' | 'strong';

export interface HighlighterConfig {
  ydoc: Y.Doc;
  ytext: Y.Text;
  undoManager: Y.UndoManager;
  /** Who writes: 'acct:<id>' with accounts, else this browser's id. */
  me(): { id: string; name: string };
  showOthers: boolean;
  strength: Strength;
  /** Not read-only, and the doc has synced. */
  canWrite(): boolean;
  notify: Notify;
}

export const hlConfig = Facet.define<HighlighterConfig, HighlighterConfig | null>({ combine: (v) => v[0] ?? null });

const setRuns = StateEffect.define<Run[]>();

interface HlState { runs: Run[]; deco: DecorationSet }

/** Every readable highlight of the doc where it sits now; collapsed ones (all their text deleted) are left out. */
export function resolveRuns(ydoc: Y.Doc, ytext: Y.Text): Run[] {
  const map = ydoc.getMap<unknown>(HIGHLIGHTS_KEY);
  const entries: Array<{ key: string; e: Entry }> = [];
  map.forEach((raw, key) => {
    const e = readEntry(raw);
    if (e) entries.push({ key, e });
  });
  const pos = resolveMany(ydoc, ytext, entries.flatMap(({ e }) => [e.a, e.b]));
  const runs: Run[] = [];
  entries.forEach(({ key, e }, i) => {
    const from = pos[2 * i];
    const to = pos[2 * i + 1];
    if (from === null || to === null || to <= from) return;
    runs.push({ key, from, to, color: e.c, author: e.u, name: e.n, t: e.t });
  });
  return runs;
}

/** The runs this person sees: theirs, plus everyone else's unless hidden. */
export function shownRuns(runs: readonly Run[], cfg: Pick<HighlighterConfig, 'showOthers' | 'me'>): Run[] {
  if (cfg.showOthers) return [...runs];
  const me = cfg.me().id;
  return runs.filter((r) => r.author === me);
}

const markCache = new Map<string, Decoration>();
function markFor(run: Run): Decoration {
  const color = drawnColor(run.color);
  const title = `${colorName(color)} highlight${run.name ? ` by ${run.name}` : ''}`;
  const id = `${run.key}\n${color}\n${title}`;
  let deco = markCache.get(id);
  if (!deco) {
    if (markCache.size > 20000) markCache.clear();
    const attributes: Record<string, string> = { 'data-hl': run.key, 'data-hl-color': color, title };
    if (!isPreset(color)) attributes.style = `--hl: ${color}`;
    deco = Decoration.mark({ class: `cm-hl cm-hl--${isPreset(color) ? color : 'custom'}`, attributes });
    markCache.set(id, deco);
  }
  return deco;
}

function buildDeco(runs: readonly Run[], state: EditorState): DecorationSet {
  const cfg = state.facet(hlConfig);
  if (!cfg) return Decoration.none;
  const len = state.doc.length;
  const ranges = flatten(shownRuns(runs, cfg))
    .filter((s) => s.from < len)
    .map((s) => markFor(s.run).range(s.from, Math.min(s.to, len)));
  return Decoration.set(ranges, true);
}

export const highlightField = StateField.define<HlState>({
  create(state) {
    const cfg = state.facet(hlConfig);
    const runs = cfg ? resolveRuns(cfg.ydoc, cfg.ytext) : [];
    return { runs, deco: buildDeco(runs, state) };
  },
  update(value, tr) {
    let { runs, deco } = value;
    let rebuild = false;
    if (tr.docChanged) {
      runs = runs
        .map((r) => ({ ...r, from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) }))
        .filter((r) => r.to > r.from);
      deco = deco.map(tr.changes);
    }
    for (const e of tr.effects) if (e.is(setRuns)) { runs = e.value; rebuild = true; }
    if (tr.startState.facet(hlConfig) !== tr.state.facet(hlConfig)) rebuild = true;
    if (rebuild) deco = buildDeco(runs, tr.state);
    return runs === value.runs && deco === value.deco ? value : { runs, deco };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** The highlights in the view's state (all of them, shown or not). */
export function highlightRuns(state: EditorState): readonly Run[] {
  return state.field(highlightField, false)?.runs ?? [];
}

/** Rewrites anchors that resolve differently with and without following
 *  restored characters onto the restored ones (see the header). Returns the
 *  number of entries rewritten. */
export function repairUndoneAnchors(ydoc: Y.Doc, ytext: Y.Text): number {
  const map = ydoc.getMap<unknown>(HIGHLIGHTS_KEY);
  const entries: Array<{ key: string; raw: Record<string, unknown>; e: Entry }> = [];
  map.forEach((raw, key) => {
    const e = readEntry(raw);
    if (e) entries.push({ key, raw: raw as Record<string, unknown>, e });
  });
  if (!entries.length) return 0;
  const list = entries.flatMap(({ e }) => [e.a, e.b]);
  const followed = resolveMany(ydoc, ytext, list, true);
  const plain = resolveMany(ydoc, ytext, list, false);
  const fixes: Array<{ key: string; value: Record<string, unknown> }> = [];
  entries.forEach(({ key, raw }, i) => {
    const a = followed[2 * i];
    const b = followed[2 * i + 1];
    if (a === null || b === null || b <= a) return;
    if (a === plain[2 * i] && b === plain[2 * i + 1]) return;
    fixes.push({ key, value: { ...raw, a: relAt(ytext, a, 0), b: relAt(ytext, b, -1) } });
  });
  if (fixes.length) ydoc.transact(() => { for (const f of fixes) map.set(f.key, f.value); }, HL_REPAIR_ORIGIN);
  return fixes.length;
}

const syncPlugin = ViewPlugin.define((view) => {
  const cfg = view.state.facet(hlConfig);
  if (!cfg) return {};
  const { ydoc, ytext, undoManager } = cfg;
  const map = ydoc.getMap(HIGHLIGHTS_KEY) as unknown as Y.AbstractType<Y.YEvent<any>>;
  const text = ytext as unknown as Y.AbstractType<Y.YEvent<any>>;
  let gone = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const refresh = () => {
    if (gone) return;
    const effects = setRuns.of(resolveRuns(ydoc, ytext));
    try { view.dispatch({ effects }); } catch { queueMicrotask(() => { if (!gone) view.dispatch({ effects: setRuns.of(resolveRuns(ydoc, ytext)) }); }); }
  };
  // afterTransaction runs after every observer, y-sync's among them: a
  // remote text change has reached the view by then, so positions agree.
  const onAfter = (tr: Y.Transaction) => {
    if (tr.changed.has(map)) {
      if (timer) { clearTimeout(timer); timer = null; }
      refresh();
      return;
    }
    if (!tr.local && tr.changed.has(text) && highlightRuns(view.state).length && !timer) {
      timer = setTimeout(() => { timer = null; refresh(); }, 150);
    }
  };
  const onPopped = () => {
    if (gone) return;
    try { repairUndoneAnchors(ydoc, ytext); } catch (err) { console.warn('[laytekz] highlight repair failed', err); }
  };
  ydoc.on('afterTransaction', onAfter);
  undoManager.on('stack-item-popped', onPopped);
  return {
    destroy() {
      gone = true;
      if (timer) clearTimeout(timer);
      ydoc.off('afterTransaction', onAfter);
      undoManager.off('stack-item-popped', onPopped);
    },
  };
});

/** The editor extension: the config, the field, the sync and the strength attribute. */
export function highlighterExtension(cfg: HighlighterConfig): Extension {
  return [
    hlConfig.of(cfg),
    highlightField,
    syncPlugin,
    EditorView.editorAttributes.of({ 'data-hl-strength': cfg.strength }),
  ];
}

export type WriteResult = 'done' | 'unchanged' | 'off' | 'readonly' | 'empty' | 'blank' | 'full';

/** Writes a paint or an erase over `ranges` as one undo step. */
export function applyHighlight(view: EditorView, ranges: readonly Range[], op: PaintOp): WriteResult {
  const cfg = view.state.facet(hlConfig);
  if (!cfg) return 'off';
  if (!cfg.canWrite()) return 'readonly';
  const want = normalizeRanges(ranges);
  if (!want.length) return 'empty';
  const doc = view.state.doc;
  if (op.kind === 'paint' && want.every((r) => !/\S/.test(doc.sliceString(r.from, r.to)))) return 'blank';
  const { ydoc, ytext, undoManager } = cfg;
  const res = paint(shownRuns(highlightRuns(view.state), cfg), want, op, () => newKey());
  if (!res.upserts.length && !res.deletes.length) return 'unchanged';
  const map = ydoc.getMap<unknown>(HIGHLIGHTS_KEY);
  const added = res.upserts.filter((u) => !map.has(u.key)).length;
  if (added > 0 && map.size - res.deletes.length + added > HIGHLIGHTS_MAX) return 'full';
  undoManager.stopCapturing();
  ydoc.transact(() => {
    for (const key of res.deletes) map.delete(key);
    for (const u of res.upserts) {
      const entry: Entry = { v: 1, a: relAt(ytext, u.from, 0), b: relAt(ytext, u.to, -1), c: u.color, u: u.author, n: u.name, t: u.t };
      map.set(u.key, entry);
    }
  }, HL_ORIGIN);
  undoManager.stopCapturing();
  return 'done';
}

/** The non-empty selection ranges of the view. */
export function selectionRanges(state: EditorState): Range[] {
  return state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.from, to: r.to }));
}

/** Paints the selection with `color`, or removes it when the selection already shows exactly that colour. */
export function toggleSelection(view: EditorView, color: string): WriteResult | 'removed' {
  const cfg = view.state.facet(hlConfig);
  if (!cfg) return 'off';
  const ranges = selectionRanges(view.state);
  if (ranges.length && isPainted(shownRuns(highlightRuns(view.state), cfg), ranges, color)) {
    const r = applyHighlight(view, ranges, { kind: 'erase' });
    return r === 'done' ? 'removed' : r;
  }
  const me = cfg.me();
  return applyHighlight(view, ranges, { kind: 'paint', color, author: me.id, name: me.name, t: Date.now() });
}

/** Removes every highlight of the doc (`mine`: only this person's) as one undo step; returns how many. */
export function clearHighlights(view: EditorView, which: 'mine' | 'all'): number {
  const cfg = view.state.facet(hlConfig);
  if (!cfg || !cfg.canWrite()) return 0;
  const map = cfg.ydoc.getMap<unknown>(HIGHLIGHTS_KEY);
  const me = cfg.me().id;
  const keys: string[] = [];
  map.forEach((raw, key) => {
    const e = readEntry(raw);
    if (e && (which === 'all' || e.u === me)) keys.push(key);
  });
  if (!keys.length) return 0;
  cfg.undoManager.stopCapturing();
  cfg.ydoc.transact(() => { for (const k of keys) map.delete(k); }, HL_ORIGIN);
  cfg.undoManager.stopCapturing();
  return keys.length;
}
