/**
 * F14 desk pet, roaming (PET2): where the pet can stand. Pure geometry, no
 * DOM: the controller measures the page in one batch and hands the boxes in.
 *
 * A surface is a horizontal line the pet's feet rest on, with the x range it
 * may stand in:
 * - `ledge`: the free stretch of a header bar (`[data-perch]` spacers), feet
 *   on the bar's bottom line, or the top edge of the bar under the editor;
 * - `page`: the top edge of a PDF page, inside the preview's scroll box;
 * - `code`: the end of a line of source, in the white space right of the
 *   text (it never covers code), inside the editor's scroll box;
 * - `floor`: the bottom edge of the window.
 * A surface in a scroll box carries that box as `clip`: the whole pet must
 * fit inside it, and while it rides the content it clings to the box's edge
 * when its spot scrolls away (`clampToClip`).
 */

export interface Pt { x: number; y: number }
export interface Box { left: number; top: number; right: number; bottom: number }
export interface Size { w: number; h: number }
export interface View { width: number; height: number }

export type SurfaceKind = 'ledge' | 'page' | 'code' | 'floor';

export interface Surface {
  /** 'ledge:editor', 'page:3', 'code:12', 'floor'. */
  id: string;
  kind: SurfaceKind;
  /** The stretch the pet may stand on, viewport pixels. */
  left: number;
  right: number;
  /** The line its feet rest on. */
  y: number;
  /** The scroll box it must stay inside, or null (the window). */
  clip: Box | null;
}

/** Where the pet would stand: a surface and the feet's point on it. */
export interface Spot { surface: Surface; x: number; y: number }

/** Space kept between the pet and the ends of a surface. */
export const EDGE_PAD = 4;
/** How much each kind of surface is wanted, in total (split between the surfaces of that kind). */
export const KIND_WEIGHT: Record<SurfaceKind, number> = { page: 3, code: 2.2, ledge: 2.4, floor: 0.7 };
/** A ledge near the window's top may let this much of the pet's head reach past it. */
export const LEDGE_OVERHANG = 0.2;

export const petBox = (at: Pt, pet: Size): Box => ({ left: at.x - pet.w / 2, right: at.x + pet.w / 2, top: at.y - pet.h, bottom: at.y });

export const overlaps = (a: Box, b: Box): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

export const clamp = (n: number, lo: number, hi: number): number => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, n)));

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export function floorSurface(view: View): Surface {
  return { id: 'floor', kind: 'floor', left: 0, right: view.width, y: view.height, clip: null };
}

/** The feet's x range on a surface, kept inside the window and its clip box. */
export function standRange(s: Surface, pet: Size, view: View): [number, number] {
  const left = Math.max(s.left, 0, s.clip?.left ?? 0);
  const right = Math.min(s.right, view.width, s.clip?.right ?? Infinity);
  return [left + pet.w / 2 + EDGE_PAD, right - pet.w / 2 - EDGE_PAD];
}

/** Can the pet stand on this surface now: wide enough, inside the window, and wholly inside its clip box. */
export function fits(s: Surface, pet: Size, view: View): boolean {
  const [lo, hi] = standRange(s, pet, view);
  if (hi < lo) return false;
  if (s.y > view.height + 0.5) return false;
  const headroom = s.kind === 'ledge' ? pet.h * (1 - LEDGE_OVERHANG) : pet.h;
  if (s.y - headroom < -0.5) return false;
  if (s.clip && (s.y - pet.h < s.clip.top - 0.5 || s.y > s.clip.bottom + 0.5)) return false;
  return true;
}

export interface PickCtx {
  /** Where the feet are now. */
  from: Pt;
  /** The surface it stands on now (not chosen again while others exist). */
  currentId: string | null;
  pet: Size;
  view: View;
  rng: () => number;
  /** Boxes the pet must not land on (the caret's line while typing). */
  avoid?: readonly Box[];
  /** Run from this point: only spots farther from it than the pet is now. */
  fleeFrom?: Pt | null;
  /** Only these kinds. */
  kinds?: readonly SurfaceKind[];
  /** Twice as likely. */
  prefer?: SurfaceKind | null;
  /** Hops longer than this are less likely. */
  far?: number;
}

/**
 * The next place to hop to, or null when nowhere fits. A weighted draw: each
 * kind of surface gets its share (KIND_WEIGHT) split among its surfaces, very
 * short hops are rare, very long ones less likely; a fleeing pet only takes
 * spots farther from the threat, the farther the better.
 */
