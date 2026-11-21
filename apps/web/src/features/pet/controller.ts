/**
 * F14 desk pet: the runtime (WP44 pet-runtime; roaming pet: PET2). One
 * controller per editor page.
 *
 * The pet lives in a window-sized overlay (`position: fixed`, no pointer
 * events) and only its own body takes the pointer. It stands on surfaces it
 * measures from the page (engine/surfaces.ts): the free stretch of a header
 * bar, the top of the typeset bar under the editor, the top edge of a PDF
 * page, the white space at the end of a line of source, the bottom of the
 * window. It hops between them on ballistic arcs
 * (engine/moves.ts), scoots along them, and rides what it stands on: an
 * anchor keeps its offset from the element under it, re-read on every scroll
 * of that element's scroll box and on every resize, so a scrolled PDF page or
 * a dragged split pane carries it. A spot scrolled out of view: it clings to
 * the edge, then hops back into view.
 *
 * It reacts to the mouse (looks at it, startles at a flick, dodges a cursor
 * heading for what is under it, creeps toward a resting one, wiggles when
 * hovered, steps aside when hovered for long), to typing (settles, keeps off
 * the line being edited), to typesets, to people joining and to comments.
 * Left alone it naps. Clicking it squeaks (sound.ts); dragging it picks it
 * up, and it falls onto the surface below where it is dropped.
 *
 * Limits: animation frames run only while it moves; when still it keeps one
 * timer (Deadlines). A hidden tab finishes any motion at once and stops the
 * timers. Under reduced motion it sits on one perch and only squashes when
 * clicked. It never moves on its own while a mouse button is held elsewhere
 * or within a few seconds of a key. Nothing it does reaches Yjs, awareness,
 * the project or the server.
 */
import type { EditorView } from '@codemirror/view';
import { accountIdentity, localUser } from '../../api';
import { openMenu, type MenuEntry } from '../../components/Menu';
import { setSetting } from '../../settings/store';
import { safeStorage } from '../../util/safeStorage';
import type { EditorPageCtx } from '../types';
import { sendPetAway } from './away';
import type { PetShape } from './engine/asset';
import {
  MOUSE, TIMING, arrivals, caretBand, creepTarget, cursorReaction, faceToward, leanToward, nearCaret, nextThought, restMs, velocity,
  type CursorSample, type Roster,
} from './engine/mood';
import { effect, fallTime, fallY, hopPose, landSquash, planHop, planWalk, tuckOffset, walkPose, type Effect, type HopPlan, type WalkPlan } from './engine/moves';
import { PET_IDS, type PetPrefs, type PetSize } from './engine/prefs';
import {
  EDGE_PAD, clamp, clampToClip, clampToView, codeSurfaces, fits, floorSurface, petBox, pickSpot, standRange, surfaceBelow,
  type Box, type ClipEdge, type CodeLine, type Pt, type Size, type Spot, type Surface, type SurfaceKind, type View,
} from './engine/surfaces';
import { Deadlines, newFromOthers, rosterPeople } from './runtime';
import { Squeaker } from './sound';

export interface ControllerInput {
  page: EditorPageCtx | null;
  /** Turned on, not away, the image measured: the pet should be here. */
  active: boolean;
  prefs: PetPrefs;
  reduced: boolean;
  shape: PetShape | null;
  /** The recorded squeak, or null (synthesized). */
  squeakUrl: string | null;
  /** When it comes back from being away, or null. */
  awayUntil: number | null;
}

export interface ControllerHooks {
  /** The away time passed: the component re-reads it. */
  awayEnded(): void;
}

export interface PetEls {
  root: HTMLDivElement;
  pos: HTMLDivElement;
  shadow: HTMLDivElement;
  body: HTMLDivElement;
  lean: HTMLDivElement;
  squash: HTMLDivElement;
  fx: HTMLDivElement;
  img: HTMLDivElement;
  bubble: HTMLDivElement;
}

/** The pet's height in CSS pixels. */
export const PET_HEIGHTS: Record<PetSize, number> = { normal: 40, small: 30 };
const MIN_VIEWPORT = 720;
const FIRST_SHOW_DELAY_MS = 700;
const DRAG_START_PX = 5;
/** Test hook (e2e): localStorage['aldine.e2e.pet'] = '1' exposes window.__laytekzDeskPet. */
const HOOK_KEY = 'aldine.e2e.pet';

type Anchor =
  /** A bar: feet on its bottom line (a header's free stretch) or on its top edge (the bar under the editor). */
  | { kind: 'ledge'; id: string; el: HTMLElement; header: HTMLElement; border: number; top: boolean; dx: number }
  | { kind: 'page'; id: string; el: HTMLElement; scroller: HTMLElement; dx: number }
  | { kind: 'code'; id: string; view: EditorView; line: number; dx: number }
  | { kind: 'floor'; id: 'floor'; dx: number };

type Motion =
  | { kind: 'hop'; plan: HopPlan; start: number; target: Anchor; then?: () => void }
  | { kind: 'walk'; plan: WalkPlan; start: number; anchor: Anchor; dx: number }
  | { kind: 'fall'; y0: number; x: number; start: number; target: Anchor; landedAt: number | null }
  | { kind: 'tuck'; start: number; hide: number; peek: number; wait: number };

type State = 'off' | 'idle' | 'hop' | 'walk' | 'fall' | 'drag' | 'nap' | 'cling' | 'tuck';
type Bubble = '!' | 'z' | 'heart' | '…';

/** Every idle timer (not 'away', which outlives the pet's visits). */
const IDLE_KEYS = ['show', 'think', 'rest', 'nap', 'zzz', 'cling', 'hover', 'caret', 'look', 'lookEnd', 'squeakHop', 'gone'] as const;

const HEART = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 14.2 6.9 13.2C3 9.7.5 7.4.5 4.6.5 2.3 2.3.5 4.6.5c1.3 0 2.6.6 3.4 1.6.8-1 2.1-1.6 3.4-1.6 2.3 0 4.1 1.8 4.1 4.1 0 2.8-2.5 5.1-6.4 8.6L8 14.2z"/></svg>';

const r2 = (n: number) => Math.round(n * 100) / 100;

function clientBox(el: Element): Box {
  const r = el.getBoundingClientRect();
  const left = r.left + el.clientLeft;
  const top = r.top + el.clientTop;
  return { left, top, right: left + (el.clientWidth || r.width), bottom: top + (el.clientHeight || r.height) };
}

/** The visible lines of a CodeMirror view, with where each one's text ends. One batch of layout reads. */
function readLines(v: EditorView): { lines: CodeLine[]; clip: Box; contentLeft: number; contentRight: number } {
  const clip = clientBox(v.scrollDOM);
  const content = v.contentDOM.getBoundingClientRect();
  const top = v.documentTop;
  const lh = v.defaultLineHeight || 18;
  const lines: CodeLine[] = [];
  for (const b of v.viewportLineBlocks) {
    const y0 = top + b.top;
    const y1 = top + b.bottom;
    if (y1 < clip.top - lh || y0 > clip.bottom) continue;
    let endX = content.left;
    if (b.height > lh * 1.6) endX = content.right;
    else if (b.to > b.from) endX = v.coordsAtPos(b.to, -1)?.right ?? content.right;
    lines.push({ line: v.state.doc.lineAt(b.from).number, top: y0, bottom: y1, endX });
  }
  return { lines, clip, contentLeft: content.left, contentRight: content.right };
}

