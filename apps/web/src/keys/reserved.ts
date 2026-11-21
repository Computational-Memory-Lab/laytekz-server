/**
 * Chords that the browser, the operating system, the desktop app or the code
 * editor keep for themselves (plan §2.3, "Rejected chords" and "Desktop
 * accelerators that stay off web chords"). keys/registry.ts exports the list
 * as RESERVED and chordProblem refuses them; the collision test checks every
 * default against it.
 */
import type { Chord, ReservedChord } from './types';
import { chord, chordId } from './chords';

type Platform = ReservedChord['platforms'][number];

export interface Reservation extends ReservedChord {
  /** 'editor': `owner` is a command of the code editor ("Bold"); otherwise the owner of the keys ("the browser"). */
  kind: 'editor' | 'other';
}

const ALL: Platform[] = ['mac', 'win', 'linux'];
const MAC: Platform[] = ['mac'];
const PC: Platform[] = ['win', 'linux'];

const BROWSER = 'the browser';
const DEVTOOLS = "the browser's developer tools";

const editor = (spec: string, owner: string, platforms: Platform[] = ALL): Reservation => ({ chord: chord(spec), owner, platforms, kind: 'editor' });
const other = (spec: string, owner: string, platforms: Platform[] = ALL, code?: string): Reservation => ({ chord: chord(spec, code), owner, platforms, kind: 'other' });

export const RESERVATIONS: readonly Reservation[] = [
  // V1's refusals (util/shortcuts.ts TAKEN), worded as they were.
  ...['w', 't', 'n', 'q', 'r'].map((k) => other(`mod+${k}`, BROWSER)),
  ...['w', 't', 'n', 'r'].map((k) => other(`mod+shift+${k}`, BROWSER)),
  editor('mod+z', 'Undo'), editor('mod+shift+z', 'Redo'), editor('mod+y', 'Redo'),
  editor('mod+c', 'Copy'), editor('mod+x', 'Cut'), editor('mod+v', 'Paste'), editor('mod+a', 'Select all'),
  editor('mod+f', 'Find'), editor('mod+g', 'Find next'), editor('mod+shift+g', 'Find previous'), editor('mod+d', 'Select next match'),
  editor('mod+b', 'Bold'), editor('mod+i', 'Italic'), editor('mod+/', 'Comment out lines'),
  editor('mod+[', 'Outdent'), editor('mod+]', 'Indent'), editor('mod+shift+k', 'Delete line'),
  // Plan §2.3: CodeMirror, the developer tools, the browser, macOS.
  editor('mod+shift+l', 'Select all matches'),
  ...['c', 'i', 'j'].map((k) => other(`mod+shift+${k}`, DEVTOOLS)),
  ...['a', 'b', 'd', 'o', 'p'].map((k) => other(`mod+shift+${k}`, BROWSER)),
  other('mod+shift+y', 'macOS (Stickies)', MAC),
  other('mod+shift+[', BROWSER), other('mod+shift+]', BROWSER),
  // The desktop app's menu accelerators (zoom, window, console); ⌘, is the Settings binding itself.
  other('mod+0', BROWSER), other('mod+=', BROWSER), other('mod+-', BROWSER),
  other('mod+m', 'macOS (minimise the window)', MAC), editor('mod+m', 'Tab moves focus', PC),
  other('mod+h', 'macOS (hide the app)', MAC), other('mod+h', BROWSER, PC),
  other('mod+`', "the desktop app's console"),
  // Fixed keys of the editor and the menus.
  editor('alt+shift+f', 'Format document'),
  other('shift+F10', 'the context menu', ALL, 'F10'),
];

/** The reservation that refuses `c` on this platform, if any. */
export function reservationFor(c: Chord, mac: boolean): Reservation | null {
  const id = chordId(c);
  const here = (p: readonly Platform[]) => (mac ? p.includes('mac') : p.includes('win') || p.includes('linux'));
  return RESERVATIONS.find((r) => here(r.platforms) && chordId(r.chord) === id) ?? null;
}
