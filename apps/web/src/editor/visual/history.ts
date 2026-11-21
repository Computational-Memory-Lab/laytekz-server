import { Facet, type EditorState, type Extension } from '@codemirror/state';

/** Ends the open undo step: the edits after it are undone apart from the ones before. A no-op without a history. */
export const undoBoundary = Facet.define<() => void, () => void>({
  combine: (fs) => fs[fs.length - 1] ?? (() => {}),
});

// Galley: V2 (WP05) the provider CodePane installs outside the mode
// compartment, so Source mode has the boundary too; Visual's copy stays and
// the facet keeps the last one.
/** Provides `undoBoundary` from the editor's undo history (Y.UndoManager's stopCapturing). */
export function undoBoundaryFrom(history: { stopCapturing(): void }): Extension {
  return undoBoundary.of(() => history.stopCapturing());
}

// Galley: V2 (WP05) the call a command makes before and after an edit that must be an undo step of its own.
/** Closes the open undo step of the editor `state` belongs to. */
export function closeUndoStep(state: EditorState): void {
  state.facet(undoBoundary)();
}
