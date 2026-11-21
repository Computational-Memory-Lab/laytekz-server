/**
 * F14 desk pet, roaming (PET2): what the pet feels like doing. Pure
 * decisions; the controller feeds them the cursor, the clock and the pet's
 * box, and acts on the answer.
 *
 * - A fast cursor close by startles it into a hop away; a cursor flicked
 *   straight at it makes it dodge (you were heading for what is under it);
 *   a cursor resting nearby lets it creep closer.
 * - Left alone it hops between surfaces, scoots along one, looks around,
 *   fidgets or peeks out from behind an edge, more often when Playful.
 * - Typing settles it: nothing voluntary happens within TYPING_QUIET_MS of a
 *   key, and it moves off the line being edited.
 */
import type { PetActivity } from './prefs';
import { clamp, type Box, type Pt } from './surfaces';

export const MOUSE = {
  /** px/ms: a flick. */
  startleSpeed: 1.5,
  startleRadius: 110,
  dodgeSpeed: 0.8,
  /** How far ahead (ms) a moving cursor is projected when checking whether it heads for the pet. */
  dodgeLookahead: 220,
  /** A resting cursor this close (px from the pet's middle) is interesting... */
  creepRadius: 280,
  /** ...and it creeps until it is this far from the cursor. */
  creepStop: 60,
  creepRestMs: 1100,
  /** Hovering this long without clicking: it steps aside (you wanted what is under it). */
  hoverAsideMs: 1400,
} as const;

export const TIMING = {
  /** No voluntary motion this soon after a key. */
  typingQuietMs: 3500,
  /** Idle this long (no pointer or key): it naps (when the setting is on). */
  napAfterMs: { calm: 150_000, playful: 240_000 } as Record<PetActivity, number>,
  /** A startle or dodge at most this often. */
  fleeCooldownMs: 1800,
  /** Out of view this long while riding: it hops back. */
  clingMs: 700,
} as const;

export interface Vec { x: number; y: number }
export interface CursorSample { x: number; y: number; t: number }

/** The cursor's velocity in px/ms over the last `window` ms of samples (zero when it is resting). */
export function velocity(samples: readonly CursorSample[], now: number, window = 80): Vec {
  const recent = samples.filter((s) => now - s.t <= window);
  if (recent.length < 2) return { x: 0, y: 0 };
  const a = recent[0];
  const b = recent[recent.length - 1];
  const dt = Math.max(1, b.t - a.t);
  return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
}

const grow = (b: Box, by: number): Box => ({ left: b.left - by, top: b.top - by, right: b.right + by, bottom: b.bottom + by });

