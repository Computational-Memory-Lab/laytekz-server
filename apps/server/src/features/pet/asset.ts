/**
 * F14 desk pet, server side (WP39 pet-engine): the operator's pet image.
 *
 * The image is supplied by whoever runs the server, never shipped: it lives
 * outside every repository, installer and source tarball, and reaches the
 * app only through GET /api/instance/pet (signed-in people only, `private`
 * caching). Env only, read once at boot, like ALDINE_INSTANCE_LOGO:
 *
 *   ALDINE_INSTANCE_PET             path to a still PNG, WebP or SVG with a
 *                                   transparent background (at most 512 KB)
 *   ALDINE_INSTANCE_PET_SILHOUETTE  optional: the same figure as a dark
 *                                   shape; same rules, and its aspect ratio
 *                                   must match the main image within 2%.
 *                                   Without it the app darkens the image
 *                                   (CSS brightness(0)), which gives the
 *                                   same fade-in.
 *
 *   ALDINE_INSTANCE_PET_SQUEAK      optional (PET2): a recorded squeak played
 *                                   when the pet is clicked: MP3, Ogg or WAV,
 *                                   at most 512 KB. Without it the app
 *                                   synthesizes the squeak.
 *
 * JPEG is refused (no transparency), and so are animated images (APNG,
 * animated WebP, GIF): the app animates the pet itself, so it can pause,
 * slow down and stay still under reduced motion.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { logoType } from '../../instance.js';

export const MAX_PET_BYTES = 512 * 1024;
/** Below this height the pet looks blurred on a high-density screen: a warning, not a refusal. */
export const MIN_PET_HEIGHT = 60;

export type PetImageType = 'image/png' | 'image/webp' | 'image/svg+xml';

export interface PetImage {
  bytes: Buffer;
  type: PetImageType;
  /** First 12 hex digits of the file's SHA-256: the cache-busting version. */
  v: string;
  /** Intrinsic size in pixels, when the file states one (SVG without width/height/viewBox: null). */
  w: number | null;
  h: number | null;
}

export const MAX_SQUEAK_BYTES = 512 * 1024;
export type SqueakType = 'audio/mpeg' | 'audio/ogg' | 'audio/wav';

export interface PetSqueak {
  bytes: Buffer;
  type: SqueakType;
  /** First 12 hex digits of the file's SHA-256. */
  v: string;
}

export interface LoadedPet {
  pet: PetImage | null;
  silhouette: PetImage | null;
  /** The recorded squeak, or null (the app synthesizes one). */
  squeak: PetSqueak | null;
  /** Boot warnings, logged by the feature; each names the variable and why. */
  warnings: string[];
}

/** Why the bytes cannot be the pet, or null. Exported for the tests. */
export function petRefusal(b: Buffer): string | null {
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) {
    return 'animated images are not used: the app animates the pet (supply a still PNG, WebP or SVG)';
  }
  const type = logoType(b);
  if (!type) return 'it is not a PNG, WebP or SVG image';
  if (type === 'image/jpeg') return 'a JPEG cannot have a transparent background: supply a PNG, WebP or SVG';
  if (type === 'image/png' && pngAnimated(b)) return 'animated images are not used: the app animates the pet (supply a still PNG)';
  if (type === 'image/webp' && webpAnimated(b)) return 'animated images are not used: the app animates the pet (supply a still WebP)';
  return null;
}

/** PNG chunks in order, each as [type, data start, data length]; stops at IEND or a torn chunk. */
function pngChunks(b: Buffer): [string, number, number][] {
  const out: [string, number, number][] = [];
  let at = 8;
  while (at + 8 <= b.length) {
    const len = b.readUInt32BE(at);
    const type = b.subarray(at + 4, at + 8).toString('latin1');
    if (at + 12 + len > b.length) break;
    out.push([type, at + 8, len]);
    if (type === 'IEND') break;
    at += 12 + len;
  }
  return out;
}

/** APNG: an acTL chunk before the first IDAT. */
export function pngAnimated(b: Buffer): boolean {
  for (const [type] of pngChunks(b)) {
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
  }
  return false;
}

/** Animated WebP: the VP8X header's animation flag, or an ANIM/ANMF chunk. */
export function webpAnimated(b: Buffer): boolean {
  const kind = b.subarray(12, 16).toString('latin1');
  if (kind === 'VP8X' && b.length > 20 && (b[20] & 0x02) !== 0) return true;
  const s = b.toString('latin1');
  return s.includes('ANIM') && s.includes('ANMF');
}