export class PetController {
  private input: ControllerInput;
  private els: PetEls | null = null;
  private readonly timers = new Deadlines({ set: (fn, ms) => window.setTimeout(fn, ms), clear: (h) => window.clearTimeout(h as number) });
  private readonly squeaker = new Squeaker();
  private readonly rng = Math.random;
  private shown = false;
  private firstShow = true;
  private state: State = 'off';
  private size: Size = { w: 43, h: PET_HEIGHTS.normal };
  /** The feet, viewport pixels. */
  private at: Pt = { x: 0, y: 0 };
  /** Extra downward offset while peeking from behind an edge. */
  private tuckY = 0;
  private anchor: Anchor | null = null;
  private refs = new Map<string, (x: number) => Anchor>();
  private motion: Motion | null = null;
  private frame = 0;
  private face: 1 | -1 = 1;
  private lean = 0;
  private fxAnim: Animation | null = null;
  private bubbleAnim: Animation | null = null;
  private ro: ResizeObserver | null = null;
  private observed: Element[] = [];
  private listening = false;
  private offs: (() => void)[] = [];
  private pageOffs: (() => void)[] = [];
  private boundPage: EditorPageCtx | null = null;
  private samples: CursorSample[] = [];
  private cursor: Pt | null = null;
  private restAt = 0;
  private hovering = false;
  private press: { id: number; x0: number; y0: number; gx: number; gy: number; dragging: boolean; vx: number; lx: number; lt: number } | null = null;
  /** A mouse button is held somewhere else (a text selection, a drag, a scrollbar). */
  private held = false;
  private lastKeyAt = 0;
  private lastInputAt = Date.now();
  private napRefreshedAt = 0;
  private lastFleeAt = 0;
  private lastLookAt = 0;
  private lookUntil = 0;
  private lastOk: boolean | null = null;
  private roster: Roster | null = null;
  private rosterQuietUntil = 0;
  private seenComments: Set<string> | null = null;
  private squeaks = 0;
  private frozen = false;
  /** Test hook only: motions run this many times slower. */
  private timeScale = 1;
  private disposed = false;

  constructor(input: ControllerInput, private readonly hooks: ControllerHooks) {
    this.input = input;
  }

  // ---- lifecycle ----

  attach(els: PetEls): void {
    this.els = els;
    const b = els.body;
    b.addEventListener('pointerdown', this.onBodyDown);
    b.addEventListener('pointermove', this.onBodyMove);
    b.addEventListener('pointerup', this.onBodyUp);
    b.addEventListener('pointercancel', this.onBodyCancel);
    b.addEventListener('lostpointercapture', this.onBodyCancel);
    b.addEventListener('pointerenter', this.onEnter);
    b.addEventListener('pointerleave', this.onLeave);
    b.addEventListener('contextmenu', this.onMenu);
    if (typeof ResizeObserver !== 'undefined') this.ro = new ResizeObserver(() => this.ride());
    window.addEventListener('resize', this.onResize);
    this.installHook();
    this.update(this.input, true);
  }

  dispose(): void {
    this.disposed = true;
    this.timers.stop();
    this.stopMotion();
    this.stopListening();
    this.ro?.disconnect();
    this.ro = null;
    window.removeEventListener('resize', this.onResize);
    const b = this.els?.body;
    if (b) {
      b.removeEventListener('pointerdown', this.onBodyDown);
      b.removeEventListener('pointermove', this.onBodyMove);
      b.removeEventListener('pointerup', this.onBodyUp);
      b.removeEventListener('pointercancel', this.onBodyCancel);
      b.removeEventListener('lostpointercapture', this.onBodyCancel);
      b.removeEventListener('pointerenter', this.onEnter);
      b.removeEventListener('pointerleave', this.onLeave);
      b.removeEventListener('contextmenu', this.onMenu);
    }
    this.fxAnim?.cancel();
    this.bubbleAnim?.cancel();
    this.squeaker.dispose();
    const w = window as unknown as { __laytekzDeskPet?: unknown };
    if (w.__laytekzDeskPet && (w.__laytekzDeskPet as { owner?: unknown }).owner === this) delete w.__laytekzDeskPet;
  }

  /** Every render of the component. Cheap: compares inputs, measures nothing unless something changed. */
  update(next: ControllerInput, force = false): void {
    if (this.disposed) return;
    const prev = this.input;
    this.input = next;
    this.timers.set('away', next.awayUntil, () => this.hooks.awayEnded());
    this.squeaker.setUrl(next.squeakUrl);
    if (force || next.shape !== prev.shape || next.prefs.size !== prev.prefs.size) this.applySize();
    if (next.page !== this.boundPage && this.listening) this.bindPage(next.page);
    if (this.els) this.els.root.dataset.reduced = String(next.reduced);
    const want = next.active && this.allowed();
    if (!want) {
      this.timers.clear('show');
      if (this.shown) this.leave();
      return;
    }
    if (!this.shown && !this.timers.has('show')) this.timers.set('show', Date.now() + (this.firstShow ? FIRST_SHOW_DELAY_MS : 0), () => this.show());
    if (!this.shown) return;
    if (next.reduced !== prev.reduced) this.reducedChanged();
    if (next.prefs.activity !== prev.prefs.activity) this.scheduleThought();
    if (next.prefs.reactions.doze !== prev.prefs.reactions.doze) this.refreshNap(true);
  }

  // ---- showing and leaving ----

  /** A fine pointer and a window wide enough: phones and tablets get no pet. */
  private allowed(): boolean {
    if (typeof window === 'undefined') return false;
    if (window.innerWidth < MIN_VIEWPORT) return false;
    return !!window.matchMedia?.('(pointer: fine)').matches;
  }

  private unseen(): boolean {
    return document.visibilityState === 'hidden' || !!this.els?.root.closest('[inert]');
  }

  private show(): void {
    const els = this.els;
    if (this.shown || !els || !this.input.active) return;
    if (this.unseen()) { this.timers.set('show', Date.now() + 1000, () => this.show()); return; }
    const spot = this.homeSpot(this.collect());
    if (!spot) { this.timers.set('show', Date.now() + 1000, () => this.show()); return; }
    this.shown = true;
    this.firstShow = false;
    this.timers.clear('gone');
    els.root.style.display = '';
    els.root.classList.remove('desk-pet--leaving');
    this.startListening();
    this.squeaker.prefetch();
    this.lastInputAt = Date.now();
    this.tuckY = 0;
    if (this.input.reduced) {
      els.root.classList.add('desk-pet--appear');
      this.settle(spot);
    } else {
      // It drops in from the top of the window.
      this.anchor = null;
      this.at = { x: spot.x, y: -8 };
      this.write();
      this.fallTo(spot);
    }
    this.refreshNap(true);
  }

