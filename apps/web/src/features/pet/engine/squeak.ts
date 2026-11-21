/**
 * F14 desk pet (PET2): the rubber-duck squeak, synthesized with the Web
 * Audio API (used when the server has no recorded squeak).
 *
 * A squeezed duck pushes air through a small reed: a buzzy, harmonically rich
 * tone whose pitch shoots up as the pressure builds and sags as it runs out
 * ("squee"), then usually a shorter, higher-starting one as air rushes back
 * in on release ("eek"). So each chirp is a sawtooth plus an octave square,
 * gliding roughly 950 → 1600 → 1250 Hz; a fast amplitude flutter and a
 * little vibrato make it rubbery rather than electronic; a soft clipper adds
 * rasp; a resonant peak near 3 kHz gives the nasal reed colour; band-passed
 * noise is the breath. Every click draws fresh parameters (pitch ±15 %,
 * length ±20 %, sometimes a single chirp) so repeated squeaks stay fun.
 */

export interface Chirp {
  /** Seconds after the start. */
  at: number;
  dur: number;
  /** Start, peak and end pitch of the glide, Hz. */
  f0: number;
  fPeak: number;
  fEnd: number;
  gain: number;
}

export interface SqueakParams {
  chirps: Chirp[];
  /** Breath noise level, relative to the tone. */
  breath: number;
  /** Rubbery amplitude flutter: rate (Hz) and depth (0–1). */
  flutterHz: number;
  flutterDepth: number;
  /** Pitch wobble: rate (Hz) and depth (fraction of the pitch). */
  vibratoHz: number;
  vibratoDepth: number;
  /** The reed's nasal resonance. */
  formantHz: number;
  formantQ: number;
  /** Soft-clip drive (rasp). */
  drive: number;
  volume: number;
}

/** The random spread of each click: pitch and length factors, and how often there is an "eek". */
export const SQUEAK_RANGE = { pitch: [0.86, 1.16], length: [0.82, 1.22], double: 0.85 } as const;
/** The two chirps before the random spread: seconds and Hz. */
export const SQUEE = { dur: 0.17, f0: 950, fPeak: 1600, fEnd: 1250 } as const;
export const EEK = { dur: 0.11, f0: 1300, fPeak: 1700, fEnd: 1050 } as const;
/** Seconds each chirp takes to die away after its end. */
export const RELEASE = 0.035;

/** A fresh squeak. `rng` returns numbers in [0, 1) (Math.random, or a seeded one in tests). */
export function squeakParams(rng: () => number = Math.random): SqueakParams {
  const between = (a: number, b: number) => a + (b - a) * rng();
  const pitch = between(SQUEAK_RANGE.pitch[0], SQUEAK_RANGE.pitch[1]);
  const len = between(SQUEAK_RANGE.length[0], SQUEAK_RANGE.length[1]);
  const squee: Chirp = { at: 0, dur: SQUEE.dur * len, f0: SQUEE.f0 * pitch, fPeak: SQUEE.fPeak * pitch * between(0.97, 1.05), fEnd: SQUEE.fEnd * pitch, gain: 1 };
  const chirps = [squee];
  if (rng() < SQUEAK_RANGE.double) {
    const gap = between(0.02, 0.05);
    chirps.push({
      at: squee.dur + gap, dur: EEK.dur * len * between(0.85, 1.15),
      f0: EEK.f0 * pitch, fPeak: EEK.fPeak * pitch * between(0.97, 1.05), fEnd: EEK.fEnd * pitch, gain: between(0.62, 0.85),
    });
  }
  return {
    chirps,
    breath: between(0.08, 0.16),
    flutterHz: between(38, 60),
    flutterDepth: between(0.22, 0.38),
    vibratoHz: between(18, 28),
    vibratoDepth: between(0.008, 0.016),
    formantHz: between(2400, 3000),
    formantQ: 2.4,
    drive: 2.2,
    volume: 0.24,
  };
}

/** How long the squeak lasts, seconds. */
export function squeakLength(p: SqueakParams): number {
  return Math.max(...p.chirps.map((c) => c.at + c.dur)) + RELEASE;
}

