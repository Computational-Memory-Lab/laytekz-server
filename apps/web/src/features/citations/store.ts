/**
 * Whether the citation picker is open, and for what. The `editor.overlay`
 * slot item (PickerHost) renders it; the command and the keybinding open it.
 */
import type { EditorPageCtx } from '../types';
import type { CiteFamily, ParsedCitation } from './citeCommands';

export interface PickerRequest {
  page: EditorPageCtx;
  /** 'edit': the caret was in a citation (or right after one). */
  mode: 'insert' | 'edit';
  /** The family the picker writes: the edited command's own, else the document's. */
  family: CiteFamily;
  /** The header text, e.g. "biblatex · APA". */
  familyLabel: string;
  /** The edited citation as it was when the picker opened. */
  citation: ParsedCitation | null;
  /** The initial query: the selected text, in insert mode. */
  query: string;
  /** The current file's citations, key → times cited. */
  cited: ReadonlyMap<string, number>;
  /** Bumped on every open, so a reopened picker starts afresh. */
  seq: number;
}

let current: PickerRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function openPicker(req: Omit<PickerRequest, 'seq'>): void {
  current = { ...req, seq: ++seq };
  emit();
}

export function closePicker(): void {
  if (!current) return;
  current = null;
  emit();
}

export function pickerRequest(): PickerRequest | null {
  return current;
}

export function subscribePicker(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
