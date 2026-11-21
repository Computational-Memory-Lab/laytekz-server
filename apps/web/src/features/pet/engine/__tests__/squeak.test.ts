import { describe, expect, it } from 'vitest';
import { RELEASE, SQUEAK_RANGE, SQUEE, scheduleSqueak, softClipCurve, squeakLength, squeakParams } from '../squeak';

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

/** Just enough of an AudioContext to record what a squeak schedules. */
function fakeContext() {
  const log = { oscillators: [] as { type: string; starts: number[]; stops: number[]; freq: [string, number, number][] }[], sources: 0, gains: 0, filters: [] as string[], connections: 0 };
  const param = (sink?: [string, number, number][]) => ({
    value: 0,
    setValueAtTime(v: number, t: number) { sink?.push(['set', v, t]); return this; },
    linearRampToValueAtTime(v: number, t: number) { sink?.push(['lin', v, t]); return this; },
    exponentialRampToValueAtTime(v: number, t: number) { if (v <= 0) throw new RangeError('exponential ramps need a positive target'); sink?.push(['exp', v, t]); return this; },
  });
  const node = () => ({ connect() { log.connections++; } });
  const ctx = {
    currentTime: 2,
    sampleRate: 48000,
    createGain() { log.gains++; return { ...node(), gain: param() }; },
    createBiquadFilter() { const f = { ...node(), type: '', frequency: param(), Q: param(), gain: param() }; queueMicrotask(() => log.filters.push(f.type)); return f; },
    createWaveShaper() { return { ...node(), curve: null as Float32Array | null, oversample: 'none' }; },
    createOscillator() {
      const rec = { type: 'sine', starts: [] as number[], stops: [] as number[], freq: [] as [string, number, number][] };
      log.oscillators.push(rec);
      return {
        ...node(),
        get type() { return rec.type; },
        set type(v: string) { rec.type = v; },
        frequency: param(rec.freq),
        detune: param(),
        start(t: number) { rec.starts.push(t); },
        stop(t: number) { rec.stops.push(t); },
      };
    },
    createBufferSource() { log.sources++; return { ...node(), buffer: null, start() {}, stop() {} }; },
    createBuffer(_ch: number, len: number) { const d = new Float32Array(len); return { getChannelData: () => d }; },
  };
  return { ctx: ctx as unknown as BaseAudioContext, log };
}

describe('squeak', () => {
  it('every click varies pitch and length within the ranges, deterministic for a seed', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const p = squeakParams(seeded(seed));
      const [first] = p.chirps;
      const pitch = first.f0 / SQUEE.f0;
      expect(pitch).toBeGreaterThanOrEqual(SQUEAK_RANGE.pitch[0] - 1e-9);
      expect(pitch).toBeLessThanOrEqual(SQUEAK_RANGE.pitch[1] + 1e-9);
      expect(first.dur / SQUEE.dur).toBeGreaterThanOrEqual(SQUEAK_RANGE.length[0] - 1e-9);
      expect(first.dur / SQUEE.dur).toBeLessThanOrEqual(SQUEAK_RANGE.length[1] + 1e-9);
      // A squee: rises, then sags, all in the rubber-duck band.
      expect(first.fPeak).toBeGreaterThan(first.f0);
      expect(first.fEnd).toBeLessThan(first.fPeak);
      for (const c of p.chirps) for (const f of [c.f0, c.fPeak, c.fEnd]) { expect(f).toBeGreaterThan(750); expect(f).toBeLessThan(2100); }
      if (p.chirps[1]) {
        expect(p.chirps[1].at).toBeGreaterThan(first.dur);
        expect(p.chirps[1].gain).toBeLessThan(1);
      }
      expect(squeakLength(p)).toBeLessThan(0.5);
      seen.add(`${first.f0.toFixed(1)}:${first.dur.toFixed(4)}`);
    }
    expect(seen.size).toBeGreaterThan(190);
    expect(squeakParams(seeded(9))).toEqual(squeakParams(seeded(9)));
  });

  it('usually a squee and an eek, sometimes a single squeak', () => {
    let doubles = 0;
    for (let seed = 1; seed <= 300; seed++) if (squeakParams(seeded(seed)).chirps.length === 2) doubles++;
    expect(doubles).toBeGreaterThan(220);
    expect(doubles).toBeLessThan(295);
  });

  it('schedules buzzy gliding oscillators with breath, all started and stopped', async () => {
    const { ctx, log } = fakeContext();
    const p = squeakParams(seeded(5));
    const dest = { connect() {} } as unknown as AudioNode;
    const end = scheduleSqueak(ctx, p, dest, 2);
    expect(end).toBeCloseTo(2 + squeakLength(p), 9);
    expect(log.oscillators.length).toBe(4 * p.chirps.length);
    expect(log.oscillators.filter((o) => o.type === 'sawtooth').length).toBe(p.chirps.length);
    expect(log.oscillators.filter((o) => o.type === 'square').length).toBe(p.chirps.length);
    for (const o of log.oscillators) {
      expect(o.starts.length).toBe(1);
      expect(o.stops.length).toBe(1);
      expect(o.stops[0]).toBeGreaterThan(o.starts[0]);
      expect(o.stops[0]).toBeLessThanOrEqual(end + 0.02);
    }
    const saw = log.oscillators.find((o) => o.type === 'sawtooth')!;
    expect(saw.freq[0]).toEqual(['set', p.chirps[0].f0, 2]);
    expect(saw.freq.at(-1)).toEqual(['exp', p.chirps[0].fEnd, 2 + p.chirps[0].dur]);
    expect(log.sources).toBe(p.chirps.length);
    await Promise.resolve();
    expect(log.filters).toEqual(expect.arrayContaining(['highpass', 'peaking', 'lowpass', 'bandpass']));
    expect(RELEASE).toBeGreaterThan(0);
  });

  it('the soft clipper is odd, bounded and keeps the ends', () => {
    const c = softClipCurve(2.2, 101);
    expect(c[0]).toBeCloseTo(-1, 6);
    expect(c[100]).toBeCloseTo(1, 6);
    expect(c[50]).toBeCloseTo(0, 6);
    expect(c[75]).toBeCloseTo(-c[25], 6);
    expect(c[75]).toBeGreaterThan(0.5);
  });
});