  private leave(): void {
    const els = this.els;
    this.shown = false;
    this.stopMotion();
    for (const k of IDLE_KEYS) this.timers.clear(k);
    this.stopListening();
    this.observe([]);
    this.anchor = null;
    this.hovering = false;
    this.press = null;
    this.setState('off');
    if (!els) return;
    els.root.classList.remove('desk-pet--appear', 'desk-pet--nap', 'desk-pet--held', 'desk-pet--moving');
    els.root.classList.add('desk-pet--leaving');
    this.timers.set('gone', Date.now() + 260, () => {
      if (this.shown) return;
      els.root.style.display = 'none';
      els.root.classList.remove('desk-pet--leaving');
    });
  }

  private reducedChanged(): void {
    this.finishMotion();
    this.fxAnim?.finish();
    if (this.input.reduced) {
      this.timers.clear('think');
      this.timers.clear('nap');
      this.wake(true);
      const spot = this.homeSpot(this.collect());
      if (spot) this.settle(spot);
    } else {
      this.scheduleThought();
      this.refreshNap(true);
    }
  }

  private applySize(): void {
    const { shape, prefs } = this.input;
    const want = PET_HEIGHTS[prefs.size];
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const h = shape && shape.naturalHeight > 0 ? Math.min(want, Math.floor(shape.naturalHeight / Math.max(1, dpr)) || want) : want;
    const w = Math.round(h * (shape?.aspect || 1));
    this.size = { w, h };
    const e = this.els;
    if (!e) return;
    Object.assign(e.body.style, { width: `${w}px`, height: `${h}px`, left: `${-w / 2}px`, top: `${-h}px` });
    e.shadow.style.width = `${Math.round(w * 0.8)}px`;
    e.bubble.style.bottom = `${h + 4}px`;
    if (this.shown) this.ride();
  }

  // ---- surfaces ----

