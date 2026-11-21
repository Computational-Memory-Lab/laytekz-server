/**
 * Whether the cross-reference picker is open. The `editor.overlay` slot item
 * (RefPickerHost) renders it; the command and the keybinding open it.
 */
import type { EditorPageCtx } from '../types';

export interface RefPickerRequest {
  page: EditorPageCtx;
  /** The initial query: the selected text. */
  query: string;
  /** The open file, for "this file" rows. */
  file: string;
  /** Bumped on every open, so a reopened picker starts afresh. */
  seq: number;
}

let current: RefPickerRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function openRefPicker(req: Omit<RefPickerRequest, 'seq'>): void {
  current = { ...req, seq: ++seq };
  emit();
}

export function closeRefPicker(): void {
  if (!current) return;
  current = null;
  emit();
}

export function refPickerRequest(): RefPickerRequest | null {
  return current;
}

export function subscribeRefPicker(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
