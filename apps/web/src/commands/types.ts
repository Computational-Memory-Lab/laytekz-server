/**
 * Laytekz V2 command contracts (WP01, frozen). The adapter that turns them
 * into palette rows is commands/index.ts (WP04).
 */
import type { Command } from '../components/CommandPalette';
import type { EditorPageCtx } from '../features/types';

export type { Command };

export interface CommandDef extends Command {
  /** Hidden from a read-only showcase and/or from someone who may only view,
   *  like the ids in Editor.tsx's SHOWCASE_REFUSES and VIEWER_REFUSES. */
  refusedFor?: readonly ('showcase' | 'viewer')[];
  /** Listed only while this is true. */
  when?(p: EditorPageCtx): boolean;
  /** A KeybindingDef id; its current chord label becomes the row's `hint`. */
  keybinding?: string;
}
