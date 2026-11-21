/**
 * F14 desk pet: the operator's image as the client sees it (WP39 pet-engine).
 *
 * The server announces the image through GET /api/capabilities as
 * `pet: {v, w, h, s, q}` (only to callers allowed to see it) and serves it at
 * /api/instance/pet?v=<v> (signed in, `private` caching). The image never
 * ships with the app: no placeholder exists, and without the capability the
 * feature shows nothing at all. `q` is the version of a recorded squeak the
 * server has (/api/instance/pet/squeak), or null: the app then synthesizes
 * the squeak itself (engine/squeak.ts).
 */
import { withBase } from '../../../basePath';

/** The image's visible figure as fractions of the image box. */
export interface PetShape {
  /** Width / height of the image. */
  aspect: number;
  /** First visible row from the top, 0–1. */
  top: number;
  /** One past the last visible row (the paws), 0–1. */
  bottom: number;
  /** Intrinsic height in pixels (no upscaling past it). */
  naturalHeight: number;
}

export interface PetAsset {
  /** 12 hex digits: the image's version. */
  v: string;
  w: number | null;
  h: number | null;
  /** The silhouette's version, or null (the runtime darkens the image instead). */
  s: string | null;
  /** The recorded squeak's version, or null (the squeak is synthesized). */
  q: string | null;
}

const HEX12 = /^[0-9a-f]{12}$/;
const dim = (n: unknown): number | null => (typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 16384 ? n : null);

/** The capabilities' `pet` value, checked; anything unusable is null (no pet). */
export function parsePetAsset(raw: unknown): PetAsset | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.v !== 'string' || !HEX12.test(r.v)) return null;
  const s = typeof r.s === 'string' && HEX12.test(r.s) ? r.s : null;
  const q = typeof r.q === 'string' && HEX12.test(r.q) ? r.q : null;
  return { v: r.v, w: dim(r.w), h: dim(r.h), s, q };
}

/** From the whole capabilities object. */
export function petAssetFrom(capabilities: unknown): PetAsset | null {
  if (!capabilities || typeof capabilities !== 'object') return null;
  return parsePetAsset((capabilities as Record<string, unknown>).pet);
}

/** The image URL, versioned so the browser may keep it (privately) for a year. */
export function petImageUrl(a: PetAsset, variant: 'image' | 'silhouette' = 'image'): string | null {
  if (variant === 'silhouette') return a.s ? withBase(`/api/instance/pet/silhouette?v=${a.s}`) : null;
  return withBase(`/api/instance/pet?v=${a.v}`);
}

/** The recorded squeak's URL, or null when the server has none. */
export function petSqueakUrl(a: PetAsset): string | null {
  return a.q ? withBase(`/api/instance/pet/squeak?v=${a.q}`) : null;
}

/** The shape when nothing has been measured yet: the whole box, from the stated size. */
export function fallbackShape(a: PetAsset): PetShape {
  const aspect = a.w && a.h ? a.w / a.h : 1;
  return { aspect, top: 0, bottom: 1, naturalHeight: a.h ?? 0 };
}

/**
 * The visible figure's extent from RGBA pixels: the first and last rows with
 * an alpha above `threshold`, as fractions of the height. Fully transparent
 * images give the whole box. Pure, so it is tested without a DOM.
 */
export function scanAlpha(data: ArrayLike<number>, width: number, height: number, threshold = 16): Pick<PetShape, 'top' | 'bottom'> {
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
    }
  }
  if (top < 0 || height <= 0) return { top: 0, bottom: 1 };
  return { top: top / height, bottom: (bottom + 1) / height };
}

/** The image's paws, measured once in the browser by drawing it on a canvas. Falls back to the whole box. */
export async function measurePet(a: PetAsset, url: string): Promise<PetShape> {
  const base = fallbackShape(a);
  if (typeof Image === 'undefined' || typeof document === 'undefined') return base;
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return base;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const cx = canvas.getContext('2d', { willReadFrequently: true });
    if (!cx) return { ...base, aspect: w / h, naturalHeight: h };
    cx.drawImage(img, 0, 0);
    const { top, bottom } = scanAlpha(cx.getImageData(0, 0, w, h).data, w, h);
    return { aspect: w / h, top, bottom, naturalHeight: h };
  } catch {
    return base;
  }
}
