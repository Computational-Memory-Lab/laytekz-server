/**
 * The highlighter's server side (WP32): the shared side map of a file's Yjs
 * doc (HIGHLIGHTS_KEY, the web client's editor/docCache.ts), its tidy on load
 * and the project-wide list. Highlights live only in the doc's snapshot under
 * META_DIR/yjs: never in the file, git, the compiler's view or the ZIP.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as Y from 'yjs';

/** The side map's name, a wire identifier shared with the web client. */
export const HIGHLIGHTS_KEY = 'highlights';
/** Most highlights one file keeps: the newest. */
export const HIGHLIGHTS_MAX = 5000;
/** Most rows the project list returns. */
export const LIST_MAX = 10000;
/** The origin of the server's own tidy: no client's undo manager tracks it. */
export const TIDY_ORIGIN = 'laytekz-highlight-tidy';
const TEXT_KEY = 'content';

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Where each relative position (JSON) sits in `ytext`, in one pass over its
 *  items; null when unreadable or not in this text. Same answers as Yjs's
 *  createAbsolutePositionFromRelativePosition (the web twin is editor/yAnchor.ts). */
export function resolveMany(ydoc: Y.Doc, ytext: Y.Text, list: readonly unknown[]): Array<number | null> {
  if (!list.length) return [];
  let starts: Map<Y.Item, number> | null = null;
  const store = ydoc.store;
  const slow = (rpos: Y.RelativePosition): number | null => {
    try {
      const pos = Y.createAbsolutePositionFromRelativePosition(rpos, ydoc);
      return pos && pos.type === ytext ? pos.index : null;
    } catch { return null; }
  };
  return list.map((json) => {
    if (!isObj(json)) return null;
    let rpos: Y.RelativePosition;
    try { rpos = Y.createRelativePositionFromJSON(json); } catch { return null; }
    const id = rpos.item;
    if (!id) return slow(rpos);
    if (typeof id.client !== 'number' || typeof id.clock !== 'number') return null;
    if (!store.clients.has(id.client) || id.clock < 0 || id.clock >= Y.getState(store, id.client)) return null;
    let item: Y.Item | Y.GC;
    try { item = Y.getItem(store, id); } catch { return null; }
    if (!(item instanceof Y.Item)) return null;
    if (item.deleted && item.redone) return slow(rpos);
    if (!starts) {
      starts = new Map();
      let i = 0;
      for (let n = (ytext as unknown as { _start: Y.Item | null })._start; n; n = n.right) {
        starts.set(n, i);
        if (!n.deleted && n.countable) i += n.length;
      }
    }
    const start = starts.get(item);
    if (start === undefined) return null;
    if (item.deleted || !item.countable) return start;
    return start + (id.clock - item.id.clock) + (rpos.assoc >= 0 ? 0 : 1);
  });
}

interface V1 { key: string; a: unknown; b: unknown; c: unknown; u: unknown; n: unknown; t: number }

/** The version-1 entries; `junk` lists keys that are no entry at all. Newer versions are neither. */
function readMap(map: Y.Map<unknown>): { v1: V1[]; junk: string[]; newer: Array<{ key: string; t: number | null }> } {
  const v1: V1[] = [];
  const junk: string[] = [];
  const newer: Array<{ key: string; t: number | null }> = [];
  map.forEach((raw, key) => {
    if (!isObj(raw) || typeof raw.v !== 'number' || !Number.isInteger(raw.v) || raw.v < 1) { junk.push(key); return; }
    if (raw.v > 1) { newer.push({ key, t: typeof raw.t === 'number' && Number.isFinite(raw.t) ? raw.t : null }); return; }
    if (!isObj(raw.a) || !isObj(raw.b) || typeof raw.t !== 'number' || !Number.isFinite(raw.t)) { junk.push(key); return; }
    v1.push({ key, a: raw.a, b: raw.b, c: raw.c, u: raw.u, n: raw.n, t: raw.t });
  });
  return { v1, junk, newer };
}

/** Removes malformed entries and highlights whose text is all gone, then
 *  keeps the newest HIGHLIGHTS_MAX. Entries of a newer version are kept
 *  (they count towards the cap when they carry a time). Never touches the
 *  text. Returns how many entries it removed. */
