/**
 * Laytekz V2 editor-core contracts (WP01, frozen): automatic edits
 * (core/autoEdit.ts, WP08), key chains and mod-click (core/keyChains.ts and
 * core/modClick.ts, WP04).
 */
import type { ChangeSpec, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/** One local keystroke that inserted `char` over from..to (a single
 *  `input.type` transaction with one cursor). */
export interface TypedInput { char: string; from: number; to: number; before: EditorState; after: EditorState }

export interface AutoEditNotice { kind: string; text: string; settingId: string }

/** What a rule wants done after the keystroke. Positions are in `after`. */
export interface AutoEdit {
  rule: string;
  changes: ChangeSpec;
  selection?: { anchor: number; head?: number };
  /** Shown at most 3 times per `kind`, with a "Turn off" action that sets `settingId` to false. */
  notice?: AutoEditNotice;
}

/** A pure function of its input: no view, no DOM, no clock, no storage. The
 *  core skips a rule whose `getSetting(settingId)` is false. */
export interface AutoEditRule { id: string; priority: number; settingId: string; run(t: TypedInput): AutoEdit | null }

/** Rule priorities (higher runs first; the first non-null result wins). */
export const AUTO_EDIT_PRIORITY = { escape: 50, currencyGuard: 50, autoMath: 40, identifierUnderscore: 40 } as const;

export type ChainKey = 'Tab' | 'Shift-Tab' | 'Enter' | 'Backspace' | 'Escape' | 'Mod-ArrowRight';

/** One handler in a key's chain. `run` returns true when it handled the key;
 *  the chain then stops. */
export interface KeyChainEntry { key: ChainKey; priority: number; id: string; run(view: EditorView): boolean }

/** The key-chain priorities, highest first. Entries owned by WP04 itself:
 *  Tab completion 100 and indent 0, Escape completion 100. */
export const KEY_CHAIN_PRIORITY = {
  Tab: { completion: 100, fields: 90, statTrigger: 85, suggestion: 80, closerStepOut: 72, mathTabOut: 70, tableCell: 60, indent: 0 },
  Backspace: { autoEditRevert: 100, multiCharPair: 90, closeBracketsPair: 80 },
  Escape: { completion: 100, fields: 95, suggestion: 90, pinnedPreview: 85, highlightCard: 80 },
  Enter: { statFinish: 95, displaySplit: 90 },
  'Mod-ArrowRight': { suggestionWord: 80 },
} as const;

/** What a mod-click would follow: the span to underline while the modifier
 *  is held, and the hint ("Open https://…", "Go to \label{fig:x}"). `error`
 *  marks a target that is recognised but cannot be followed (shown, never run). */
export interface ModClickTarget { from: number; to: number; title: string; error?: string }

/** Higher priority is asked first; the first non-null target wins. `run`
 *  happens on `click` (user activation kept), or on Alt+Enter with a
 *  KeyboardEvent. */
export interface ModClickHandler {
  id: string;
  priority: number;
  target(view: EditorView, pos: number): ModClickTarget | null;
  run(view: EditorView, t: ModClickTarget, e: MouseEvent | KeyboardEvent): void;
}
