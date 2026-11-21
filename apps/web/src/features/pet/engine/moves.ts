/**
 * F14 desk pet, roaming (PET2): how the pet moves. Pure functions of time:
 * the controller samples them once per animation frame while the pet is
 * moving, and runs no frame at all while it is still.
 *
 * - A hop is a ballistic arc (constant horizontal speed, a parabola in y with
 *   its peak `apex` pixels above the higher end), with a crouch before take
 *   off, stretch along the flight and a springy squash on landing.
 * - Its landing point may move while it is in the air (it hops onto a PDF
 *   page that is scrolling): the arc is bent toward the live target so it
 *   lands exactly on it.
 * - A walk scoots along the surface with a waddle; a fall is plain gravity.
 * Poses are the feet's point plus scale and rotation about the feet.
 */
import type { Pt } from './surfaces';

/** Pixels per millisecond squared: a cartoon gravity (about 3.2 g at 100 px per metre). */
export const GRAVITY = 0.0032;

export interface Pose {
  x: number;
  y: number;
  sx: number;
  sy: number;
  /** Degrees, about the feet. */
  rot: number;
  /** The line under the pet (for its shadow). */
  ground: number;
  phase: 'crouch' | 'air' | 'land' | 'done';
}

export interface HopPlan {
  from: Pt;
  to: Pt;
  /** Peak height above the higher end, pixels. */
  apex: number;
  crouch: number;
  air: number;
  land: number;
  dir: 1 | -1;
  /** A full turn in the air (a happy hop). */
  spin: boolean;
}

export const clampN = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

/**
 * A hop from one point to another. `height` overrides the apex; `quick`
 * shortens the crouch; `ceiling` is the highest the feet may go (the pet's
 * height below the window's top, so it never leaves the window), which
 * flattens hops from the bars near the top.
 */
export function planHop(from: Pt, to: Pt, o: { height?: number; quick?: boolean; spin?: boolean; ceiling?: number } = {}): HopPlan {
  const dx = to.x - from.x;
  const rise = Math.max(0, from.y - to.y);
  let apex = o.height ?? clampN(22 + Math.abs(dx) * 0.2 + rise * 0.2, 22, 150);
  if (o.ceiling !== undefined) apex = Math.max(8, Math.min(apex, Math.min(from.y, to.y) - o.ceiling));
  const peak = Math.min(from.y, to.y) - apex;
  const up = Math.sqrt((2 * (from.y - peak)) / GRAVITY);
  const down = Math.sqrt((2 * (to.y - peak)) / GRAVITY);
  return {
    from, to, apex,
    crouch: o.quick ? 50 : 120,
    air: clampN(up + down, 220, 1100),
    land: 260,
    dir: dx < -0.5 ? -1 : dx > 0.5 ? 1 : 1,
    spin: !!o.spin,
  };
}

export const hopDuration = (p: HopPlan) => p.crouch + p.air + p.land;

/**
 * The height of a ballistic arc at t ∈ [0, 1] from y0 to y1 peaking at
 * peakY: the parabola through the three points with its vertex at the peak.
 */
export function arcY(y0: number, y1: number, peakY: number, t: number): number {
  const sp = Math.sqrt(Math.max(1, y0 - peakY));
  const sq = Math.sqrt(Math.max(1, y1 - peakY));
  const a = (sp + sq) * (sp + sq);
  return a * t * t - 2 * (sp + sq) * sp * t + y0;
}

/** The landing squash at t ∈ [0, 1]: squashed, one springy overshoot, settled. */
export function landSquash(t: number, strength = 1): { sx: number; sy: number } {
  const k = Math.exp(-5 * t) * Math.cos(t * Math.PI * 2.2) * strength;
  return { sx: 1 + 0.22 * k, sy: 1 - 0.26 * k };
}

/** The pose `elapsed` ms into a hop, landing on `liveTo` (the target's current position). */
export function hopPose(p: HopPlan, elapsed: number, liveTo: Pt = p.to): Pose {
  const { from } = p;
  if (elapsed < p.crouch) {
    const k = easeOut(elapsed / p.crouch);
    return { x: from.x, y: from.y, sx: 1 + 0.16 * k, sy: 1 - 0.2 * k, rot: 0, ground: from.y, phase: 'crouch' };
  }
  const ta = (elapsed - p.crouch) / p.air;
  if (ta < 1) {
    const shiftX = (liveTo.x - p.to.x) * ta;
    const shiftY = (liveTo.y - p.to.y) * ta;
    const peak = Math.min(from.y, p.to.y) - p.apex;
    const x = from.x + (p.to.x - from.x) * ta + shiftX;
    const y = arcY(from.y, p.to.y, peak, ta) + shiftY;
    // Stretch along the flight: most at take off and touch down, none at the peak.
    const speed = Math.abs(1 - 2 * ta);
    const stretch = 0.16 * speed * speed;
    const lean = p.dir * 9 * Math.sin(Math.PI * ta);
    const rot = p.spin ? p.dir * 360 * easeInOut(ta) : lean;
    return { x, y, sx: 1 - stretch * 0.6, sy: 1 + stretch, rot, ground: from.y + (liveTo.y - from.y) * ta, phase: 'air' };
  }
  const tl = (elapsed - p.crouch - p.air) / p.land;
  if (tl < 1) {
    const sq = landSquash(tl, clampN(0.5 + p.apex / 80, 0.5, 1));
    return { x: liveTo.x, y: liveTo.y, ...sq, rot: 0, ground: liveTo.y, phase: 'land' };
  }
  return { x: liveTo.x, y: liveTo.y, sx: 1, sy: 1, rot: 0, ground: liveTo.y, phase: 'done' };
}