  private view(): View {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  /** Every surface on the page now, in one batch of layout reads; remembers how to anchor to each. */
  private collect(): Surface[] {
    const out: Surface[] = [];
    const refs = new Map<string, (x: number) => Anchor>();
    const pet = this.size;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-perch]'))) {
      if (el.closest('.desk-pet, .pane--away, [hidden], .sidebar--hidden')) continue;
      const header = el.parentElement;
      if (!header) continue;
      const s = el.getBoundingClientRect();
      if (s.width <= 0) continue;
      const hb = header.getBoundingClientRect();
      const border = parseFloat(getComputedStyle(header).borderBottomWidth) || 0;
      const id = `ledge:${el.dataset.perch}`;
      out.push({ id, kind: 'ledge', left: s.left, right: s.right, y: hb.bottom - border, clip: null });
      refs.set(id, (x) => ({ kind: 'ledge', id, el, header, border, top: false, dx: x - s.left }));
    }
    // The typeset and problems bar under the editor: it stands on its top edge.
    const bar = document.querySelector<HTMLElement>('.pane--editor [data-testid="typeset-bar"], .pane--editor [data-testid="errors-panel"]');
    if (bar && !bar.closest('.pane--away, [hidden]')) {
      const r = bar.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const id = 'ledge:status';
        out.push({ id, kind: 'ledge', left: r.left, right: r.right, y: r.top, clip: null });
        refs.set(id, (x) => ({ kind: 'ledge', id, el: bar, header: bar, border: 0, top: true, dx: x - r.left }));
      }
    }
    const pane = document.querySelector<HTMLElement>('[data-testid="pdf-pane"]');
    if (pane && !pane.closest('.pane--away, [hidden]')) {
      const clip = clientBox(pane);
      if (clip.bottom - clip.top > pet.h * 2) {
        for (const c of Array.from(pane.querySelectorAll<HTMLElement>('canvas.pdf-page'))) {
          const r = c.getBoundingClientRect();
          if (!r.width || r.bottom < clip.top || r.top > clip.bottom) continue;
          const id = `page:${c.dataset.page ?? out.length}`;
          out.push({ id, kind: 'page', left: r.left + 8, right: r.right - 8, y: r.top, clip });
          refs.set(id, (x) => ({ kind: 'page', id, el: c, scroller: pane, dx: x - r.left }));
        }
      }
    }
    const v = this.input.page?.view() ?? null;
    if (v && v.dom.isConnected && !v.dom.closest('.pane--away, [hidden]')) {
      try {
        const { lines, clip, contentLeft, contentRight } = readLines(v);
        for (const s of codeSurfaces(lines, { contentLeft, contentRight, clip, pet })) {
          const line = Number(s.id.slice(5));
          out.push(s);
          refs.set(s.id, (x) => ({ kind: 'code', id: s.id, view: v, line, dx: x - contentLeft }));
        }
      } catch { /* the view is between documents: no code perches this time */ }
    }
    out.push(floorSurface(this.view()));
    refs.set('floor', (x) => ({ kind: 'floor', id: 'floor', dx: x }));
    this.refs = refs;
    return out;
  }

  private anchorFor(spot: Spot): Anchor | null {
    return this.refs.get(spot.surface.id)?.(spot.x) ?? null;
  }

  /** Where the pet sits when it arrives and under reduced motion: the editor bar, else the PDF bar, the files bar, anywhere, the floor. */
  private homeSpot(surfaces: Surface[]): Spot | null {
    const view = this.view();
    for (const id of ['ledge:editor', 'ledge:preview', 'ledge:files']) {
      const s = surfaces.find((x) => x.id === id);
      if (!s || !fits(s, this.size, view)) continue;
      const [lo, hi] = standRange(s, this.size, view);
      const x = id === 'ledge:editor' ? Math.min(hi, lo + 16) : Math.max(lo, hi - 12);
      return { surface: s, x, y: s.y };
    }
    return pickSpot(surfaces.filter((s) => s.kind !== 'floor'), { from: this.at, currentId: null, pet: this.size, view, rng: this.rng })
      ?? surfaceBelow(surfaces, { x: view.width / 2, y: view.height }, this.size, view);
  }

  private currentSurface(surfaces: Surface[]): Surface | null {
    const id = this.anchor?.id;
    return id ? surfaces.find((s) => s.id === id) ?? null : null;
  }

  /** The anchor's point now, and the box it must stay in; null when the thing under the pet is gone. */
  private resolve(a: Anchor): { at: Pt; clip: Box | null } | null {
    const pet = this.size;
    switch (a.kind) {
      case 'ledge': {
        if (!a.el.isConnected) return null;
        const s = a.el.getBoundingClientRect();
        if (s.width < pet.w + 2 * EDGE_PAD) return null;
        const h = a.top ? s : a.header.getBoundingClientRect();
        return { at: { x: s.left + clamp(a.dx, pet.w / 2 + EDGE_PAD, s.width - pet.w / 2 - EDGE_PAD), y: a.top ? h.top : h.bottom - a.border }, clip: null };
      }
      case 'page': {
        if (!a.el.isConnected) return null;
        const r = a.el.getBoundingClientRect();
        if (!r.width) return null;
        return { at: { x: r.left + a.dx, y: r.top }, clip: clientBox(a.scroller) };
      }
      case 'code': {
        const v = a.view;
        if (!v.dom.isConnected) return null;
        const doc = v.state.doc;
        const block = v.lineBlockAt(doc.line(Math.min(Math.max(1, a.line), doc.lines)).from);
        const c = v.contentDOM.getBoundingClientRect();
        if (!c.width) return null;
        return { at: { x: c.left + a.dx, y: v.documentTop + block.bottom }, clip: clientBox(v.scrollDOM) };
      }
      case 'floor':
        return { at: { x: clamp(a.dx, pet.w / 2, window.innerWidth - pet.w / 2), y: window.innerHeight }, clip: null };
    }
  }

  private refOf(a: Anchor): Element | null {
    switch (a.kind) {
      case 'ledge': return a.el;
      case 'page': return a.el;
      case 'code': return a.view.contentDOM;
      case 'floor': return null;
    }
  }

  private observe(els: Element[]): void {
    if (!this.ro) return;
    if (els.length === this.observed.length && els.every((e, i) => e === this.observed[i])) return;
    this.ro.disconnect();
    for (const e of els) this.ro.observe(e);
    this.observed = els;
  }

  private observeAnchor(): void {
    const a = this.anchor;
    if (!a) { this.observe([]); return; }
    switch (a.kind) {
      case 'ledge': this.observe([a.el, a.header]); break;
      case 'page': this.observe([a.el, a.scroller]); break;
      case 'code': this.observe([a.view.scrollDOM, a.view.contentDOM]); break;
      case 'floor': this.observe([]); break;
    }
  }

  /** Stand on a spot now, without moving there. */
  private settle(spot: Spot): void {
    const a = this.anchorFor(spot);
    this.anchor = a;
    this.at = { x: spot.x, y: spot.y };
    this.setState('idle');
    this.writeSquash(1, 1, 0);
    this.writeShadow(0);
    this.observeAnchor();
    this.ride();
    this.scheduleThought();
  }

  // ---- riding ----

  /** Puts the pet where its anchor is now. Called on scroll, resize and layout changes; one read, one write. */
  private ride(): void {
    if (!this.shown || !this.anchor || this.motion || this.press?.dragging) return;
    const r = this.resolve(this.anchor);
    if (!r) { this.lostFooting(); return; }
    const { at, out } = clampToClip(r.at, r.clip, this.size);
    this.at = clampToView(at, this.size, this.view());
    this.write();
    if (out) this.cling(out);
    else if (this.state === 'cling') {
      this.timers.clear('cling');
      this.setState('idle');
      this.writeSquash(1, 1, 0);
      this.scheduleThought();
    }
  }

  private onScroll = (e: Event) => {
    const a = this.anchor;
    if (!a || this.motion || this.press?.dragging) return;
    const ref = this.refOf(a);
    const t = e.target;
    if (ref && (t === document || (t instanceof Node && t.contains(ref)))) this.ride();
  };

  private onResize = () => {
    if (!this.allowed()) { if (this.shown) this.leave(); return; }
    if (!this.shown) { this.update(this.input); return; }
    this.ride();
  };

  private cling(edge: ClipEdge): void {
    if (this.state !== 'cling') {
      this.setState('cling');
      this.writeSquash(0.92, 1.1, edge === 'left' ? -6 : edge === 'right' ? 6 : 0);
    }
    if (!this.timers.has('cling')) this.timers.set('cling', Date.now() + TIMING.clingMs, () => this.unCling());
  }

  private unCling(): void {
    if (this.state !== 'cling' || !this.anchor) return;
    if (this.held || this.motion) { this.timers.set('cling', Date.now() + 300, () => this.unCling()); return; }
    const surfaces = this.collect();
    if (this.input.reduced) { const home = this.homeSpot(surfaces); if (home) this.settle(home); return; }
    const kind = this.anchor.kind;
    const ctx = { from: this.at, currentId: null, pet: this.size, view: this.view(), rng: this.rng, avoid: this.avoidBoxes() };
    const spot = pickSpot(surfaces, { ...ctx, kinds: [kind] }) ?? pickSpot(surfaces, ctx) ?? this.homeSpot(surfaces);
    if (spot) this.hopTo(spot, { quick: true });
  }

  /** The thing under the pet went away (a new PDF, a hidden pane, another file): it falls. */
  private lostFooting(): void {
    this.anchor = null;
    this.observe([]);
    const surfaces = this.collect();
    if (this.input.reduced) {
      const home = this.homeSpot(surfaces);
      if (home) this.settle(home);
      return;
    }
    this.fallTo(surfaceBelow(surfaces, this.at, this.size, this.view()));
  }

  // ---- motion ----

  private startMotion(m: Motion): void {
    this.motion = m;
    this.timers.clear('think');
    this.timers.clear('cling');
    this.setState(m.kind);
    this.els?.root.classList.add('desk-pet--moving');
    if (document.visibilityState === 'hidden') { this.finishMotion(); return; }
    if (!this.frame) this.frame = requestAnimationFrame(this.loop);
  }

  private loop = (now: number) => {
    this.frame = 0;
    const m = this.motion;
    if (!m || this.disposed) return;
    let done = false;
    try { done = this.step(m, now); } catch (err) { console.warn('[laytekz] desk pet motion failed', err); done = true; }
    if (done && this.motion === m) { this.motion = null; this.arrive(m); }
    if (this.motion && !this.frame) this.frame = requestAnimationFrame(this.loop);
  };

  /** One frame of a motion; true when it is over. Reads the target's live position (riding mid-air). */
  private step(m: Motion, now: number): boolean {
    const elapsed = Math.max(0, now - m.start) / this.timeScale;
    switch (m.kind) {
      case 'hop': {
        const live = this.resolve(m.target);
        const to = live ? clampToClip(live.at, live.clip, this.size).at : m.plan.to;
        const p = hopPose(m.plan, elapsed, to);
        this.at = { x: p.x, y: p.y };
        this.write();
        this.writeSquash(p.sx, p.sy, p.rot);
        this.writeShadow(p.ground - p.y);
        return p.phase === 'done';
      }
      case 'walk': {
        const w = walkPose(m.plan, elapsed);
        m.dx = w.x;
        const r = this.resolve({ ...m.anchor, dx: w.x } as Anchor);
        if (!r) return true;
        const at = clampToClip(r.at, r.clip, this.size).at;
        this.at = { x: at.x, y: at.y - w.bob };
        this.write();
        this.writeSquash(w.sx, w.sy, w.rot);
        this.writeShadow(w.bob);
        return w.done;
      }
      case 'fall': {
        const live = this.resolve(m.target);
        const to = live ? clampToClip(live.at, live.clip, this.size).at : { x: m.x, y: window.innerHeight };
        if (m.landedAt === null) {
          const f = fallY(m.y0, elapsed, to.y);
          const k = Math.min(1, elapsed / Math.max(1, fallTime(m.y0, to.y)));
          this.at = { x: m.x + (to.x - m.x) * k, y: f.y };
          this.write();
          const stretch = Math.min(0.14, elapsed / 2500);
          this.writeSquash(1 - stretch * 0.6, 1 + stretch, 0);
          this.writeShadow(to.y - f.y);
          if (f.landed) m.landedAt = now;
          return false;
        }
        const t = (now - m.landedAt) / this.timeScale / 280;
        const sq = landSquash(Math.min(1, t));
        this.at = to;
        this.write();
        this.writeSquash(sq.sx, sq.sy, 0);
        this.writeShadow(0);
        return t >= 1;
      }
      case 'tuck': {
        const off = tuckOffset(elapsed, m.hide, m.peek, m.wait);
        this.tuckY = off ?? 0;
        this.write();
        return off === null;
      }
    }
  }

  private arrive(m: Motion): void {
    this.els?.root.classList.remove('desk-pet--moving');
    this.writeSquash(1, 1, 0);
    this.writeShadow(0);
    if (m.kind === 'hop' || m.kind === 'fall') this.anchor = m.target;
    else if (m.kind === 'walk') this.anchor = { ...m.anchor, dx: m.dx } as Anchor;
    else this.tuckY = 0;
    this.setState('idle');
    this.observeAnchor();
    this.ride();
    if (m.kind === 'hop' && m.then && this.shown) m.then();
    if (!this.motion && this.state === 'idle') this.scheduleThought();
  }

  /** Ends the motion at its end pose at once (a hidden tab, reduced motion switched on). */
  private finishMotion(): void {
    const m = this.motion;
    if (!m) return;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.motion = null;
    if (m.kind === 'walk') m.dx = m.plan.to;
    this.arrive(m);
    if (this.motion) this.finishMotion();
  }

  /** Drops the motion where it is (picked up mid-hop). */
  private stopMotion(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.motion = null;
    this.tuckY = 0;
    this.els?.root.classList.remove('desk-pet--moving');
  }

  private hopTo(spot: Spot, o: { height?: number; quick?: boolean; spin?: boolean; then?: () => void } = {}): boolean {
    const target = this.anchorFor(spot);
    if (!target) return false;
    const plan = planHop(this.at, { x: spot.x, y: spot.y }, { ...o, ceiling: this.size.h + 6 });
    if (Math.abs(spot.x - this.at.x) > 4) this.setFace(plan.dir);
    this.anchor = null;
    this.startMotion({ kind: 'hop', plan, start: performance.now(), target, then: o.then });
    return true;
  }

  private hopInPlace(o: { height: number; quick?: boolean; spin?: boolean }): void {
    const target = this.anchor;
    if (!target || this.motion) return;
    const plan = planHop(this.at, this.at, { ...o, ceiling: this.size.h + 6 });
    if (o.spin) plan.dir = this.face;
    this.anchor = null;
    this.startMotion({ kind: 'hop', plan, start: performance.now(), target });
  }

  private walkTo(x: number, speed?: number): boolean {
    const a = this.anchor;
    if (!a || this.motion) return false;
    const plan = planWalk(a.dx, a.dx + (x - this.at.x), speed);
    this.setFace(plan.dir);
    this.startMotion({ kind: 'walk', plan, start: performance.now(), anchor: a, dx: a.dx });
    return true;
  }

  private fallTo(spot: Spot): void {
    const target = this.anchorFor(spot);
    if (!target) return;
    this.anchor = null;
    this.startMotion({ kind: 'fall', y0: this.at.y, x: this.at.x, start: performance.now(), target, landedAt: null });
  }

  private hopSomewhere(surfaces: Surface[], o: { fleeFrom?: Pt | null; quick?: boolean } = {}): boolean {
    const spot = pickSpot(surfaces, {
      from: this.at, currentId: this.anchor?.id ?? null, pet: this.size, view: this.view(), rng: this.rng,
      avoid: this.avoidBoxes(), fleeFrom: o.fleeFrom ?? null,
    });
    return !!spot && this.hopTo(spot, { quick: o.quick });
  }

  /** Peeks out from below the window's bottom edge: hops down there first when it is elsewhere. */
  private peek(surfaces: Surface[]): void {
    const tuck = () => this.startMotion({ kind: 'tuck', start: performance.now(), hide: this.size.h * 1.05, peek: this.size.h * 0.42, wait: 1500 + this.rng() * 2000 });
    if (this.anchor?.kind === 'floor') { tuck(); return; }
    const floor = surfaces.find((s) => s.kind === 'floor');
    if (!floor) return;
    const [lo, hi] = standRange(floor, this.size, this.view());
    const x = clamp(this.at.x + (this.rng() - 0.5) * 500, lo, hi);
    this.hopTo({ surface: floor, x, y: floor.y }, { then: tuck });
  }

  // ---- thinking ----

  private scheduleThought(ms?: number): void {
    if (!this.shown || this.input.reduced) { this.timers.clear('think'); return; }
    this.timers.set('think', Date.now() + (ms ?? restMs(this.input.prefs.activity, this.rng)), () => this.think());
  }

  /** May it do something on its own now? */
  private canAct(): boolean {
    return this.shown && !this.input.reduced && !this.frozen && !this.motion && !this.press && !this.held
      && this.state !== 'nap' && !this.unseen() && Date.now() - this.lastKeyAt > TIMING.typingQuietMs;
  }

  /** May it react to something (a typeset, a joiner) with a little motion now? */
  private canReact(): boolean {
    return this.shown && !this.input.reduced && !this.frozen && !this.motion && !this.press && !!this.anchor && !this.unseen()
      && Date.now() - this.lastKeyAt > 1200;
  }

  private think(): void {
    if (!this.canAct()) { this.scheduleThought(this.unseen() ? 5000 : 1500); return; }
    const surfaces = this.collect();
    const cur = this.currentSurface(surfaces);
    const range = cur ? standRange(cur, this.size, this.view()) : null;
    const canWalk = !!range && range[1] - range[0] > 90;
    const t = nextThought(this.rng, { activity: this.input.prefs.activity, canWalk, canPeek: true });
    switch (t) {
      case 'hop':
        if (!this.hopSomewhere(surfaces)) { this.lookAround(); }
        break;
      case 'walk': {
        const [lo, hi] = range!;
        let x = lo + (hi - lo) * this.rng();
        if (Math.abs(x - this.at.x) < 60) x = this.at.x < (lo + hi) / 2 ? hi : lo;
        if (!this.walkTo(x)) this.scheduleThought();
        break;
      }
      case 'look':
        this.lookAround();
        break;
      case 'fidget':
        this.play(this.rng() < 0.5 ? 'wiggle' : 'perk');
        this.scheduleThought();
        break;
      case 'peek':
        this.peek(surfaces);
        break;
    }
  }

  private lookAround(): void {
    const first: 1 | -1 = this.rng() < 0.5 ? 1 : -1;
    this.setFace(first);
    this.setLean(first * 6);
    this.timers.set('look', Date.now() + 900, () => {
      this.setFace(first === 1 ? -1 : 1);
      this.setLean(-first * 6);
      this.timers.set('look', Date.now() + 900, () => { this.setLean(0); this.scheduleThought(); });
    });
  }

  /** While you type: boxes to keep clear of (the caret's line). */
  private avoidBoxes(): Box[] {
    if (Date.now() - this.lastKeyAt > 15_000) return [];
    const c = this.caret();
    return c ? [caretBand(c.caret, c.editor)] : [];
  }

  private caret(): { caret: Box; editor: Box } | null {
    try {
      const v = this.input.page?.view();
      if (!v || !v.hasFocus) return null;
      const c = v.coordsAtPos(v.state.selection.main.head);
      if (!c) return null;
      return { caret: { left: c.left, right: c.right + 2, top: c.top, bottom: c.bottom }, editor: clientBox(v.scrollDOM) };
    } catch {
      return null;
    }
  }

  private checkCaret(): void {
    if (!this.shown || this.motion || this.press || this.frozen) return;
    const c = this.caret();
    if (!c || !nearCaret(this.box(), c.caret)) return;
    const surfaces = this.collect();
    if (this.input.reduced) { const home = this.homeSpot(surfaces); if (home) this.settle(home); return; }
    const avoid = [caretBand(c.caret, c.editor)];
    const ctx = { from: this.at, currentId: this.anchor?.id ?? null, pet: this.size, view: this.view(), rng: this.rng, avoid };
    const spot = pickSpot(surfaces, { ...ctx, kinds: ['ledge', 'page'] }) ?? pickSpot(surfaces, ctx);
    if (spot) this.hopTo(spot, { quick: true });
  }

  // ---- napping ----

  private refreshNap(force = false): void {
    if (!this.shown || !this.input.prefs.reactions.doze || this.input.reduced) { this.timers.clear('nap'); return; }
    const now = Date.now();
    if (!force && now - this.napRefreshedAt < 5000) return;
    this.napRefreshedAt = now;
    this.timers.set('nap', this.lastInputAt + TIMING.napAfterMs[this.input.prefs.activity], () => this.nap());
  }

  private nap(): void {
    if (!this.shown || this.state === 'nap') return;
    if (this.motion || this.press || this.held || this.unseen()) { this.timers.set('nap', Date.now() + 5000, () => this.nap()); return; }
    this.timers.clear('think');
    this.setState('nap');
    this.setLean(0);
    this.els?.root.classList.add('desk-pet--nap');
    this.zzz();
  }

  private zzz = () => {
    if (this.state !== 'nap') return;
    this.bubble('z');
    this.timers.set('zzz', Date.now() + 2600, this.zzz);
  };

  private wake(quiet = false): void {
    if (this.state !== 'nap') return;
    this.els?.root.classList.remove('desk-pet--nap');
    this.timers.clear('zzz');
    this.setState('idle');
    if (!quiet) { this.play('stretch'); this.scheduleThought(1800); }
  }

  /** Any pointer or key: not idle; wakes a napping pet. */
  private noteInput(): void {
    this.lastInputAt = Date.now();
    if (this.state === 'nap') this.wake();
    this.refreshNap();
  }

  // ---- the mouse ----

  private box(): Box {
    return petBox(this.at, this.size);
  }

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const now = performance.now();
    this.cursor = { x: e.clientX, y: e.clientY };
    this.samples.push({ x: e.clientX, y: e.clientY, t: now });
    if (this.samples.length > 8) this.samples.shift();
    this.noteInput();
    if (!this.shown || this.press) return;
    this.restAt = Date.now() + MOUSE.creepRestMs;
    if (!this.timers.has('rest')) this.timers.set('rest', this.restAt, this.onRest);
    if (now - this.lastLookAt > 60) { this.lastLookAt = now; this.lookAtCursor(); }
    if (this.canAct() && Date.now() - this.lastFleeAt > TIMING.fleeCooldownMs) {
      const r = cursorReaction({ pet: this.box(), cursor: this.cursor, v: velocity(this.samples, now), hovering: this.hovering });
      if (r) this.flee(r);
    }
  };

  private onPointerDown = (e: PointerEvent) => {
    this.noteInput();
    const body = this.els?.body;
    if (body && e.target instanceof Node && body.contains(e.target)) return;
    this.held = true;
  };

  private onPointerUp = () => {
    this.held = false;
  };

  private onBlur = () => {
    this.held = false;
  };

  /** The cursor has rested: a curious pet creeps toward it along its surface. */
  private onRest = () => {
    if (Date.now() < this.restAt - 5) { this.timers.set('rest', this.restAt, this.onRest); return; }
    if (!this.cursor || !this.canAct() || this.hovering) return;
    const cur = this.currentSurface(this.collect());
    if (!cur) return;
    const [lo, hi] = standRange(cur, this.size, this.view());
    const mid = { x: this.at.x, y: this.at.y - this.size.h / 2 };
    const x = creepTarget(this.at.x, mid, this.cursor, lo, hi);
    if (x !== null) this.walkTo(x, 0.06);
  };

  private lookAtCursor(): void {
    if (!this.cursor || this.motion || this.input.reduced || performance.now() < this.lookUntil || this.state === 'nap') return;
    this.setFace(faceToward(this.at.x, this.cursor.x, this.face));
    this.setLean(leanToward(this.at, this.size.h, this.cursor));
  }

  private flee(kind: 'startle' | 'dodge'): void {
    this.lastFleeAt = Date.now();
    const cursor = this.cursor;
    const surfaces = this.collect();
    if (kind === 'startle') {
      this.bubble('!');
      if (!this.hopSomewhere(surfaces, { fleeFrom: cursor, quick: true })) this.hopInPlace({ height: 26, quick: true });
      return;
    }
    // A dodge: a quick low hop sideways, away from the cursor, on the same surface when it has room.
    const cur = this.currentSurface(surfaces);
    if (cur && cursor) {
      const [lo, hi] = standRange(cur, this.size, this.view());
      const side = cursor.x > this.at.x ? -1 : 1;
      const x = clamp(this.at.x + side * this.size.w * 1.8, lo, hi);
      if (Math.abs(x - this.at.x) > this.size.w * 0.8) { this.hopTo({ surface: cur, x, y: cur.y }, { height: 18, quick: true }); return; }
    }
    this.hopSomewhere(surfaces, { fleeFrom: cursor, quick: true });
  }

  private onEnter = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || this.press) return;
    this.hovering = true;
    if (!this.motion && this.state !== 'nap') this.play('wiggle');
    this.timers.set('hover', Date.now() + MOUSE.hoverAsideMs, () => this.stepAside());
  };

  private onLeave = () => {
    this.hovering = false;
    this.timers.clear('hover');
  };

  /** Hovered for a while without a click: you probably want what is under it. */
  private stepAside(): void {
    if (!this.hovering || this.press || this.motion || this.frozen || !this.shown || this.input.reduced) return;
    this.hovering = false;
    this.flee('dodge');
  }

  // ---- click, drag and drop ----

  private onBodyDown = (e: PointerEvent) => {
    if (e.button !== 0 || !this.shown || !this.els) return;
    e.preventDefault(); // no text selection or native drag behind it
    try { this.els.body.setPointerCapture(e.pointerId); } catch { /* an old browser: window events still arrive */ }
    this.press = { id: e.pointerId, x0: e.clientX, y0: e.clientY, gx: this.at.x - e.clientX, gy: this.at.y - e.clientY, dragging: false, vx: 0, lx: e.clientX, lt: performance.now() };
    this.timers.clear('hover');
  };

  private onBodyMove = (e: PointerEvent) => {
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    if (!p.dragging) {
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < DRAG_START_PX) return;
      p.dragging = true;
      this.startDrag();
    }
    const now = performance.now();
    const dt = Math.max(1, now - p.lt);
    p.vx = p.vx * 0.7 + ((e.clientX - p.lx) / dt) * 0.3;
    p.lx = e.clientX;
    p.lt = now;
    this.at = clampToView({ x: e.clientX + p.gx, y: e.clientY + p.gy }, this.size, this.view());
    this.write();
    if (!this.input.reduced) this.writeSquash(0.94, 1.08, clamp(-p.vx * 16, -28, 28));
  };

  private onBodyUp = (e: PointerEvent) => {
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    this.press = null;
    try { this.els?.body.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (p.dragging) this.drop();
    else this.squeakClick();
  };

  private onBodyCancel = () => {
    const p = this.press;
    if (!p) return;
    this.press = null;
    if (p.dragging) this.drop();
  };

  private startDrag(): void {
    this.stopMotion();
    this.wake(true);
    this.anchor = null;
    this.observe([]);
    for (const k of ['think', 'cling', 'rest', 'look', 'squeakHop'] as const) this.timers.clear(k);
    this.hovering = false;
    this.setState('drag');
    this.setLean(0);
    this.els?.root.classList.add('desk-pet--held');
    this.writeShadow(0);
  }

  private drop(): void {
    this.els?.root.classList.remove('desk-pet--held');
    this.writeSquash(1, 1, 0);
    const spot = surfaceBelow(this.collect(), this.at, this.size, this.view());
    if (this.input.reduced) { this.settle(spot); return; }
    this.fallTo(spot);
  }

  private squeakClick(): void {
    this.noteInput();
    const root = this.els?.root;
    if (this.input.prefs.squeak) {
      const kind = this.squeaker.play();
      if (kind && root) {
        this.squeaks++;
        root.dataset.squeaks = String(this.squeaks);
        root.dataset.squeak = kind;
      }
    }
    this.play('squeak');
    if (!this.input.reduced && !this.motion && this.anchor && !this.frozen) {
      this.timers.set('squeakHop', Date.now() + 80, () => { if (!this.motion && this.anchor && !this.press) this.hopInPlace({ height: 16, quick: true }); });
    }
  }

  private onMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const page = this.input.page;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items: MenuEntry[] = [
      { id: 'squeak', label: 'Squeak', onSelect: () => this.squeakClick(), testId: 'desk-pet-menu-squeak' },
      { kind: 'separator' },
      { id: 'away', label: 'Hide for an hour', onSelect: () => { if (page) sendPetAway(page.toast); }, testId: 'desk-pet-menu-away' },
      { id: 'settings', label: 'Desk pet settings…', onSelect: () => page?.openSettings({ section: 'pet' }), testId: 'desk-pet-menu-settings' },
      { id: 'off', label: 'Turn off the desk pet', onSelect: () => { try { setSetting(PET_IDS.on, false); } catch { /* store missing */ } }, testId: 'desk-pet-menu-off' },
    ];
    openMenu({ items, anchor: { type: 'point', x: e.clientX, y: e.clientY }, label: 'Desk pet', testId: 'desk-pet-menu', initialFocus: 'menu', returnFocus });
  };

  // ---- keys, visibility and the page ----

  private onKey = (e: KeyboardEvent) => {
    if (this.press?.dragging && e.key === 'Escape') {
      this.press = null;
      this.drop();
      return;
    }
    this.lastKeyAt = Date.now();
    this.noteInput();
    if (this.shown && !this.timers.has('caret')) this.timers.set('caret', Date.now() + 150, () => this.checkCaret());
  };

  private onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      this.finishMotion();
      this.fxAnim?.finish();
      this.bubbleAnim?.finish();
      for (const k of IDLE_KEYS) if (k !== 'gone') this.timers.clear(k);
      this.squeaker.suspend();
      return;
    }
    if (!this.shown) { this.update(this.input); return; }
    this.ride();
    if (this.state === 'nap') this.zzz();
    else this.scheduleThought();
    this.refreshNap(true);
  };

  private startListening(): void {
    if (this.listening) return;
    this.listening = true;
    const cap = { capture: true, passive: true } as const;
    window.addEventListener('pointermove', this.onPointerMove, cap);
    window.addEventListener('pointerdown', this.onPointerDown, cap);
    window.addEventListener('pointerup', this.onPointerUp, cap);
    window.addEventListener('pointercancel', this.onPointerUp, cap);
    window.addEventListener('keydown', this.onKey, cap);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('scroll', this.onScroll, cap);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.offs.push(() => {
      window.removeEventListener('pointermove', this.onPointerMove, cap);
      window.removeEventListener('pointerdown', this.onPointerDown, cap);
      window.removeEventListener('pointerup', this.onPointerUp, cap);
      window.removeEventListener('pointercancel', this.onPointerUp, cap);
      window.removeEventListener('keydown', this.onKey, cap);
      window.removeEventListener('blur', this.onBlur);
      document.removeEventListener('scroll', this.onScroll, cap);
      document.removeEventListener('visibilitychange', this.onVisibility);
    });
    this.bindPage(this.input.page);
  }

  private stopListening(): void {
    this.listening = false;
    for (const off of this.offs.splice(0)) off();
    this.bindPage(null);
  }

  private bindPage(page: EditorPageCtx | null): void {
    for (const off of this.pageOffs.splice(0)) off();
    this.boundPage = page;
    this.seenComments = null;
    this.roster = null;
    if (!page) return;
    const me = () => {
      const user = page.user();
      const identity = user ? accountIdentity(user) : localUser();
      return { identity, who: { id: user?.id ?? null, name: identity.name } };
    };
    const roster = () => {
      try {
        const r = arrivals(this.roster, rosterPeople(page.peers(), me().identity), Date.now());
        this.roster = r.next;
        if (r.fresh > 0 && Date.now() > this.rosterQuietUntil && this.input.prefs.reactions.joins) this.notice();
      } catch { /* no roster yet */ }
    };
    const comments = () => {
      try {
        const r = newFromOthers(this.seenComments, page.comments(), me().who);
        this.seenComments = r.seen;
        if (r.fresh > 0 && this.input.prefs.reactions.comments) this.notice();
      } catch { /* no comments yet */ }
    };
    this.pageOffs.push(
      page.events.on('compileRequested', () => this.onCompileStart()),
      page.events.on('compileFinished', (e) => this.onCompileEnd(e.result, e.trigger, e.own)),
      page.events.on('rosterChanged', roster),
      page.events.on('commentsChanged', comments),
      page.events.on('activeFile', () => { if (this.anchor?.kind === 'code') this.lostFooting(); }),
      page.events.on('docChanged', (e) => { if (e.local && this.anchor?.kind === 'code') this.ride(); }),
    );
    // Who is here when it arrives is not news.
    this.rosterQuietUntil = Date.now() + 10_000;
    roster();
    comments();
  }

  private onCompileStart(): void {
    if (!this.shown || !this.input.prefs.reactions.typeset || this.state === 'nap' || this.input.reduced) return;
    const pane = document.querySelector<HTMLElement>('[data-testid="preview"]');
    if (!pane || pane.classList.contains('pane--away')) return;
    const r = pane.getBoundingClientRect();
    if (!r.width) return;
    const target = { x: r.left + r.width / 2, y: r.top + r.height / 3 };
    this.lookUntil = performance.now() + 15_000;
    this.setFace(faceToward(this.at.x, target.x, this.face, 0));
    this.setLean(leanToward(this.at, this.size.h, target, 10) || this.face * 6);
    this.timers.set('lookEnd', Date.now() + 15_000, () => { this.lookUntil = 0; this.setLean(0); });
  }

  private onCompileEnd(result: { ok?: boolean; stopped?: boolean }, trigger: string, own: boolean): void {
    this.lookUntil = 0;
    this.timers.clear('lookEnd');
    if (this.shown && this.state !== 'nap') this.setLean(0);
    if (trigger === 'adopted' || result.stopped) return;
    const ok = !!result.ok;
    const was = this.lastOk;
    this.lastOk = ok;
    if (!this.shown || !this.input.prefs.reactions.typeset || this.state === 'nap') return;
    const mine = trigger === 'user' && own;
    if (ok && (mine || was === false)) {
      this.bubble('heart');
      if (this.canReact()) this.hopInPlace({ height: 34, spin: true });
    } else if (!ok && (mine || was !== false)) {
      this.bubble('…');
      if (this.canReact()) this.play('shake');
    }
  }

  /** Someone joined or commented. */
  private notice(): void {
    if (!this.shown || this.state === 'nap') return;
    this.bubble('!');
    if (this.canReact()) this.play('wobble');
  }

  // ---- drawing ----

  private setState(s: State): void {
    this.state = s;
    const root = this.els?.root;
    if (!root) return;
    root.dataset.state = s;
    const id = this.anchor?.id;
    if (id) root.dataset.surface = id;
    else delete root.dataset.surface;
  }

  private write(): void {
    const e = this.els;
    if (!e) return;
    e.pos.style.transform = `translate3d(${r2(this.at.x)}px, ${r2(this.at.y + this.tuckY)}px, 0)`;
    const id = this.anchor?.id;
    if (id) { if (e.root.dataset.surface !== id) e.root.dataset.surface = id; } else if (e.root.dataset.surface) delete e.root.dataset.surface;
  }

  private writeSquash(sx: number, sy: number, rot: number): void {
    const e = this.els;
    if (e) e.squash.style.transform = `rotate(${r2(rot)}deg) scale(${r2(sx)}, ${r2(sy)})`;
  }

  /** The shadow stays on the ground under a hopping pet, smaller and fainter the higher it is. */
  private writeShadow(lift: number): void {
    const e = this.els;
    if (!e) return;
    const k = clamp(1 - lift / 140, 0.35, 1);
    e.shadow.style.transform = `translate(-50%, ${r2(lift - this.tuckY)}px) scale(${r2(k)})`;
    e.shadow.style.opacity = String(r2(k));
  }

  private setFace(f: 1 | -1): void {
    if (f === this.face) return;
    this.face = f;
    const e = this.els;
    if (!e) return;
    e.img.style.transform = `scaleX(${f})`;
    e.root.dataset.face = String(f);
  }

  private setLean(deg: number): void {
    const d = Math.round(deg * 2) / 2;
    if (d === this.lean) return;
    this.lean = d;
    if (this.els) this.els.lean.style.transform = `rotate(${d}deg)`;
  }

  private play(name: Effect): void {
    const fx = this.els?.fx;
    if (!fx || typeof fx.animate !== 'function') return;
    if (this.input.reduced && name !== 'squeak') return;
    const spec = effect(name);
    this.fxAnim?.cancel();
    this.fxAnim = fx.animate(spec.keyframes, { duration: spec.duration, easing: 'ease-out' });
  }

  private bubble(kind: Bubble): void {
    const b = this.els?.bubble;
    if (!b || typeof b.animate !== 'function') return;
    if (kind === 'heart') b.innerHTML = HEART;
    else b.textContent = kind;
    b.dataset.kind = kind;
    const frames: Keyframe[] = this.input.reduced
      ? [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }]
      : [
        { opacity: 0, transform: 'translate(-50%, 4px) scale(0.6)' },
        { opacity: 1, transform: 'translate(-50%, -4px) scale(1.1)', offset: 0.18 },
        { opacity: 1, transform: 'translate(-50%, -8px) scale(1)', offset: 0.7 },
        { opacity: 0, transform: 'translate(-50%, -18px) scale(0.95)' },
      ];
    this.bubbleAnim?.cancel();
    this.bubbleAnim = b.animate(frames, { duration: kind === 'z' ? 2200 : 1300, easing: 'ease-out' });
  }

  // ---- test hook ----

  private hookSpot(kind: string, index: number): Spot | null {
    if (!this.shown) return null;
    const view = this.view();
    const list = this.collect().filter((s) => (s.kind === kind || s.id === kind) && fits(s, this.size, view));
    const s = list[Math.min(index, list.length - 1)];
    if (!s) return null;
    const [lo, hi] = standRange(s, this.size, view);
    return { surface: s, x: (lo + hi) / 2, y: s.y };
  }

  private installHook(): void {
    if (safeStorage.get(HOOK_KEY) !== '1') return;
    (window as unknown as { __laytekzDeskPet: unknown }).__laytekzDeskPet = {
      owner: this,
      /** Stand on the index-th surface of a kind ('page', 'ledge', 'code', 'floor') or with an id ('ledge:editor') now. */
      perch: (kind: SurfaceKind | string, index = 0) => {
        const spot = this.hookSpot(kind, index);
        if (!spot) return false;
        this.stopMotion();
        this.settle(spot);
        return true;
      },
      /** No voluntary motion while frozen (riding still works). */
      freeze: (on = true) => { this.frozen = on; if (on) this.timers.clear('think'); else this.scheduleThought(); },
      think: () => { this.timers.clear('think'); this.think(); },
      /** Hop now, frozen or not: to the middle of that surface, or anywhere. */
      hop: (kind?: SurfaceKind | string, index = 0) => {
        if (this.motion) return false;
        if (!kind) return this.hopSomewhere(this.collect());
        const spot = this.hookSpot(kind, index);
        return !!spot && this.hopTo(spot);
      },
      /** Motions run `k` times slower (1: normal). */
      slow: (k = 1) => { this.timeScale = Math.max(1, k); },
      state: () => ({ state: this.state, surface: this.anchor?.id ?? null, x: this.at.x, y: this.at.y, face: this.face, squeaks: this.squeaks, w: this.size.w, h: this.size.h }),
    };
  }
}
