/**
 * Device-mirror codecs (WP02 settings-core). A codec turns a setting's value
 * into the text kept under its localStorage key and back. The V1 keys keep
 * their exact V1 readings: each codec here repeats, for absent, '0', '1' and
 * any other text, what the V1 code read (settings/__tests__/codecs.test.ts
 * holds them to it). Pure data: no React, no CodeMirror, no store.
 */
import type { Codec } from './types';

/** Any JSON value; `undefined` for nothing stored, unparsable text or a value `valid` refuses. */
export function jsonCodec<T>(valid?: (v: unknown) => v is T): Codec<T> {
  return {
    decode(raw) {
      if (raw === null) return undefined;
      try {
        const v: unknown = JSON.parse(raw);
        return valid && !valid(v) ? undefined : (v as T);
      } catch {
        return undefined;
      }
    },
    encode(v) { return JSON.stringify(v); },
  };
}

/** The default codec of a setting that names none. */
export const JSON_CODEC: Codec<unknown> = jsonCodec();

/** V1's `get(key) !== '0'`: on unless the text is exactly '0'. Writes '0' and '1'. */
export const onUnless0: Codec<boolean> = {
  decode: (raw) => raw !== '0',
  encode: (v) => (v ? '1' : '0'),
};

/** V1's `get(key) === '1'`: off unless the text is exactly '1'. Writes '1' and '0'. */
export const offUnless1: Codec<boolean> = {
  decode: (raw) => raw === '1',
  encode: (v) => (v ? '1' : '0'),
};

/** One of `values` kept as its own text; anything else (absent included) is `fallback`
 *  (undefined: "not a value I know", so the store uses the default). */
export function textChoice<T extends string>(values: readonly T[], fallback?: T): Codec<T> {
  return {
    decode: (raw) => (raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : fallback),
    encode: (v) => v,
  };
}

/** aldine.theme (theme.ts, index.html's pre-paint): 'light', 'dark' or 'system'; anything else is 'system'. */
export type Appearance = 'system' | 'light' | 'dark';
export const APPEARANCE_VALUES: readonly Appearance[] = ['system', 'light', 'dark'];
export const appearanceCodec: Codec<Appearance> = textChoice<Appearance>(APPEARANCE_VALUES, 'system');

/** The appearance a stored text means (V1's parseAppearance). */
export function parseAppearance(raw: string | null | undefined): Appearance {
  return appearanceCodec.decode(raw ?? null) ?? 'system';
}

/** aldine.editorMode (Editor.tsx): 'visual' is Visual, anything else Source. */
export const editorModeCodec: Codec<'source' | 'visual'> = {
  decode: (raw) => (raw === 'visual' ? 'visual' : 'source'),
  encode: (v) => v,
};

/** aldine.layout (util/layout.ts readLayout): 'editor', 'both' or 'pdf'; anything
 *  else is '' (the window's width decides). '' removes the key. */
export type PaneLayout = '' | 'editor' | 'both' | 'pdf';
export const layoutCodec: Codec<PaneLayout> = {
  decode: (raw) => (raw === 'editor' || raw === 'both' || raw === 'pdf' ? raw : ''),
  encode: (v) => (v === '' ? null : v),
};

/** aldine.pdfZoom (Editor.tsx): `Number(text)` when 0.5 to 3, otherwise 1 (absent and '' included). */
export const pdfZoomCodec: Codec<number> = {
  decode: (raw) => {
    const z = Number(raw);
    return z >= 0.5 && z <= 3 ? z : 1;
  },
  encode: (v) => String(v),
};

/** aldine.spellcheckLang (Editor.tsx): a tag `known` accepts, otherwise ''
 *  (the browser's default). '' removes the key, as V1's setSpellLang did. */
export function spellLangCodec(known: (tag: string) => boolean): Codec<string> {
  return {
    decode: (raw) => (raw && known(raw) ? raw : ''),
    encode: (v) => (v ? v : null),
  };
}

/** util/shortcuts.ts's Chord, repeated as a guard so this file stays free of the keys code. */
export interface StoredChord { mod: boolean; shift: boolean; alt: boolean; key: string; code?: string }

export function isStoredChord(v: unknown): v is StoredChord {
  const c = v as StoredChord;
  return !!c && typeof c === 'object' && typeof c.mod === 'boolean' && typeof c.shift === 'boolean'
    && typeof c.alt === 'boolean' && typeof c.key === 'string' && c.key.length > 0
    && (c.code === undefined || typeof c.code === 'string');
}

/** Binding id → its chord, or null for "no chord" (a binding the person unbound). */
export type ShortcutOverrides = Record<string, StoredChord | null>;

export function isShortcutOverrides(v: unknown): v is ShortcutOverrides {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((c) => c === null || isStoredChord(c));
}

/**
 * aldine.shortcuts (util/shortcuts.ts read()): a JSON object of chords by id.
 * V1 read each entry it knew and ignored any it could not use; so does this,
 * keeping every well-formed entry (V2 has more bindings than V1's five).
 * Unparsable text or a non-object is no overrides at all, as in V1.
 */
export const shortcutsCodec: Codec<ShortcutOverrides> = {
  decode(raw) {
    if (raw === null) return {};
    let v: unknown;
    try { v = JSON.parse(raw); } catch { return {}; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: ShortcutOverrides = {};
    for (const [id, c] of Object.entries(v as Record<string, unknown>)) if (c === null || isStoredChord(c)) out[id] = c;
    return out;
  },
  encode: (v) => JSON.stringify(v),
};

/** Structural equality for setting values (JSON shapes only). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameValue(x, bb[i]));
  }
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
