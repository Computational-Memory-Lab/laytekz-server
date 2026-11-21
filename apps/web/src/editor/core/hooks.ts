/**
 * Late-bound editor hooks (WP05 editor-host). They let wave-1+ features change
 * what CodePane and Editor.tsx do without editing them.
 */
import type { EditorState } from '@codemirror/state';
import { fileSpots, type SpotStore } from '../fileSpots';
import { closeParkedDocs } from '../docCache';

/** The citation command for the document at hand, without the backslash
 *  ('parencite', 'citep'); null lets the next resolver, then the default 'cite', decide. */
export type CiteCommandResolver = (state: EditorState, filePath: string) => string | null;

/** A command name insertCitation can write: letters (and @), an optional star. */
const COMMAND_NAME = /^[A-Za-z@]+\*?$/;

/** Most recently set first: a later resolver is asked before an earlier one. */
const resolvers: CiteCommandResolver[] = [];

/** CodePane's insertCitation (and the plugin API's) asks it which command to
 *  insert; the citations feature (WP19) sets it. Returns the removal. */
export function setCiteCommandResolver(fn: CiteCommandResolver): () => void {
  resolvers.unshift(fn);
  return () => {
    const at = resolvers.indexOf(fn);
    if (at >= 0) resolvers.splice(at, 1);
  };
}

/** What insertCitation uses: the resolver's answer, else 'cite'. A resolver
 *  that throws or answers something that is not a command name is skipped. */
export function citeCommandFor(state: EditorState, filePath: string): string {
  for (const fn of [...resolvers]) {
    let name: string | null;
    try {
      name = fn(state, filePath);
    } catch (err) {
      console.warn('[editor] a citation command resolver failed', err);
      continue;
    }
    if (name == null) continue;
    const bare = name.startsWith('\\') ? name.slice(1) : name;
    if (COMMAND_NAME.test(bare)) return bare;
  }
  return 'cite';
}

/** The collab doc name of a file, as CodePane and editor/docCache key it. */
export const docNameOf = (projectId: string, branch: string, path: string) => `${projectId}::${branch}::${path}`;

/** Where `path` is after `moves`: a move of a file, or of a folder holding it; null when none moved it. */
export function movedPath(path: string, moves: readonly (readonly [string, string])[]): string | null {
  for (const [from, to] of moves) {
    if (!from || from === to) continue;
    if (path === from) return to;
    if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  }
  return null;
}

/** What onFilesMoved changes (editor/fileSpots and editor/docCache), injectable for tests. */
export interface MoveTargets {
  spots: Pick<SpotStore, 'get' | 'set'>;
  /** Closes every parked doc `keep` refuses; `keep` sees every parked doc's name. */
  closeParked(keep: (name: string) => boolean): void;
}

const defaultTargets: MoveTargets = { spots: fileSpots, closeParked: closeParkedDocs };

/**
 * Editor-side state that follows moved files: file spots and parked docs.
 * Editor.tsx calls it for every `filesMoved` page event, after remapping its
 * own active file. Moves are [from, to] paths in the branch (a folder's move
 * carries the files under it).
 */
export function onFilesMoved(projectId: string, branch: string, moves: readonly (readonly [string, string])[]): void {
  applyFilesMoved(projectId, branch, moves, defaultTargets);
}

/**
 * onFilesMoved over given targets. A parked doc of a moved file is closed,
 * never renamed: its connection is to the old name, and the moved file opens
 * afresh from the server's copy of its doc (a doc is never reseeded from plain
 * text). Its spot is copied to the new name, so the file opens where it was
 * left. The spot store cannot be listed, so a folder's move carries the spots
 * of the moved paths named and of the parked docs under it.
 */
export function applyFilesMoved(projectId: string, branch: string, moves: readonly (readonly [string, string])[], targets: MoveTargets): void {
  if (!moves.length) return;
  const prefix = docNameOf(projectId, branch, '');
  const pathOf = (name: string) => (name.startsWith(prefix) ? name.slice(prefix.length) : null);
  const paths = new Set<string>();
  for (const [from] of moves) paths.add(from);
  targets.closeParked((name) => {
    const p = pathOf(name);
    if (p != null) paths.add(p);
    return true;
  });
  for (const from of paths) {
    const to = movedPath(from, moves);
    if (to == null) continue;
    const spot = targets.spots.get(docNameOf(projectId, branch, from));
    if (spot && !targets.spots.get(docNameOf(projectId, branch, to))) targets.spots.set(docNameOf(projectId, branch, to), spot);
  }
  targets.closeParked((name) => {
    const p = pathOf(name);
    return p == null || movedPath(p, moves) == null;
  });
}
