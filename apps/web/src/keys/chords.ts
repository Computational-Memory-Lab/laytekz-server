/**
 * Pure chord helpers shared by the keybinding registry (keys/registry.ts) and
 * util/shortcuts.ts, which re-exports them under their V1 names. No storage,
 * no React, no DOM beyond reading a KeyboardEvent's fields.
 */
import { isMac } from '../platform';
import type { Chord } from '../util/shortcuts';

export const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Meta', 'Control', 'Shift', 'Alt', 'AltGraph', 'CapsLock', 'Fn', 'FnLock', 'OS', 'Hyper', 'Super']);

/** The letter or digit a physical key carries on a US layout, if it is one. */
export function keyFromCode(code: string | undefined): string | null {
  const m = code && /^(?:Key([A-Z])|Digit(\d)|(F\d{1,2}))$/.exec(code);
  if (!m) return null;
  return m[1] ? m[1].toLowerCase() : m[2] ?? m[3];
}

const CODE_OF_PUNCTUATION: Readonly<Record<string, string>> = {
  '\\': 'Backslash', '/': 'Slash', ',': 'Comma', '.': 'Period', ';': 'Semicolon', "'": 'Quote',
  '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', '`': 'Backquote', ' ': 'Space',
};

/** The US-layout physical key that types `key`, for code-matched bindings (⇧⌥A, ⌥\). */
export function codeForKey(key: string): string | undefined {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  if (/^F\d{1,2}$/.test(key)) return key;
  return CODE_OF_PUNCTUATION[key] ?? (/^[A-Z][A-Za-z]+$/.test(key) ? key : undefined);
}

const KEY_OF_PUNCTUATION_CODE: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(CODE_OF_PUNCTUATION).map(([k, c]) => [c, k]));

/** The key a chord presses, as identity: by the physical key when it was
 *  recorded (Option+\ types « on a Mac, Shift+/ types ?), else by `key`. */
export function normalKey(c: Chord): string {
  return ((c.code && (keyFromCode(c.code) ?? KEY_OF_PUNCTUATION_CODE[c.code])) || c.key).toLowerCase();
}

/** 'mod+alt+shift+k': the identity two chords share when they press the same keys. */
export function chordId(c: Chord): string {
  return `${c.mod ? 'mod+' : ''}${c.alt ? 'alt+' : ''}${c.shift ? 'shift+' : ''}${normalKey(c)}`;
}

export function sameChord(a: Chord, b: Chord): boolean {
  return chordId(a) === chordId(b);
}

export const modHeld = (e: { metaKey: boolean; ctrlKey: boolean }, mac: boolean): boolean => (mac ? e.metaKey : e.metaKey || e.ctrlKey);

export function matchesChord(e: KeyboardEvent, c: Chord, mac = isMac): boolean {
  // A Mac's Ctrl belongs to text editing (Ctrl+K) and the system (Ctrl+⌘+F), never to a chord.
  if (mac && e.ctrlKey) return false;
  if (modHeld(e, mac) !== c.mod || e.shiftKey !== c.shift || e.altKey !== c.alt) return false;
  // AltGr reports Ctrl+Alt on Windows, and it types characters.
  if (e.getModifierState?.('AltGraph')) return false;
  // Named keys are stored as the browser spells them ('Enter'), letters in lower case.
  return c.code ? e.code === c.code : e.key.toLowerCase() === c.key.toLowerCase();
}

/** The chord a keydown spells, or null while only modifiers are held. */
export function chordFromEvent(e: KeyboardEvent, mac = isMac): Chord | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  // Option and Shift turn M into µ and 1 into !; the label wants the key.
  const fromCode = keyFromCode(e.code);
  const key = (e.altKey || e.shiftKey) && fromCode ? fromCode : e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return { mod: modHeld(e, mac), shift: e.shiftKey, alt: e.altKey, key, code: e.code || undefined };
}

const NAMED_KEYS: Readonly<Record<string, [mac: string, other: string]>> = {
  ' ': ['Space', 'Space'], Enter: ['↩', 'Enter'], Escape: ['Esc', 'Esc'], Backspace: ['⌫', 'Backspace'],
  Delete: ['⌦', 'Del'], ArrowUp: ['↑', 'Up'], ArrowDown: ['↓', 'Down'], ArrowLeft: ['←', 'Left'], ArrowRight: ['→', 'Right'],
};

export function formatChord(c: Chord, mac = isMac): string {
  const named = NAMED_KEYS[c.key];
  const key = named ? named[mac ? 0 : 1] : c.key.length === 1 ? c.key.toUpperCase() : c.key;
  if (mac) return `${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.mod ? '⌘' : ''}${key}`;
  return [c.mod && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', key].filter(Boolean).join('+');
}

export function isChord(v: unknown): v is Chord {
  const c = v as Chord;
  return !!c && typeof c === 'object' && typeof c.mod === 'boolean' && typeof c.shift === 'boolean'
    && typeof c.alt === 'boolean' && typeof c.key === 'string' && c.key.length > 0
    && (c.code === undefined || typeof c.code === 'string');
}

/** A chord for a default: `chord('mod+shift+e')`, `chord('alt+Enter')`. The last part is the key as `KeyboardEvent.key` spells it. */
export function chord(spec: string, code?: string): Chord {
  const parts = spec.split('+');
  const key = parts.pop() || '+';
  const has = (m: string) => parts.includes(m);
  return { mod: has('mod'), shift: has('shift'), alt: has('alt'), key, ...(code ? { code } : {}) };
}
