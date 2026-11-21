/**
 * Laytekz V2 keybinding contracts (WP01, frozen). The registry that serves
 * them is keys/registry.ts (WP04); util/shortcuts.ts keeps its exports and
 * delegates there, and overrides stay in localStorage 'aldine.shortcuts'.
 */
import type { Chord } from '../util/shortcuts';

export type { Chord };

/** `page`: a window keydown listener (bubble phase), skipped in text fields
 *  that are not the code editor. `page-capture`: the same in the capture
 *  phase, so it runs before CodeMirror and before the browser's own default.
 *  `editor`: only while the code editor has focus (a CodeMirror keydown handler). */
export type KeyScope = 'page' | 'page-capture' | 'editor';

export interface KeybindingDef {
  /** Unique; a feature's ids start with '<featureId>.'. The existing
   *  ShortcutIds (typeset, comment, jump, palette, search) keep their ids. */
  id: string;
  label: string;
  /** The Shortcuts section's group heading ("Citations", "Editor"). */
  group: string;
  /** null: unbound until someone records a chord. */
  default: Chord | null;
  changeable: boolean;
  scope: KeyScope;
  /** The CommandDef id it runs. */
  command: string;
  /** Match `code` (the physical key) instead of `key`: Option/Alt chords such as ⇧⌥A and ⌥\. */
  matchCode?: boolean;
  /** 'native-menu': the desktop app's menu owns the chord, so the web handler is skipped there. */
  desktop?: 'native-menu';
}

export interface ReservedChord { chord: Chord; owner: string; platforms: ('mac' | 'win' | 'linux')[] }
