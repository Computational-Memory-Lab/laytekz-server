/**
 * Paint semantics (WP32), pure: applying a colour over a range replaces what
 * is visible there. Other highlights under it are trimmed, or split in two
 * when the range is inside them; touching or overlapping runs of the same
 * colour by the same author merge into one. Erasing trims and splits the same
 * way. The caller passes only the runs it shows, so a co-author's highlights
 * that are hidden are never touched.
 */
import { newer, type Run } from './model';

export interface Range { from: number; to: number }

export type PaintOp =
  | { kind: 'paint'; color: string; author: string; name: string; t: number }
  | { kind: 'erase' };

/** `upserts`: runs to write (a known key replaces that entry, a new key adds one); `deletes`: keys to remove. */
export interface PaintResult { upserts: Run[]; deletes: string[] }

/** The ranges sorted, empty ones dropped, overlapping or touching ones joined. */
export function normalizeRanges(ranges: readonly Range[]): Range[] {
  const sorted = ranges.filter((r) => r.to > r.from).map((r) => ({ from: r.from, to: r.to })).sort((x, y) => x.from - y.from);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push(r);
  }
  return out;
}

export function paint(runs: readonly Run[], ranges: readonly Range[], op: PaintOp, makeKey: () => string): PaintResult {
  let work: Run[] = runs.map((r) => ({ ...r }));
  for (const range of normalizeRanges(ranges)) {
    let { from, to } = range;
    let reuse: string | null = null;
    if (op.kind === 'paint') {
      // Same colour, same author, touching or overlapping: one run. Growing
      // the range can reach further runs, so repeat until nothing joins.
      for (let joined = true; joined;) {
        joined = false;
        for (const r of work) {
          if (r.color !== op.color || r.author !== op.author || r.to < from || r.from > to || r.to <= r.from) continue;
          if (r.from < from || r.to > to) { from = Math.min(from, r.from); to = Math.max(to, r.to); joined = true; }
        }
      }
    }
    const next: Run[] = [];
    for (const r of work) {
      if (r.to <= from || r.from >= to) { next.push(r); continue; }
      if (op.kind === 'paint' && r.color === op.color && r.author === op.author) {
        reuse ??= r.key; // swallowed by the merged run
        continue;
      }
      const left = r.from < from;
      const right = r.to > to;
      if (left) next.push({ ...r, to: from });
      if (right) next.push({ ...r, key: left ? makeKey() : r.key, from: to });
    }
    if (op.kind === 'paint') {
      next.push({ key: reuse ?? makeKey(), from, to, color: op.color, author: op.author, name: op.name, t: op.t });
    }
    work = next;
  }
  const before = new Map(runs.map((r) => [r.key, r]));
  const after = new Set(work.map((r) => r.key));
  const upserts = work.filter((r) => {
    const old = before.get(r.key);
    return !old || old.from !== r.from || old.to !== r.to || old.color !== r.color || old.author !== r.author || old.t !== r.t;
  });
  const deletes = runs.filter((r) => !after.has(r.key)).map((r) => r.key);
  return { upserts, deletes };
}

/** One run per stretch of text, the newest on top where runs overlap; adjacent stretches of one run are one segment. */
export function flatten(runs: readonly Run[]): Array<{ from: number; to: number; run: Run }> {
  const live = runs.filter((r) => r.to > r.from).sort((x, y) => x.from - y.from);
  if (!live.length) return [];
  const points = [...new Set(live.flatMap((r) => [r.from, r.to]))].sort((x, y) => x - y);
  const out: Array<{ from: number; to: number; run: Run }> = [];
  let active: Run[] = [];
  let next = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    while (next < live.length && live[next].from <= a) active.push(live[next++]);
    active = active.filter((r) => r.to > a);
    let top: Run | null = null;
    for (const r of active) if (!top || newer(r, top)) top = r;
    if (!top) continue;
    const last = out[out.length - 1];
    if (last && last.run === top && last.to === a) last.to = b;
    else out.push({ from: a, to: b, run: top });
  }
  return out;
}

/** Whether every character of every non-empty range shows `color`. */
export function isPainted(runs: readonly Run[], ranges: readonly Range[], color: string): boolean {
  const want = normalizeRanges(ranges);
  if (!want.length) return false;
  const segs = flatten(runs).filter((s) => s.run.color === color);
  return want.every((r) => {
    let at = r.from;
    for (const s of segs) {
      if (s.to <= at) continue;
      if (s.from > at) return false;
      at = s.to;
      if (at >= r.to) return true;
    }
    return at >= r.to;
  });
}
