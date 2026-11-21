/**
 * Colour choices for the highlighter's interface (WP37): the current colour
 * the button paints with, "Your colours" (custom hex values, most recent
 * first) and the readability check of the custom-colour dialog. Pure apart
 * from the per-browser "last colour", which is a convenience only.
 */
import { PRESETS, isColor, isHex, isPreset, type HighlightColor } from './model';

/** At most this many custom colours are kept. */
export const CUSTOM_MAX = 8;

/** A stored "Your colours" value as a clean list: '#rrggbb' only, no repeats, at most CUSTOM_MAX. */
export function cleanCustomList(v: unknown): `#${string}`[] {
  if (!Array.isArray(v)) return [];
  const out: `#${string}`[] = [];
  for (const c of v) {
    if (isHex(c) && !out.includes(c)) out.push(c);
    if (out.length >= CUSTOM_MAX) break;
  }
  return out;
}

/** The list with `c` at the front (moved there if it was already in it). */
export function addCustom(list: unknown, c: string): `#${string}`[] {
  const clean = cleanCustomList(list);
  if (!isHex(c)) return clean;
  return [c, ...clean.filter((x) => x !== c)].slice(0, CUSTOM_MAX);
}

export function removeCustom(list: unknown, c: string): `#${string}`[] {
  return cleanCustomList(list).filter((x) => x !== c);
}

export const isCustomList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= CUSTOM_MAX && v.every((c) => isHex(c));

const LAST_KEY = 'aldine.highlighter.last';

/** The colour last chosen in this browser, or null. */
export function lastColor(): HighlightColor | null {
  try {
    const v = localStorage.getItem(LAST_KEY);
    return isColor(v) ? v : null;
  } catch { return null; }
}

export function rememberColor(c: string): void {
  if (!isColor(c)) return;
  try { localStorage.setItem(LAST_KEY, c); } catch { /* private window: the default colour is used */ }
}

/** What the button and ⇧⌘H paint with: the last colour chosen when remembered, else the default colour. */
export function pickCurrent(defaultColor: unknown, remember: boolean, last: string | null): HighlightColor {
  if (remember && isColor(last)) return last;
  return isPreset(defaultColor) ? defaultColor : 'yellow';
}

// ---- Readability (the custom-colour dialog's warnings) ----

type RGB = [number, number, number];

function rgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function lum([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: string, b: string): number {
  const x = lum(rgb(a));
  const y = lum(rgb(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `fg` at `alpha` (0–1) over `bg`, as '#rrggbb'. */
export function mixOver(fg: string, bg: string, alpha: number): `#${string}` {
  const f = rgb(fg);
  const g = rgb(bg);
  const c = f.map((v, i) => Math.round(v * alpha + g[i] * (1 - alpha)));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** The mix the CSS uses (highlighter.css), by theme and strength. */
export const MIX = {
  light: { light: 0.24, medium: 0.32, strong: 0.43 },
  dark: { light: 0.21, medium: 0.28, strong: 0.38 },
} as const;

/** The editor's paper, body text and comment grey in each theme. */
export const THEME_INK = {
  light: { bg: '#ffffff', text: '#1d1d1f', comment: '#7a7a80' },
  dark: { bg: '#232326', text: '#f5f5f7', comment: '#84848e' },
} as const;

/** Plain warnings for a custom colour; empty when it reads well on both themes. Never blocks. */
export function readabilityWarnings(hex: string, strength: 'light' | 'medium' | 'strong' = 'medium'): string[] {
  if (!isHex(hex)) return [];
  const out: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    const ink = THEME_INK[theme];
    const tint = mixOver(hex, ink.bg, MIX[theme][strength]);
    const name = theme === 'light' ? 'the light theme' : 'the dark theme';
    if (contrast(ink.text, tint) < 4.5) out.push(`Text is hard to read on this colour in ${name}.`);
    else if (contrast(ink.comment, tint) < 3) out.push(`Grey comment text is hard to read on this colour in ${name}.`);
    if (contrast(tint, ink.bg) < 1.08) out.push(`This colour is barely visible in ${name}.`);
  }
  return out;
}

export { PRESETS };