/** tanh soft clipping, normalised so ±1 stays ±1. */
export function softClipCurve(drive: number, n = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseBuffers.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.5), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, b);
  }
  return b;
}

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q: number, gain = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.gain.value = gain;
  return f;
}

function glide(param: AudioParam, c: Chirp, s: number, e: number, mult: number): void {
  param.setValueAtTime(c.f0 * mult, s);
  param.exponentialRampToValueAtTime(c.fPeak * mult, s + c.dur * 0.28);
  param.linearRampToValueAtTime(c.fPeak * 1.03 * mult, s + c.dur * 0.62);
  param.exponentialRampToValueAtTime(c.fEnd * mult, e);
}

/**
 * Schedules one squeak on `ctx` into `dest`, starting at `t0` (seconds,
 * context time). Returns when it ends. Every node is started and stopped
 * here, so the graph is collected once it has played.
 */
export function scheduleSqueak(ctx: BaseAudioContext, p: SqueakParams, dest: AudioNode, t0 = ctx.currentTime): number {
  const out = ctx.createGain();
  out.gain.value = p.volume;
  out.connect(dest);
  const hp = biquad(ctx, 'highpass', 650, 0.7);
  const formant = biquad(ctx, 'peaking', p.formantHz, p.formantQ, 8);
  const lp = biquad(ctx, 'lowpass', 6000, 0.6);
  const shaper = ctx.createWaveShaper();
  shaper.curve = softClipCurve(p.drive);
  shaper.oversample = '4x';
  shaper.connect(hp);
  hp.connect(formant);
  formant.connect(lp);
  lp.connect(out);

  let end = t0;
  for (const c of p.chirps) {
    const s = t0 + c.at;
    const e = s + c.dur;
    const stop = e + RELEASE + 0.01;
    end = Math.max(end, e + RELEASE);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, s);
    env.gain.exponentialRampToValueAtTime(c.gain, s + 0.008);
    env.gain.setValueAtTime(c.gain, Math.max(s + 0.009, e - 0.03));
    env.gain.exponentialRampToValueAtTime(0.0001, e + RELEASE);
    env.connect(shaper);

    // Flutter: the tone's level wavers around 1 - depth/2 by ±depth/2.
    const rough = ctx.createGain();
    rough.gain.value = 1 - p.flutterDepth / 2;
    rough.connect(env);
    const am = ctx.createOscillator();
    am.type = 'sine';
    am.frequency.value = p.flutterHz;
    const amDepth = ctx.createGain();
    amDepth.gain.value = p.flutterDepth / 2;
    am.connect(amDepth);
    amDepth.connect(rough.gain);

    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    const sq = ctx.createOscillator();
    sq.type = 'square';
    sq.detune.value = 7;
    const sqLevel = ctx.createGain();
    sqLevel.gain.value = 0.25;
    saw.connect(rough);
    sq.connect(sqLevel);
    sqLevel.connect(rough);
    glide(saw.frequency, c, s, e, 1);
    glide(sq.frequency, c, s, e, 2);

    const vib = ctx.createOscillator();
    vib.frequency.value = p.vibratoHz;
    const vibSaw = ctx.createGain();
    vibSaw.gain.value = c.fPeak * p.vibratoDepth;
    const vibSq = ctx.createGain();
    vibSq.gain.value = 2 * c.fPeak * p.vibratoDepth;
    vib.connect(vibSaw);
    vib.connect(vibSq);
    vibSaw.connect(saw.frequency);
    vibSq.connect(sq.frequency);

    for (const o of [saw, sq, am, vib]) { o.start(s); o.stop(stop); }

    // Breath: loudest at the onset, when the air first rushes through.
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx);
    const bp = biquad(ctx, 'bandpass', 3600, 0.9);
    const breath = ctx.createGain();
    breath.gain.setValueAtTime(0.0001, s);
    breath.gain.exponentialRampToValueAtTime(p.breath * c.gain * 1.6, s + 0.006);
    breath.gain.exponentialRampToValueAtTime(p.breath * c.gain * 0.5, s + c.dur * 0.4);
    breath.gain.exponentialRampToValueAtTime(0.0001, e + RELEASE);
    noise.connect(bp);
    bp.connect(breath);
    breath.connect(hp);
    noise.start(s);
    noise.stop(stop);
  }
  return end;
}