/** Does the segment a→b cross the box? (Liang–Barsky.) */
export function segmentHitsBox(a: Pt, b: Pt, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [[-dx, a.x - box.left], [dx, box.right - a.x], [-dy, a.y - box.top], [dy, box.bottom - a.y]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t0 <= t1;
}

export type CursorReaction = 'startle' | 'dodge' | null;

/** How the pet takes a moving cursor. Hovering it is never a threat (you may want to click it). */
export function cursorReaction(o: { pet: Box; cursor: Pt; v: Vec; hovering: boolean }): CursorReaction {
  if (o.hovering) return null;
  const c = { x: (o.pet.left + o.pet.right) / 2, y: (o.pet.top + o.pet.bottom) / 2 };
  const d = Math.hypot(o.cursor.x - c.x, o.cursor.y - c.y);
  const speed = Math.hypot(o.v.x, o.v.y);
  if (speed >= MOUSE.startleSpeed && d < MOUSE.startleRadius) return 'startle';
  if (speed >= MOUSE.dodgeSpeed && d < 400) {
    const ahead = { x: o.cursor.x + o.v.x * MOUSE.dodgeLookahead, y: o.cursor.y + o.v.y * MOUSE.dodgeLookahead };
    if (segmentHitsBox(o.cursor, ahead, grow(o.pet, 10))) return 'dodge';
  }
  return null;
}

/** Where a curious pet creeps to along its stretch [lo, hi] when the cursor rests at `cursor`, or null (too far, or close enough already). */
export function creepTarget(petX: number, petMid: Pt, cursor: Pt, lo: number, hi: number): number | null {
  const d = Math.hypot(cursor.x - petMid.x, cursor.y - petMid.y);
  if (d > MOUSE.creepRadius) return null;
  const side = cursor.x >= petX ? 1 : -1;
  const want = clamp(cursor.x - side * MOUSE.creepStop, lo, hi);
  return Math.abs(want - petX) < 12 ? null : want;
}

/** Which way to face: toward `toX`, keeping the current way within `hysteresis` px so it does not flicker. */
export function faceToward(fromX: number, toX: number, current: 1 | -1, hysteresis = 24): 1 | -1 {
  const dx = toX - fromX;
  if (Math.abs(dx) <= hysteresis) return current;
  return dx > 0 ? 1 : -1;
}

/** A lean toward a point, degrees (positive: to the right), fading out with distance. */
export function leanToward(feet: Pt, petH: number, target: Pt, max = 8): number {
  const head = { x: feet.x, y: feet.y - petH * 0.6 };
  const dx = target.x - head.x;
  const d = Math.hypot(dx, target.y - head.y);
  if (d > 600 || d < 1) return 0;
  return clamp((dx / Math.max(40, d)) * max * (1 - d / 600) * 1.6, -max, max);
}

export type Thought = 'hop' | 'walk' | 'look' | 'fidget' | 'peek';

/** What to do when left alone. */
export function nextThought(rng: () => number, o: { activity: PetActivity; canWalk: boolean; canPeek: boolean }): Thought {
  const table: [Thought, number][] = [
    ['hop', 0.48],
    ['walk', o.canWalk ? 0.2 : 0],
    ['look', 0.14],
    ['fidget', 0.1],
    ['peek', o.canPeek ? (o.activity === 'playful' ? 0.1 : 0.07) : 0],
  ];
  const total = table.reduce((n, [, w]) => n + w, 0);
  let r = rng() * total;
  for (const [t, w] of table) {
    r -= w;
    if (r <= 0 && w > 0) return t;
  }
  return 'hop';
}

/** How long it sits before its next idea, ms. */
export function restMs(activity: PetActivity, rng: () => number): number {
  const [lo, hi] = activity === 'playful' ? [3000, 8000] : [9000, 20000];
  return Math.round(lo + (hi - lo) * rng());
}

/** Is the pet on (or right next to) the line being edited? `reach`: how far along the line counts as near. */
export function nearCaret(pet: Box, caret: Box, reach = 140): boolean {
  const vertical = pet.top < caret.bottom + 4 && pet.bottom > caret.top - 4;
  if (!vertical) return false;
  const gap = pet.left > caret.right ? pet.left - caret.right : caret.left > pet.right ? caret.left - pet.right : 0;
  return gap < reach;
}

/** The band the pet keeps clear of while you type: the caret's line, across the editor. */
export function caretBand(caret: Box, editor: Box): Box {
  return { left: editor.left, right: editor.right, top: caret.top - 6, bottom: caret.bottom + 6 };
}

/** A person id → null while present, or when they left. */
export type Roster = Map<string, number | null>;

/**
 * People who just arrived: in the roster now and absent for at least
 * `absentMs` (or never seen). The first look (prev null) is not news, nor
 * are you in another tab.
 */
export function arrivals(prev: ReadonlyMap<string, number | null> | null, people: readonly { id: string; self?: boolean }[], now: number, absentMs = 600_000): { next: Roster; fresh: number } {
  const next: Roster = new Map(prev ?? []);
  const present = new Set(people.filter((p) => !p.self).map((p) => p.id));
  let fresh = 0;
  for (const id of present) {
    const was = prev?.get(id);
    if (prev && was !== null && (was === undefined || now - was >= absentMs)) fresh++;
    next.set(id, null);
  }
  for (const [id, v] of next) if (!present.has(id) && v === null) next.set(id, now);
  return { next, fresh };
}