// ---- walking ----

export interface WalkPlan { from: number; to: number; dur: number; dir: 1 | -1 }

/** Pixels per millisecond: a scoot, not a stroll. */
export const WALK_SPEED = 0.11;

export function planWalk(from: number, to: number, speed = WALK_SPEED): WalkPlan {
  return { from, to, dur: clampN(Math.abs(to - from) / speed, 200, 6000), dir: to < from ? -1 : 1 };
}

/** Progress along the walk (0–1, eased) and the waddle: a bob up off the surface and a rock side to side. */
export function walkPose(p: WalkPlan, elapsed: number): { k: number; x: number; bob: number; rot: number; sx: number; sy: number; done: boolean } {
  const t = clampN(elapsed / p.dur, 0, 1);
  if (t >= 1) return { k: 1, x: p.to, bob: 0, rot: 0, sx: 1, sy: 1, done: true };
  const k = easeInOut(t);
  const step = Math.sin((elapsed / 150) * Math.PI);
  const flat = 1 - Math.abs(step);
  return { k, x: p.from + (p.to - p.from) * k, bob: Math.abs(step) * 3, rot: step * 6, sx: 1 + 0.03 * flat, sy: 1 - 0.03 * flat, done: false };
}

// ---- falling ----

/** Free fall from y0: where it is after `elapsed` ms, and whether it has reached `floorY`. */
export function fallY(y0: number, elapsed: number, floorY: number, v0 = 0): { y: number; landed: boolean } {
  const y = y0 + v0 * elapsed + 0.5 * GRAVITY * elapsed * elapsed;
  return y >= floorY ? { y: floorY, landed: true } : { y, landed: false };
}

/** How long a fall from y0 to floorY takes, ms. */
export function fallTime(y0: number, floorY: number): number {
  return floorY <= y0 ? 0 : Math.sqrt((2 * (floorY - y0)) / GRAVITY);
}

// ---- hiding (peeking from behind an edge) ----

/**
 * The offset of a peek, `elapsed` ms in: it slides `hide` pixels behind an
 * edge, waits, shows `peek` of that again (looking out), waits, and comes
 * back. Null when it is over.
 */
export function tuckOffset(elapsed: number, hide: number, peek: number, waitMs: number): number | null {
  const steps: [number, number][] = [[0, 0], [320, hide], [320 + waitMs, hide], [560 + waitMs, peek], [1700 + waitMs, peek], [1900 + waitMs, peek * 0.6], [2200 + waitMs, peek * 0.6], [2550 + waitMs, 0]];
  if (elapsed >= steps[steps.length - 1][0]) return null;
  for (let i = 1; i < steps.length; i++) {
    const [t1, v1] = steps[i];
    const [t0, v0] = steps[i - 1];
    if (elapsed <= t1) return v0 + (v1 - v0) * easeInOut((elapsed - t0) / Math.max(1, t1 - t0));
  }
  return 0;
}

// ---- one-shot effects (Web Animations keyframes on the effect layer) ----

export type Effect = 'squeak' | 'wiggle' | 'shake' | 'perk' | 'stretch' | 'wobble';

/** Keyframes and duration of an effect. Only transform, about the feet. */
export function effect(name: Effect): { keyframes: Keyframe[]; duration: number } {
  const k = (t: string, offset?: number): Keyframe => (offset === undefined ? { transform: t } : { transform: t, offset });
  switch (name) {
    case 'squeak':
      return { duration: 420, keyframes: [k('scale(1, 1)'), k('scale(1.28, 0.66)', 0.18), k('scale(0.9, 1.16)', 0.45), k('scale(1.05, 0.96)', 0.7), k('scale(1, 1)')] };
    case 'wiggle':
      return { duration: 560, keyframes: [k('rotate(0deg)'), k('rotate(-9deg)', 0.2), k('rotate(8deg)', 0.45), k('rotate(-5deg)', 0.7), k('rotate(3deg)', 0.87), k('rotate(0deg)')] };
    case 'shake':
      // A sad shake: it droops and shakes its head.
      return { duration: 900, keyframes: [k('translateX(0) rotate(0deg) scale(1, 1)'), k('translateX(-3px) rotate(-7deg) scale(1.04, 0.92)', 0.15), k('translateX(3px) rotate(7deg) scale(1.04, 0.92)', 0.32), k('translateX(-3px) rotate(-6deg) scale(1.04, 0.92)', 0.5), k('translateX(2px) rotate(4deg) scale(1.03, 0.94)', 0.68), k('translateX(0) rotate(0deg) scale(1.02, 0.95)', 0.85), k('translateX(0) rotate(0deg) scale(1, 1)')] };
    case 'perk':
      return { duration: 500, keyframes: [k('scale(1, 1)'), k('scale(0.96, 1.12)', 0.35), k('scale(1.02, 0.98)', 0.7), k('scale(1, 1)')] };
    case 'stretch':
      return { duration: 700, keyframes: [k('scale(1, 1)'), k('scale(0.88, 1.18)', 0.4), k('scale(1.06, 0.95)', 0.75), k('scale(1, 1)')] };
    case 'wobble':
      return { duration: 1000, keyframes: [k('rotate(0deg)'), k('rotate(-6deg)', 0.25), k('rotate(5deg)', 0.55), k('rotate(-2deg)', 0.8), k('rotate(0deg)')] };
  }
}
