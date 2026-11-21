/**
 * The highlighter's data (WP32). Highlights live in a side map of the file's
 * own Yjs doc (HIGHLIGHTS_KEY), beside Claude's change marks: they sync,
 * queue offline and follow the text like the text itself, and they never
 * reach the file on disk, git, the compiler or the ZIP download (only the
 * Y.Text "content" is ever written out).
 *
 * Entry = { v: 1, a, b, c, u, n, t }: `a` the start (relative position,
 * assoc 0), `b` the end (assoc −1), `c` a preset id or '#rrggbb', `u` the
 * author's id, `n` the author's display name, `t` ms since the epoch. An
 * entry is replaced whole, never edited in place. Everything read from the
 * map is untrusted: only preset ids and '#rrggbb' reach a style, names are
 * text, and an entry with v > 1 is left alone (a newer client wrote it).
 */
export { HIGHLIGHTS_KEY, HL_ORIGIN } from '../../editor/docCache';

/** Most highlights one file holds; the server trims to the newest on load. */
export const HIGHLIGHTS_MAX = 5000;

export const PRESETS = ['yellow', 'orange', 'pink', 'green', 'sky', 'violet'] as const;
export type PresetId = typeof PRESETS[number];
export type HighlightColor = PresetId | `#${string}`;

const PRESET_NAMES: Record<PresetId, string> = {
  yellow: 'Yellow', orange: 'Orange', pink: 'Pink', green: 'Green', sky: 'Sky', violet: 'Violet',
};

export const isPreset = (c: unknown): c is PresetId => typeof c === 'string' && (PRESETS as readonly string[]).includes(c);
export const isHex = (c: unknown): c is `#${string}` => typeof c === 'string' && /^#[0-9a-f]{6}$/.test(c);
export const isColor = (c: unknown): c is HighlightColor => isPreset(c) || isHex(c);

/** What is drawn for a stored colour: unknown values draw as yellow (and stay as they are in the data). */
export const drawnColor = (c: unknown): HighlightColor => (isColor(c) ? c : 'yellow');

/** A colour's name for people: "Yellow", or the hex value. */
export function colorName(c: unknown): string {
  const d = drawnColor(c);
  return isPreset(d) ? PRESET_NAMES[d] : d;
}

/** A typed hex colour as '#rrggbb', or why it is refused. */
export function normalizeHex(input: string): { ok: true; color: `#${string}` } | { ok: false; error: string } {
  const s = input.trim().toLowerCase().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/.test(s)) return { ok: true, color: `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}` };
  if (/^[0-9a-f]{6}$/.test(s)) return { ok: true, color: `#${s}` };
  if (/^[0-9a-f]{8}$/.test(s)) return { ok: false, error: 'Transparency comes from Highlight strength in settings' };
  return { ok: false, error: 'Enter # and 6 hex digits, like #ffd60a' };
}

export interface Entry {
  v: 1;
  a: Record<string, unknown>;
  b: Record<string, unknown>;
  /** As stored (drawn through drawnColor): an unknown value is kept, never rewritten. */
  c: string;
  u: string;
  n: string;
  t: number;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** A version-1 entry, or null for anything else (junk, or a newer version). */
export function readEntry(raw: unknown): Entry | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  if (!isObj(raw.a) || !isObj(raw.b) || typeof raw.t !== 'number' || !Number.isFinite(raw.t)) return null;
  return {
    v: 1,
    a: raw.a,
    b: raw.b,
    c: typeof raw.c === 'string' ? raw.c.slice(0, 40) : 'yellow',
    u: typeof raw.u === 'string' ? raw.u.slice(0, 200) : '',
    n: typeof raw.n === 'string' ? raw.n.slice(0, 200) : '',
    t: raw.t,
  };
}

let seq = 0;
/** A new entry key: time, then randomness, so keys from two peers never meet. */
export function newKey(now = Date.now()): string {
  const rand = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
  return `${now.toString(36)}.${rand}${(seq++ % 1296).toString(36)}`;
}

/** A highlight where it sits in the text now. */
export interface Run {
  key: string;
  from: number;
  to: number;
  /** As stored; draw it through drawnColor. */
  color: string;
  author: string;
  name: string;
  t: number;
}

/** Newest first: later `t`, then the larger key. */
export const newer = (x: Pick<Run, 't' | 'key'>, y: Pick<Run, 't' | 'key'>): boolean => (x.t !== y.t ? x.t > y.t : x.key > y.key);
