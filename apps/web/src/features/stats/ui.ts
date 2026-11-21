import type { EditorView } from '@codemirror/view';

/**
 * The statistics UI's state (the picker and the paste offer), shared between
 * the editor code that opens them and the overlay that draws them. Plain
 * module state with listeners, read through useSyncExternalStore.
 */

export interface StatsUi {
  /** The picker is open for this page's editor. */
  picker: boolean;
  /** The editor whose last paste looks like test output. */
  offer: EditorView | null;
}

let ui: StatsUi = { picker: false, offer: null };
const listeners = new Set<() => void>();

function set(next: Partial<StatsUi>): void {
  ui = { ...ui, ...next };
  for (const l of [...listeners]) l();
}

export const getUi = (): StatsUi => ui;

export function subscribeUi(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const openPicker = (): void => set({ picker: true });
export const closePicker = (): void => set({ picker: false });

export const showOffer = (view: EditorView): void => set({ offer: view });
/** Clears the offer (only the one for `view`, when given). */
export function clearOffer(view?: EditorView): void {
  if (!view || ui.offer === view) set({ offer: null });
}
