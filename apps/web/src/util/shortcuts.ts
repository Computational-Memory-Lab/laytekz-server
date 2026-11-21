import { isMac } from '../platform';
// Galley: V2 (WP04) moved the shortcut machinery to keys/registry.ts (every
// binding, core and feature, with RESERVED and the settings store behind the
// overrides) and keys/chords.ts (the pure chord helpers). This file keeps
// every V1 export, with V1 semantics, by delegating there.
import { CORE_KEYBINDINGS, chordConflict as bindingConflict, chordFor as bindingChord, chordProblem as bindingProblem, isOverridden, matchesShortcut as bindingMatches, setChord as setBindingChord, useChordLabel } from '../keys/registry';
import { chordFromEvent, formatChord, matchesChord, sameChord } from '../keys/chords';

export { chordFromEvent, formatChord, matchesChord, sameChord };

/**
 * A key chord. `mod` is ⌘ on a Mac and Ctrl (or the Windows key) elsewhere.
 * A Mac's Ctrl is never mod: Ctrl+K there deletes to the end of the line in
 * every text field, the code editor's too. A chord recorded in settings also
 * carries `code`, the physical key, because Option and AltGr change what
 * `key` reports; the defaults match `key`, so an AZERTY keyboard finds M
 * where it prints it.
 */
export interface Chord { mod: boolean; shift: boolean; alt: boolean; key: string; code?: string }

export type ShortcutId = 'typeset' | 'comment' | 'jump' | 'palette' | 'search';

const SHORTCUT_IDS: readonly ShortcutId[] = ['typeset', 'comment', 'jump', 'palette', 'search'];

// Galley: ⇧⌘C / Ctrl+Shift+C for comment, the owner's choice (upstream used M); the defaults live in keys/registry.ts.
export const SHORTCUTS: readonly { id: ShortcutId; label: string; chord: Chord }[] = SHORTCUT_IDS.map((id) => {
  const def = CORE_KEYBINDINGS.find((d) => d.id === id)!;
  return { id, label: def.label, chord: def.default! };
});

/**
 * Typeset's second keys, Overleaf's: not one of the changeable chords, so a
 * chord chosen in settings for the same keys is the one they run.
 */
export const TYPESET_ENTER: Chord = { mod: true, shift: false, alt: false, key: 'Enter' };

export function isTypesetEnter(e: KeyboardEvent, mac = isMac): boolean {
  return matchesChord(e, { ...TYPESET_ENTER, key: 'enter' }, mac);
}

/** Format document in the code editor, VS Code's keys; not changeable (no mod key). */
export const FORMAT_DOCUMENT_KEYS: Chord = { mod: false, shift: true, alt: true, key: 'f', code: 'KeyF' };

/** Opens the code editor's Find from anywhere on the page. */
export function isFindKey(e: KeyboardEvent, mac = isMac): boolean {
  return matchesChord(e, { mod: true, shift: false, alt: false, key: 'f' }, mac);
}

const defaultChord = (id: ShortcutId): Chord => SHORTCUTS.find((s) => s.id === id)!.chord;

/** The chord in force; a binding cleared in the V2 settings reports its default here (keys/registry.ts chordFor gives null). */
export function chordFor(id: ShortcutId): Chord {
  return bindingChord(id) ?? defaultChord(id);
}

export function isDefaultChord(id: ShortcutId): boolean {
  return !isOverridden(id);
}

/** null puts the default back. */
export function setChord(id: ShortcutId, chord: Chord | null): void {
  setBindingChord(id, chord ?? defaultChord(id));
}

/** The chord's on-screen label, live across a change in settings. */
export function useShortcutLabel(id: ShortcutId): string {
  return useChordLabel(id);
}

export function matchesShortcut(e: KeyboardEvent, which: ShortcutId): boolean {
  return bindingMatches(e, which);
}

/** Why a chord cannot be used for `which`, or null when it can. */
export function chordProblem(c: Chord, which: ShortcutId, mac = isMac): string | null {
  return bindingProblem(c, which, mac);
}

/** Another shortcut on the same keys as `which`, as the keys stand now — a
 *  chord saved before a later default took the same keys. Only one of them
 *  can run, so settings say so on both rows. */
export function chordConflict(which: ShortcutId): string | null {
  return bindingConflict(which);
}