/** Width and height from the file's header, or nulls. */
export function imageSize(b: Buffer, type: PetImageType): { w: number | null; h: number | null } {
  const none = { w: null, h: null };
  if (type === 'image/png') {
    const ihdr = pngChunks(b).find(([t]) => t === 'IHDR');
    if (!ihdr || ihdr[2] < 8) return none;
    return { w: b.readUInt32BE(ihdr[1]), h: b.readUInt32BE(ihdr[1] + 4) };
  }
  if (type === 'image/webp') {
    const kind = b.subarray(12, 16).toString('latin1');
    if (kind === 'VP8X' && b.length >= 30) return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && b.length >= 30) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && b.length >= 25) {
      const bits = b.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    return none;
  }
  const head = b.subarray(0, 4096).toString('utf8');
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? '';
  const num = (name: string) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(px)?\\s*["']`, 'i').exec(tag);
    return m ? Math.round(Number(m[1])) || null : null;
  };
  const w = num('width');
  const h = num('height');
  if (w && h) return { w, h };
  const vb = /\sviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(tag);
  if (vb) return { w: Math.round(Number(vb[1])) || null, h: Math.round(Number(vb[2])) || null };
  return none;
}

/** The audio type from the file's first bytes (never its name), or null. */
export function audioType(b: Buffer): SqueakType | null {
  if (b.length >= 3 && b.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
  // An MPEG audio frame: 11 sync bits, then a version and layer that exist (not 01 and 00).
  if (b.length >= 4 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x18) !== 0x08 && (b[1] & 0x06) !== 0) return 'audio/mpeg';
  if (b.length >= 4 && b.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  return null;
}

function readSqueak(env: NodeJS.ProcessEnv, warnings: string[]): PetSqueak | null {
  const key = 'ALDINE_INSTANCE_PET_SQUEAK';
  const file = (env[key] || '').trim();
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('it is not a file');
    if (st.size > MAX_SQUEAK_BYTES) throw new Error(`it is larger than ${MAX_SQUEAK_BYTES / 1024} KB`);
    const bytes = fs.readFileSync(file);
    const type = audioType(bytes);
    if (!type) throw new Error('it is not an MP3, Ogg or WAV file');
    return { bytes, type, v: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12) };
  } catch (err: any) {
    const why = err?.code === 'ENOENT' ? 'the file does not exist' : err?.code ? `it cannot be read (${err.code})` : err.message;
    warnings.push(`[laytekz] ${key}=${file} is not used: ${why}`);
    return null;
  }
}

type Key = 'ALDINE_INSTANCE_PET' | 'ALDINE_INSTANCE_PET_SILHOUETTE';

function readPet(env: NodeJS.ProcessEnv, key: Key, warnings: string[]): PetImage | null {
  const file = (env[key] || '').trim();
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('it is not a file');
    if (st.size > MAX_PET_BYTES) throw new Error(`it is larger than ${MAX_PET_BYTES / 1024} KB`);
    const bytes = fs.readFileSync(file);
    const why = petRefusal(bytes);
    if (why) throw new Error(why);
    const type = logoType(bytes) as PetImageType;
    const { w, h } = imageSize(bytes, type);
    const v = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    return { bytes, type, v, w, h };
  } catch (err: any) {
    const why = err?.code === 'ENOENT' ? 'the file does not exist' : err?.code ? `it cannot be read (${err.code})` : err.message;
    // The path is the operator's own; it is logged at boot only, never sent to a client.
    warnings.push(`[laytekz] ${key}=${file} is not used: ${why}`);
    return null;
  }
}

/** Reads and checks the variables. Nothing configured: nulls and no warnings. */
export function loadPet(env: NodeJS.ProcessEnv = process.env): LoadedPet {
  const warnings: string[] = [];
  const pet = readPet(env, 'ALDINE_INSTANCE_PET', warnings);
  let silhouette = readPet(env, 'ALDINE_INSTANCE_PET_SILHOUETTE', warnings);
  if (silhouette && !pet) {
    warnings.push('[laytekz] ALDINE_INSTANCE_PET_SILHOUETTE is set without a usable ALDINE_INSTANCE_PET; it is not used');
    silhouette = null;
  }
  if (pet && silhouette && pet.w && pet.h && silhouette.w && silhouette.h) {
    const a = pet.w / pet.h;
    const b = silhouette.w / silhouette.h;
    if (Math.abs(a - b) / a > 0.02) {
      warnings.push('[laytekz] ALDINE_INSTANCE_PET_SILHOUETTE has a different shape from ALDINE_INSTANCE_PET; it is not used (the app darkens the image instead)');
      silhouette = null;
    }
  }
  if (pet && pet.h !== null && pet.h < MIN_PET_HEIGHT) {
    warnings.push(`[laytekz] ALDINE_INSTANCE_PET is only ${pet.h} px tall; it will look blurred on high-density screens (${MIN_PET_HEIGHT} px or more is better)`);
  }
  // A squeak without a pet has nothing to belong to.
  const squeak = pet ? readSqueak(env, warnings) : null;
  return { pet, silhouette, squeak, warnings };
}