export function tidyHighlights(doc: Y.Doc): number {
  const map = doc.getMap<unknown>(HIGHLIGHTS_KEY);
  if (!map.size) return 0;
  const text = doc.getText(TEXT_KEY);
  const { v1, junk, newer } = readMap(map);
  const pos = resolveMany(doc, text, v1.flatMap((e) => [e.a, e.b]));
  const drop = new Set(junk);
  const kept: Array<{ key: string; t: number }> = [];
  v1.forEach((e, i) => {
    const from = pos[2 * i];
    const to = pos[2 * i + 1];
    if (from === null || to === null || to <= from) drop.add(e.key);
    else kept.push({ key: e.key, t: e.t });
  });
  for (const n of newer) if (n.t !== null) kept.push({ key: n.key, t: n.t });
  kept.sort((x, y) => (y.t - x.t) || (x.key < y.key ? 1 : x.key > y.key ? -1 : 0));
  for (const k of kept.slice(HIGHLIGHTS_MAX)) drop.add(k.key);
  if (!drop.size) return 0;
  doc.transact(() => { for (const k of drop) map.delete(k); }, TIDY_ORIGIN);
  return drop.size;
}

export interface ListedHighlight {
  id: string; colour: string; author: string; authorId: string; t: number; from: number; to: number; line: number; excerpt: string;
}

const COLOUR_RE = /^(yellow|orange|pink|green|sky|violet|#[0-9a-f]{6})$/;

/** A doc's highlights where they sit now, newest first. */
export function listHighlights(doc: Y.Doc): ListedHighlight[] {
  const map = doc.getMap<unknown>(HIGHLIGHTS_KEY);
  if (!map.size) return [];
  const text = doc.getText(TEXT_KEY);
  const content = text.toString();
  const { v1 } = readMap(map);
  const pos = resolveMany(doc, text, v1.flatMap((e) => [e.a, e.b]));
  const out: ListedHighlight[] = [];
  v1.forEach((e, i) => {
    const from = pos[2 * i];
    const to = pos[2 * i + 1];
    if (from === null || to === null || to <= from) return;
    let line = 1;
    for (let j = content.indexOf('\n'); j !== -1 && j < from; j = content.indexOf('\n', j + 1)) line++;
    out.push({
      id: e.key,
      colour: typeof e.c === 'string' && COLOUR_RE.test(e.c) ? e.c : 'yellow',
      author: typeof e.n === 'string' ? e.n.slice(0, 200) : '',
      authorId: typeof e.u === 'string' ? e.u.slice(0, 200) : '',
      t: e.t,
      from,
      to,
      line,
      excerpt: content.slice(from, Math.min(to, from + 80)),
    });
  });
  return out.sort((x, y) => y.t - x.t || (x.id < y.id ? 1 : -1));
}

/** The snapshot file of a doc name (collab.ts's own layout under META_DIR/yjs). */
export function snapshotPath(metaRoot: string, name: string): string {
  return path.join(metaRoot, 'yjs', crypto.createHash('sha1').update(name).digest('hex') + '.ybin');
}

/** A closed doc's state from its snapshot, brought up to the file's text
 *  (LF) when the snapshot lags it (a pull or a REST write while closed), in
 *  a scratch doc the caller destroys. Null when there is no usable snapshot. */
export function scratchFromSnapshot(snapFile: string, diskTextLF: string | null, diff: (a: string, b: string) => Array<{ from: number; to: number; insert: string }>): Y.Doc | null {
  let bytes: Uint8Array;
  try { bytes = fs.readFileSync(snapFile); } catch { return null; }
  if (bytes.length === 0) return null;
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, bytes);
    if (diskTextLF !== null) {
      const text = scratch.getText(TEXT_KEY);
      const held = text.toString().replace(/\r\n?/g, '\n');
      if (held !== text.toString()) return scratch; // an old CRLF snapshot: positions are close enough for a list
      if (held !== diskTextLF) {
        const spans = diff(held, diskTextLF);
        scratch.transact(() => {
          for (let i = spans.length - 1; i >= 0; i--) {
            const s = spans[i];
            if (s.to > s.from) text.delete(s.from, s.to - s.from);
            if (s.insert) text.insert(s.from, s.insert);
          }
        });
      }
    }
    return scratch;
  } catch {
    scratch.destroy();
    return null;
  }
}