export function pickSpot(surfaces: readonly Surface[], c: PickCtx): Spot | null {
  const usable = surfaces.filter((s) => fits(s, c.pet, c.view) && (!c.kinds || c.kinds.includes(s.kind)));
  const others = usable.filter((s) => s.id !== c.currentId);
  const pool = others.length ? others : usable;
  const count: Partial<Record<SurfaceKind, number>> = {};
  for (const s of pool) count[s.kind] = (count[s.kind] ?? 0) + 1;
  const far = c.far ?? 900;
  const before = c.fleeFrom ? dist(c.from, c.fleeFrom) : 0;
  const options: { spot: Spot; weight: number }[] = [];
  for (const s of pool) {
    const [lo, hi] = standRange(s, c.pet, c.view);
    let best: Spot | null = null;
    let bestScore = -Infinity;
    for (let k = 0; k < 3; k++) {
      const x = lo + (hi - lo) * c.rng();
      const at = { x, y: s.y };
      if (c.avoid?.some((b) => overlaps(petBox(at, c.pet), b))) continue;
      const score = c.fleeFrom ? dist(at, c.fleeFrom) : c.rng();
      if (score > bestScore) { bestScore = score; best = { surface: s, x, y: s.y }; }
    }
    if (!best) continue;
    let weight = KIND_WEIGHT[s.kind] / (count[s.kind] ?? 1);
    if (c.prefer === s.kind) weight *= 2;
    const d = dist(best, c.from);
    if (d < 50) weight *= 0.15;
    else if (d > far) weight *= 0.35;
    if (c.fleeFrom) {
      const after = dist(best, c.fleeFrom);
      if (after < before + 60) continue;
      weight *= 1 + (after - before) / 250;
    }
    options.push({ spot: best, weight });
  }
  const total = options.reduce((n, o) => n + o.weight, 0);
  if (!(total > 0)) return null;
  let r = c.rng() * total;
  for (const o of options) {
    r -= o.weight;
    if (r <= 0) return o.spot;
  }
  return options[options.length - 1].spot;
}

/**
 * Where a dropped pet lands: the highest surface at or below its feet whose
 * stretch is under it, else the floor. It keeps its x (pushed onto the
 * stretch when it hangs over an end).
 */
export function surfaceBelow(surfaces: readonly Surface[], at: Pt, pet: Size, view: View): Spot {
  let best: Spot | null = null;
  for (const s of surfaces) {
    if (s.kind === 'floor' || !fits(s, pet, view)) continue;
    const [lo, hi] = standRange(s, pet, view);
    if (at.x < lo - pet.w / 2 || at.x > hi + pet.w / 2) continue;
    if (s.y < at.y - 2) continue;
    if (!best || s.y < best.y) best = { surface: s, x: clamp(at.x, lo, hi), y: s.y };
  }
  if (best) return best;
  const floor = surfaces.find((s) => s.kind === 'floor') ?? floorSurface(view);
  const [lo, hi] = standRange(floor, pet, view);
  return { surface: floor, x: clamp(at.x, lo, hi), y: floor.y };
}

/** One line of source as the editor lays it out (viewport pixels). `endX`: where its text ends (the content's right edge for a wrapped line). */
export interface CodeLine { line: number; top: number; bottom: number; endX: number }

/**
 * Perches in the source's white space: for each visible line, the stretch
 * right of every line the pet's body would cover when standing on that
 * line's bottom edge, `gap` pixels clear of the text.
 */
export function codeSurfaces(lines: readonly CodeLine[], o: { contentLeft: number; contentRight: number; clip: Box; pet: Size; gap?: number }): Surface[] {
  const gap = o.gap ?? 14;
  const right = Math.min(o.contentRight, o.clip.right) - 6;
  const out: Surface[] = [];
  for (const j of lines) {
    if (j.bottom > o.clip.bottom || j.bottom - o.pet.h < o.clip.top) continue;
    const bandTop = j.bottom - o.pet.h;
    let free = o.contentLeft;
    for (const i of lines) if (i.bottom > bandTop + 1 && i.top < j.bottom - 1) free = Math.max(free, i.endX);
    const left = free + gap;
    if (right - left >= o.pet.w + 2 * EDGE_PAD) out.push({ id: `code:${j.line}`, kind: 'code', left, right, y: j.bottom, clip: o.clip });
  }
  return out;
}

// ---- riding ----

/** The feet's offset from a reference box's top-left corner (what an anchor stores). */
export function anchorOffset(at: Pt, ref: { left: number; top: number }): { dx: number; dy: number } {
  return { dx: at.x - ref.left, dy: at.y - ref.top };
}

/** Where the feet are when the reference box has moved (scrolled, resized): the same offset from its corner. */
export function ride(ref: { left: number; top: number }, off: { dx: number; dy: number }): Pt {
  return { x: ref.left + off.dx, y: ref.top + off.dy };
}

export type ClipEdge = 'top' | 'bottom' | 'left' | 'right' | null;

/**
 * Keeps the whole pet inside its clip box. When its spot has scrolled out,
 * the pet holds on at the edge it crossed (`out` says which), and the caller
 * hops it back into view after a moment.
 */
export function clampToClip(p: Pt, clip: Box | null, pet: Size): { at: Pt; out: ClipEdge } {
  if (!clip) return { at: p, out: null };
  const minY = clip.top + pet.h;
  const minX = clip.left + pet.w / 2;
  const maxX = clip.right - pet.w / 2;
  let out: ClipEdge = null;
  if (p.y < minY - 0.5) out = 'top';
  else if (p.y > clip.bottom + 0.5) out = 'bottom';
  else if (p.x < minX - 0.5) out = 'left';
  else if (p.x > maxX + 0.5) out = 'right';
  return { at: { x: clamp(p.x, minX, maxX), y: clamp(p.y, minY, clip.bottom) }, out };
}

/** Keeps the feet inside the window (a resize never strands the pet off screen). */
export function clampToView(p: Pt, pet: Size, view: View): Pt {
  return { x: clamp(p.x, pet.w / 2, view.width - pet.w / 2), y: clamp(p.y, pet.h * (1 - LEDGE_OVERHANG), view.height) };
}
