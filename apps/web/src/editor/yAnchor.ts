/**
 * Galley: V2 (WP32) anchors on a Y.Text as Yjs relative positions, shared by
 * Claude's change marks (agentMarks.ts) and the highlighter
 * (features/highlighter). A relative position names a character, not an
 * offset, so it follows that character through every edit, local, remote or
 * concurrent, and every peer resolves it to the same place.
 *
 * `resolveMany` resolves a list in one pass over the text's items:
 * Yjs's own createAbsolutePositionFromRelativePosition walks every item to
 * the left of each position, which is O(k·n) for k anchors. Here the walk is
 * done once (O(n)) and each anchor is a struct-store lookup (O(log n)). The
 * rare anchor the fast path cannot answer (a deleted character that an undo
 * restored, `followUndoneDeletions`; a position at the end of the type) goes
 * through Yjs's own function, so the answers are always Yjs's answers.
 */
import * as Y from 'yjs';

/** A relative position as JSON (Y.relativePositionToJSON), as stored in side maps. */
export type RelPosJSON = Record<string, unknown>;

/** The position of `index` in `ytext`. assoc 0 (or more) sticks to the
 *  character after the index, −1 to the character before it. */
export function relAt(ytext: Y.Text, index: number, assoc = 0): RelPosJSON {
  const at = Math.max(0, Math.min(index, ytext.length));
  return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, at, assoc)) as RelPosJSON;
}

function parse(json: unknown): Y.RelativePosition | null {
  if (!json || typeof json !== 'object') return null;
  try { return Y.createRelativePositionFromJSON(json); } catch { return null; }
}

/** One position, through Yjs; null when it is unreadable or not in `ytext`. */
export function resolve(ydoc: Y.Doc, ytext: Y.Text, json: unknown, follow = true): number | null {
  const rpos = parse(json);
  if (!rpos) return null;
  try {
    const pos = Y.createAbsolutePositionFromRelativePosition(rpos, ydoc, follow);
    return pos && pos.type === ytext ? pos.index : null;
  } catch { return null; }
}

/** Where each position of `list` sits in `ytext` now (null: unreadable, not
 *  in this text, or its character was garbage collected). Same answers as
 *  `resolve` for every entry; `follow` is Yjs's followUndoneDeletions. */
export function resolveMany(ydoc: Y.Doc, ytext: Y.Text, list: readonly unknown[], follow = true): Array<number | null> {
  if (!list.length) return [];
  let starts: Map<Y.Item, number> | null = null;
  const indexOf = (item: Y.Item): number | undefined => {
    if (!starts) {
      // The visible length before each item of the text, deleted items included.
      starts = new Map();
      let i = 0;
      for (let n = (ytext as unknown as { _start: Y.Item | null })._start; n; n = n.right) {
        starts.set(n, i);
        if (!n.deleted && n.countable) i += n.length;
      }
    }
    return starts.get(item);
  };
  const store = ydoc.store;
  return list.map((json) => {
    const rpos = parse(json);
    if (!rpos) return null;
    const id = rpos.item;
    if (!id) return resolve(ydoc, ytext, json, follow); // the start or end of a type: O(1) in Yjs
    if (typeof id.client !== 'number' || typeof id.clock !== 'number') return null;
    if (!store.clients.has(id.client) || id.clock < 0 || id.clock >= Y.getState(store, id.client)) return null;
    let item: Y.Item | Y.GC;
    try { item = Y.getItem(store, id); } catch { return null; }
    if (!(item instanceof Y.Item)) return null;
    if (follow && item.deleted && item.redone) return resolve(ydoc, ytext, json, follow);
    const start = indexOf(item);
    if (start === undefined) return null; // another type's character
    if (item.deleted || !item.countable) return start;
    return start + (id.clock - item.id.clock) + (rpos.assoc >= 0 ? 0 : 1);
  });
}
