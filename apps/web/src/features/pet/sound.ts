/**
 * F14 desk pet (PET2): plays the squeak. The server's recorded squeak when
 * it has one (capability `q`, /api/instance/pet/squeak), otherwise the
 * synthesized one (engine/squeak.ts).
 *
 * The AudioContext is made on the first click (a user gesture, so autoplay
 * rules allow it) and suspended a few seconds after the last squeak, so an
 * idle pet keeps no audio thread busy. The recording is fetched once when
 * the pet appears (same origin, signed in) and decoded on the first click;
 * every play varies its speed a little, like the synthesized one.
 */
import { scheduleSqueak, squeakParams } from './engine/squeak';

export type SqueakKind = 'file' | 'synth';

type Ctor = typeof AudioContext;
const IDLE_SUSPEND_MS = 4000;

export class Squeaker {
  private ctx: AudioContext | null = null;
  private url: string | null = null;
  private bytes: Promise<ArrayBuffer | null> | null = null;
  private buffer: AudioBuffer | null = null;
  private decoding: Promise<AudioBuffer | null> | null = null;
  private fileFailed = false;
  private idle: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly rng: () => number = Math.random) {}

  /** The recorded squeak's URL, or null for the synthesized one. */
  setUrl(url: string | null): void {
    if (url === this.url) return;
    this.url = url;
    this.bytes = null;
    this.buffer = null;
    this.decoding = null;
    this.fileFailed = false;
  }

  /** Fetches the recording ahead of the first click (nothing to do without one). */
  prefetch(): void {
    if (!this.url || this.bytes || this.fileFailed) return;
    const url = this.url;
    this.bytes = fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null)
      .then((b) => { if (!b && this.url === url) this.fileFailed = true; return b; });
  }

  /** Plays one squeak now. Returns what was played, or null when this browser has no audio. */
  play(): SqueakKind | null {
    const ctx = this.context();
    if (!ctx) return null;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    this.armIdle();
    if (this.url && !this.fileFailed) {
      if (this.buffer) { this.playBuffer(ctx, this.buffer); return 'file'; }
      void this.decode(ctx).then((buf) => {
        if (buf) this.playBuffer(ctx, buf);
        else this.synth(ctx);
      });
      return 'file';
    }
    this.synth(ctx);
    return 'synth';
  }

  dispose(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  /** Pauses the audio thread (a hidden tab, or idle). */
  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend().catch(() => undefined);
  }

  private context(): AudioContext | null {
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;
    const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
    const C = w.AudioContext ?? w.webkitAudioContext;
    if (!C) return null;
    try {
      this.ctx = new C({ latencyHint: 'interactive' });
    } catch {
      return null;
    }
    return this.ctx;
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idle = null; this.suspend(); }, IDLE_SUSPEND_MS);
  }

  private synth(ctx: AudioContext): void {
    try { scheduleSqueak(ctx, squeakParams(this.rng), ctx.destination, ctx.currentTime + 0.005); } catch (err) { console.warn('[laytekz] the desk pet could not squeak', err); }
  }

  private decode(ctx: AudioContext): Promise<AudioBuffer | null> {
    if (!this.decoding) {
      this.prefetch();
      const bytes = this.bytes ?? Promise.resolve(null);
      this.decoding = bytes
        .then((b) => (b ? ctx.decodeAudioData(b.slice(0)) : null))
        .catch(() => null)
        .then((buf) => {
          this.buffer = buf;
          if (!buf) this.fileFailed = true;
          return buf;
        });
    }
    return this.decoding;
  }

  private playBuffer(ctx: AudioContext, buf: AudioBuffer): void {
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 0.9 + this.rng() * 0.22;
      const gain = ctx.createGain();
      gain.gain.value = 0.85;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start();
    } catch (err) {
      console.warn('[laytekz] the desk pet could not squeak', err);
    }
  }
}
