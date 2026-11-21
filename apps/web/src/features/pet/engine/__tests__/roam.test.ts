import { describe, expect, it } from 'vitest';
import {
  MOUSE, arrivals, caretBand, creepTarget, cursorReaction, faceToward, leanToward, nearCaret, nextThought, restMs, segmentHitsBox, velocity,
} from '../mood';
import { GRAVITY, arcY, effect, fallTime, fallY, hopPose, landSquash, planHop, planWalk, tuckOffset, walkPose, type Effect } from '../moves';
import {
  anchorOffset, clampToClip, clampToView, codeSurfaces, fits, floorSurface, petBox, pickSpot, ride, standRange, surfaceBelow,
  type Surface,
} from '../surfaces';

/** A deterministic rng (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const view = { width: 1400, height: 900 };
const pet = { w: 43, h: 40 };
const pdfClip = { left: 800, top: 82, right: 1400, bottom: 900 };
const ledge = (id: string, left: number, right: number, y: number): Surface => ({ id: `ledge:${id}`, kind: 'ledge', left, right, y, clip: null });
const page = (n: number, top: number): Surface => ({ id: `page:${n}`, kind: 'page', left: 830, right: 1370, y: top, clip: pdfClip });

describe('surfaces', () => {
  const editor = ledge('editor', 400, 700, 80);
  it('a surface fits when wide enough, inside the window, and the whole pet is inside its scroll box', () => {
    expect(fits(editor, pet, view)).toBe(true);
    expect(fits(ledge('narrow', 400, 440, 80), pet, view)).toBe(false);
    expect(fits(page(2, 400), pet, view)).toBe(true);
    // Too close under the PDF bar: the head would cover it.
    expect(fits(page(1, 100), pet, view)).toBe(false);
    // Scrolled below the preview's bottom edge.
    expect(fits(page(3, 950), pet, view)).toBe(false);
    // A ledge right under the window top: at most a fifth of the head may tuck behind the bar above.
    expect(fits(ledge('top', 0, 300, 34), pet, view)).toBe(true);
    expect(fits(ledge('top', 0, 300, 20), pet, view)).toBe(false);
  });

  it('keeps the feet inside the stretch, the window and the clip box', () => {
    expect(standRange(editor, pet, view)).toEqual([400 + 21.5 + 4, 700 - 21.5 - 4]);
    const wide = { ...page(2, 400), left: 700, right: 1500 };
    const [lo, hi] = standRange(wide, pet, view);
    expect(lo).toBeGreaterThanOrEqual(800 + pet.w / 2);
    expect(hi).toBeLessThanOrEqual(1400 - pet.w / 2);
  });

  it('picks another surface, never a box it must avoid, deterministic for a seed', () => {
    const surfaces = [editor, page(2, 400), page(3, 1300), floorSurface(view)];
    const from = { x: 450, y: 80 };
    for (let seed = 1; seed < 60; seed++) {
      const spot = pickSpot(surfaces, { from, currentId: editor.id, pet, view, rng: seeded(seed) });
      expect(spot).not.toBeNull();
      expect(spot!.surface.id).not.toBe(editor.id);
      expect(spot!.surface.id).not.toBe('page:3');
      const [lo, hi] = standRange(spot!.surface, pet, view);
      expect(spot!.x).toBeGreaterThanOrEqual(lo);
      expect(spot!.x).toBeLessThanOrEqual(hi);
    }
    const a = pickSpot(surfaces, { from, currentId: null, pet, view, rng: seeded(7) });
    const b = pickSpot(surfaces, { from, currentId: null, pet, view, rng: seeded(7) });
    expect(a).toEqual(b);
    const avoid = [{ left: 0, right: 1400, top: 360, bottom: 420 }];
    for (let seed = 1; seed < 40; seed++) {
      const spot = pickSpot(surfaces, { from, currentId: editor.id, pet, view, rng: seeded(seed), avoid });
      expect(spot?.surface.id).not.toBe('page:2');
    }
  });

  it('each kind gets its share however many surfaces it has', () => {
    const code: Surface[] = Array.from({ length: 30 }, (_, i) => ({ id: `code:${i + 1}`, kind: 'code', left: 300, right: 700, y: 120 + i * 20, clip: { left: 250, top: 82, right: 780, bottom: 900 } }));
    const surfaces = [...code, page(2, 400)];
    let pages = 0;
    for (let seed = 1; seed <= 400; seed++) if (pickSpot(surfaces, { from: { x: 700, y: 400 }, currentId: null, pet, view, rng: seeded(seed) })?.surface.kind === 'page') pages++;
    // Pages weigh 3 against code's 2.2: roughly 58 % despite 30 code lines.
    expect(pages).toBeGreaterThan(160);
    expect(pages).toBeLessThan(300);
  });

  it('a startled pet only takes spots farther from the cursor', () => {
    const surfaces = [ledge('editor', 300, 700, 80), ledge('preview', 900, 1300, 80), page(2, 400), floorSurface(view)];
    const from = { x: 500, y: 80 };
    const cursor = { x: 520, y: 70 };
    for (let seed = 1; seed < 50; seed++) {
      const spot = pickSpot(surfaces, { from, currentId: 'ledge:editor', pet, view, rng: seeded(seed), fleeFrom: cursor });
      if (!spot) continue;
      expect(Math.hypot(spot.x - cursor.x, spot.y - cursor.y)).toBeGreaterThan(Math.hypot(from.x - cursor.x, from.y - cursor.y) + 60);
    }
  });

  it('a dropped pet lands on the highest surface below it, else the floor', () => {
    const surfaces = [ledge('editor', 400, 700, 80), page(2, 400), page(3, 700), floorSurface(view)];
    expect(surfaceBelow(surfaces, { x: 1000, y: 200 }, pet, view).surface.id).toBe('page:2');
    expect(surfaceBelow(surfaces, { x: 1000, y: 500 }, pet, view).surface.id).toBe('page:3');
    expect(surfaceBelow(surfaces, { x: 1000, y: 750 }, pet, view).surface.id).toBe('floor');
    const onEdge = surfaceBelow(surfaces, { x: 405, y: 30 }, pet, view);
    expect(onEdge.surface.id).toBe('ledge:editor');
    expect(onEdge.x).toBe(standRange(surfaces[0], pet, view)[0]);
    const floor = surfaceBelow([], { x: -50, y: 300 }, pet, view);
    expect(floor).toMatchObject({ y: 900, x: pet.w / 2 + 4 });
  });

  it('code perches sit in the white space right of every line the pet would cover', () => {
    const clip = { left: 250, top: 82, right: 780, bottom: 900 };
    const lines = [
      { line: 1, top: 100, bottom: 120, endX: 600 },
      { line: 2, top: 120, bottom: 140, endX: 320 },
      { line: 3, top: 140, bottom: 160, endX: 340 },
      { line: 4, top: 160, bottom: 180, endX: 760 },
    ];
    const out = codeSurfaces(lines, { contentLeft: 260, contentRight: 780, clip, pet });
    const byLine = Object.fromEntries(out.map((s) => [s.id, s]));
    // Standing on line 2 the pet (40 px) covers lines 1 and 2: clear of line 1's text, which ends at 600.
    expect(byLine['code:2']).toMatchObject({ left: 614, right: 774, y: 140, kind: 'code' });
    // On line 3 it covers lines 2 and 3 only.
    expect(byLine['code:3']).toMatchObject({ left: 354, right: 774, y: 160 });
    // Line 1's band is cut off by the clip top; line 4 has no room left.
    expect(byLine['code:1']).toBeUndefined();
    expect(byLine['code:4']).toBeUndefined();
  });

  it('riding keeps the feet at the same offset from the element when it scrolls', () => {
    const at = { x: 1000, y: 400 };
    const pageBox = { left: 830, top: 400 };
    const off = anchorOffset(at, pageBox);
    // The PDF scrolled down by 150 px: the page (and the pet) move up by 150.
    expect(ride({ left: 830, top: 250 }, off)).toEqual({ x: 1000, y: 250 });
    // The split pane was dragged left by 60 px.
    expect(ride({ left: 770, top: 250 }, off)).toEqual({ x: 940, y: 250 });
  });

  it('clings to the edge its spot scrolled past', () => {
    expect(clampToClip({ x: 1000, y: 400 }, pdfClip, pet)).toEqual({ at: { x: 1000, y: 400 }, out: null });
    expect(clampToClip({ x: 1000, y: 60 }, pdfClip, pet)).toEqual({ at: { x: 1000, y: 82 + 40 }, out: 'top' });
    expect(clampToClip({ x: 1000, y: 1200 }, pdfClip, pet)).toEqual({ at: { x: 1000, y: 900 }, out: 'bottom' });
    expect(clampToClip({ x: 790, y: 400 }, pdfClip, pet).out).toBe('left');
    expect(clampToClip({ x: 5, y: 5 }, null, pet)).toEqual({ at: { x: 5, y: 5 }, out: null });
    expect(clampToView({ x: 2000, y: 2000 }, pet, view)).toEqual({ x: 1400 - pet.w / 2, y: 900 });
  });
});

describe('moves', () => {
  it('an arc starts and ends on its points and peaks at the apex', () => {
    for (const [y0, y1] of [[400, 400], [400, 200], [100, 700]]) {
      const peak = Math.min(y0, y1) - 60;
      expect(arcY(y0, y1, peak, 0)).toBeCloseTo(y0, 6);
      expect(arcY(y0, y1, peak, 1)).toBeCloseTo(y1, 6);
      let min = Infinity;
      for (let t = 0; t <= 1; t += 0.001) min = Math.min(min, arcY(y0, y1, peak, t));
      expect(min).toBeCloseTo(peak, 0);
    }
  });

  it('a hop crouches, stretches in the air, lands squashed and settles on the target', () => {
    const p = planHop({ x: 100, y: 400 }, { x: 500, y: 300 });
    expect(p.dir).toBe(1);
    expect(p.apex).toBeGreaterThan(22);
    const crouch = hopPose(p, p.crouch * 0.9);
    expect(crouch.phase).toBe('crouch');
    expect(crouch.sy).toBeLessThan(0.85);
    expect(crouch.sx).toBeGreaterThan(1.1);
    const takeOff = hopPose(p, p.crouch + 5);
    expect(takeOff.phase).toBe('air');
    expect(takeOff.sy).toBeGreaterThan(1.1);
    const top = hopPose(p, p.crouch + p.air / 2);
    expect(top.y).toBeLessThan(300);
    const land = hopPose(p, p.crouch + p.air + 1);
    expect(land.phase).toBe('land');
    expect(land.sy).toBeLessThan(0.85);
    const done = hopPose(p, p.crouch + p.air + p.land + 1);
    expect(done).toMatchObject({ x: 500, y: 300, sx: 1, sy: 1, rot: 0, phase: 'done' });
    // Air time follows gravity: a higher hop takes longer.
    expect(planHop({ x: 0, y: 400 }, { x: 0, y: 400 }, { height: 100 }).air).toBeGreaterThan(planHop({ x: 0, y: 400 }, { x: 0, y: 400 }, { height: 20 }).air);
    expect(planHop({ x: 0, y: 400 }, { x: 0, y: 400 }, { height: 80 }).air).toBeCloseTo(2 * Math.sqrt(160 / GRAVITY), 0);
  });

  it('a hop never leaves the window: from a bar near the top it flattens under the ceiling', () => {
    const p = planHop({ x: 500, y: 80 }, { x: 1120, y: 340 }, { ceiling: 46 });
    expect(p.apex).toBe(34);
    let top = Infinity;
    for (let t = p.crouch; t < p.crouch + p.air; t += 2) top = Math.min(top, hopPose(p, t).y);
    expect(top).toBeGreaterThanOrEqual(46 - 0.5);
    expect(planHop({ x: 0, y: 50 }, { x: 300, y: 50 }, { ceiling: 46 }).apex).toBe(8);
    expect(planHop({ x: 0, y: 600 }, { x: 300, y: 600 }, { ceiling: 46 }).apex).toBe(82);
  });

  it('a hop bends toward a target that moves while it is in the air, and lands on it', () => {
    const p = planHop({ x: 100, y: 400 }, { x: 500, y: 400 });
    const moved = { x: 500, y: 250 };
    const mid = hopPose(p, p.crouch + p.air / 2, moved);
    const still = hopPose(p, p.crouch + p.air / 2);
    expect(mid.y).toBeCloseTo(still.y - 75, 5);
    expect(hopPose(p, p.crouch + p.air + p.land + 1, moved)).toMatchObject({ x: 500, y: 250 });
  });

  it('faces the way it hops; a happy hop spins a full turn', () => {
    expect(planHop({ x: 500, y: 0 }, { x: 100, y: 0 }).dir).toBe(-1);
    const spin = planHop({ x: 0, y: 400 }, { x: 0, y: 400 }, { height: 30, spin: true });
    expect(hopPose(spin, spin.crouch + spin.air * 0.999).rot).toBeGreaterThan(355);
  });

  it('the landing squash springs back to rest', () => {
    expect(landSquash(0).sy).toBeCloseTo(0.74, 5);
    expect(Math.abs(landSquash(1).sy - 1)).toBeLessThan(0.01);
    expect(landSquash(0.3).sy).toBeGreaterThan(1);
  });

  it('a walk waddles along and stops on the spot', () => {
    const w = planWalk(100, 300);
    expect(w.dir).toBe(1);
    expect(w.dur).toBeCloseTo(200 / 0.11, 0);
    const mid = walkPose(w, w.dur / 2 + 75);
    expect(mid.x).toBeGreaterThan(100);
    expect(mid.x).toBeLessThan(300);
    expect(Math.abs(mid.rot)).toBeGreaterThan(0);
    expect(walkPose(w, w.dur + 10)).toMatchObject({ x: 300, bob: 0, rot: 0, done: true });
  });

  it('falls with gravity and stops on the floor', () => {
    expect(fallY(0, 100, 1000).y).toBeCloseTo(0.5 * GRAVITY * 100 * 100, 6);
    expect(fallY(0, 10_000, 500)).toEqual({ y: 500, landed: true });
    expect(fallY(0, fallTime(0, 400), 400).landed).toBe(true);
  });

  it('a peek hides, looks out and comes back', () => {
    expect(tuckOffset(0, 40, 17, 1000)).toBe(0);
    expect(tuckOffset(320 + 500, 40, 17, 1000)).toBe(40);
    expect(tuckOffset(1000 + 1000, 40, 17, 1000)).toBe(17);
    expect(tuckOffset(10_000, 40, 17, 1000)).toBeNull();
  });

  it('effects only change transform', () => {
    for (const n of ['squeak', 'wiggle', 'shake', 'perk', 'stretch', 'wobble'] as Effect[]) {
      const e = effect(n);
      expect(e.duration).toBeGreaterThan(0);
      for (const k of e.keyframes) expect(Object.keys(k).filter((p) => p !== 'offset')).toEqual(['transform']);
    }
  });
});

describe('mood', () => {
  const box = petBox({ x: 500, y: 400 }, pet);
  it('measures the cursor speed over the last moments', () => {
    expect(velocity([{ x: 0, y: 0, t: 0 }, { x: 100, y: 0, t: 50 }], 60)).toEqual({ x: 2, y: 0 });
    expect(velocity([{ x: 0, y: 0, t: 0 }, { x: 100, y: 0, t: 50 }], 500)).toEqual({ x: 0, y: 0 });
  });
  it('a flick nearby startles; a fast cursor heading straight at it makes it dodge; hovering never does', () => {
    expect(cursorReaction({ pet: box, cursor: { x: 560, y: 380 }, v: { x: 2, y: 0 }, hovering: false })).toBe('startle');
    expect(cursorReaction({ pet: box, cursor: { x: 300, y: 380 }, v: { x: 1.2, y: 0 }, hovering: false })).toBe('dodge');
    expect(cursorReaction({ pet: box, cursor: { x: 300, y: 380 }, v: { x: -1.2, y: 0 }, hovering: false })).toBeNull();
    expect(cursorReaction({ pet: box, cursor: { x: 300, y: 380 }, v: { x: 0.2, y: 0 }, hovering: false })).toBeNull();
    expect(cursorReaction({ pet: box, cursor: { x: 500, y: 380 }, v: { x: 3, y: 0 }, hovering: true })).toBeNull();
    expect(segmentHitsBox({ x: 0, y: 0 }, { x: 10, y: 10 }, { left: 4, top: 4, right: 6, bottom: 6 })).toBe(true);
    expect(segmentHitsBox({ x: 0, y: 0 }, { x: 10, y: 0 }, { left: 4, top: 4, right: 6, bottom: 6 })).toBe(false);
  });
  it('creeps toward a resting cursor, stopping short of it, within its stretch', () => {
    const mid = { x: 500, y: 380 };
    expect(creepTarget(500, mid, { x: 700, y: 380 }, 300, 900)).toBe(700 - MOUSE.creepStop);
    expect(creepTarget(500, mid, { x: 350, y: 380 }, 400, 900)).toBe(410);
    expect(creepTarget(500, mid, { x: 1200, y: 380 }, 300, 1300)).toBeNull();
    expect(creepTarget(500, mid, { x: 565, y: 380 }, 300, 900)).toBeNull();
  });
  it('faces the cursor with some hysteresis and leans toward it', () => {
    expect(faceToward(500, 600, -1)).toBe(1);
    expect(faceToward(500, 510, -1)).toBe(-1);
    expect(leanToward({ x: 500, y: 400 }, 40, { x: 600, y: 376 })).toBeGreaterThan(0);
    expect(leanToward({ x: 500, y: 400 }, 40, { x: 400, y: 376 })).toBeLessThan(0);
    expect(leanToward({ x: 500, y: 400 }, 40, { x: 1400, y: 376 })).toBe(0);
  });
  it('keeps off the line being edited', () => {
    const caret = { left: 380, right: 382, top: 384, bottom: 402 };
    expect(nearCaret(box, caret)).toBe(true);
    expect(nearCaret(box, { ...caret, top: 200, bottom: 218 })).toBe(false);
    expect(nearCaret(box, { ...caret, left: 100, right: 102 })).toBe(false);
    expect(caretBand(caret, { left: 250, right: 780, top: 82, bottom: 900 })).toEqual({ left: 250, right: 780, top: 378, bottom: 408 });
  });
  it('thinks of hops most often, never a walk without room; Playful rests less', () => {
    const counts: Record<string, number> = {};
    const rng = seeded(3);
    for (let i = 0; i < 1000; i++) {
      const t = nextThought(rng, { activity: 'calm', canWalk: false, canPeek: true });
      counts[t] = (counts[t] ?? 0) + 1;
    }
    expect(counts.walk ?? 0).toBe(0);
    expect(counts.hop).toBeGreaterThan(400);
    const r = seeded(4);
    for (let i = 0; i < 50; i++) {
      expect(restMs('playful', r)).toBeLessThanOrEqual(8000);
      expect(restMs('calm', r)).toBeGreaterThanOrEqual(9000);
    }
  });
  it('notices people who just arrived, not who was there or you in another tab', () => {
    const first = arrivals(null, [{ id: 'ada' }, { id: 'me', self: true }], 0);
    expect(first.fresh).toBe(0);
    const join = arrivals(first.next, [{ id: 'ada' }, { id: 'bob' }], 1000);
    expect(join.fresh).toBe(1);
    const left = arrivals(join.next, [{ id: 'ada' }], 2000);
    const back = arrivals(left.next, [{ id: 'ada' }, { id: 'bob' }], 3000);
    expect(back.fresh).toBe(0);
    const later = arrivals(left.next, [{ id: 'ada' }, { id: 'bob' }], 2000 + 600_000);
    expect(later.fresh).toBe(1);
  });
});
