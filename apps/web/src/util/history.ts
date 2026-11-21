import type { LogEntry } from '../api';
import { isAgentAuthor } from './agentReview'; // Galley: V2 (WP42): Claude and Codex

/**
 * - `checkpoint`: a commit a person named (Save in History, a commit message);
 * - `agent`: an agent's (Claude's or Codex's);
 * - `autosave`: the edit debounce's, which no one named;
 * - `system`: one Aldine wrote and titled for a person's action (a merge, a
 *   replace, an undo, a deletion, the save before a branch).
 */
export type CommitKind = 'checkpoint' | 'agent' | 'autosave' | 'system';

export interface CommitView { entry: LogEntry; kind: CommitKind; title: string }

export type HistoryRow =
  | { kind: 'commit'; view: CommitView }
  | { kind: 'autosaves'; key: string; views: CommitView[]; files: string[]; fileCount: number };

/** Galley: V2 (WP42). The prefixes of the subjects the server writes for
 *  itself: the product's, and upstream's in projects made before. */
const SERVER_PREFIXES = ['laytekz: ', 'aldine: '];

/** Subjects Aldine writes under its own `aldine:` prefix, in words. */
const PREFIXED: Array<[RegExp, (m: RegExpExecArray, e: LogEntry) => string]> = [
  [/^autosave( on shutdown)?$/, () => 'Autosave'],
  [/^checkpoint before branching$/, () => 'Saved before starting a branch'],
  [/^checkpoint before merge$/, () => 'Saved before merging'],
  [/^checkpoint before revert$/, () => 'Saved before undoing'],
  [/^manual commit$/, () => 'Checkpoint'],
  [/^import assets$/, () => 'Imported the images and other files'],
  [/^publish to (.+)$/, (m) => `Saved before publishing to ${m[1]}`],
  [/^sync Zotero library into (.+)$/, (m) => `Synced the Zotero library into ${m[1]}`],
  [/^agent edit$/, (_m, e) => `${isAgentAuthor(e.author) ? e.author : 'Claude'}’s edit`], // Galley: V2 (WP42)
];

/** Subjects Aldine writes for a person's action, unprefixed. */
const SYSTEM = [
  /^Initial commit$/,
  /^Merge \S+ into \S+$/,
  /^Merge (remote-tracking )?branch '/,
  /^(Replace|Delete) (".*"|\/.*\/) (with ".*" )?in .+$/,
  /^Undo “.*”$/,
  /^Redo “.*”$/,
  /^Undo the project-wide (replace|delete)$/,
  /^Undo the deletion of .+$/,
  /^Revert ((Claude|Codex)’s edits|agent changes)$/, // Galley: V2 (WP42)
  /^Revert ".*"$/,
  /^Local changes before pull$/,
  /^Save before switching branch$/,
  /^Start branch \S+$/,
  /^Update before /,
];

/** The deletion commit the file route makes: `Delete <path>` or `Delete folder <path>`, holding only that removal. */
function isDeletion(e: LogEntry): boolean {
  const files = e.files ?? [];
  if (!files.length) return false;
  if (e.message.startsWith('Delete folder ')) {
    const dir = e.message.slice('Delete folder '.length);
    return files.every((f) => f.startsWith(`${dir}/`));
  }
  return files.length === 1 && e.message === `Delete ${files[0]}`;
}

export function describeCommit(entry: LogEntry): CommitView {
  const m = entry.message;
  // Galley: V2 (WP42): either prefix; any agent.
  const agent = isAgentAuthor(entry.author);
  const prefix = SERVER_PREFIXES.find((p) => m.startsWith(p));
  if (prefix) {
    const rest = m.slice(prefix.length);
    for (const [re, words] of PREFIXED) {
      const hit = re.exec(rest);
      if (hit) {
        const title = words(hit, entry);
        const kind: CommitKind = agent ? 'agent' : title === 'Autosave' ? 'autosave' : title === 'Checkpoint' ? 'checkpoint' : 'system';
        return { entry, kind, title };
      }
    }
    return { entry, kind: agent ? 'agent' : 'system', title: rest ? rest[0].toUpperCase() + rest.slice(1) : m };
  }
  if (agent) return { entry, kind: 'agent', title: m };
  if (SYSTEM.some((re) => re.test(m)) || isDeletion(entry)) return { entry, kind: 'system', title: m };
  return { entry, kind: 'checkpoint', title: m };
}

/** Autosaves further apart than this belong to different sittings. */
export const SITTING_GAP_MS = 30 * 60_000;

/**
 * The log as the History panel shows it: two or more autosaves in a row from
 * one sitting fold into one row naming every file they changed; everything
 * else stays a row of its own. `entries` is newest first, as the log is.
 */
export function historyRows(entries: LogEntry[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  let run: CommitView[] = [];
  const flush = () => {
    if (run.length === 1) rows.push({ kind: 'commit', view: run[0] });
    else if (run.length > 1) {
      const files = [...new Set(run.flatMap((v) => v.entry.files ?? []))];
      // A capped entry may hold more paths than it lists: the count is a floor then.
      const fileCount = Math.max(files.length, ...run.map((v) => v.entry.fileCount ?? 0));
      rows.push({ kind: 'autosaves', key: run[run.length - 1].entry.hash, views: run, files, fileCount });
    }
    run = [];
  };
  for (const e of entries) {
    const view = describeCommit(e);
    if (view.kind !== 'autosave') { flush(); rows.push({ kind: 'commit', view }); continue; }
    const prev = run[run.length - 1];
    if (prev && Math.abs(Date.parse(prev.entry.date) - Date.parse(e.date)) > SITTING_GAP_MS) flush();
    run.push(view);
  }
  flush();
  return rows;
}

/** "main.tex, refs.bib and 3 more" */
export function filesSummary(files: string[], total = files.length, shown = 2): string {
  if (!files.length) return '';
  const head = files.slice(0, shown).join(', ');
  const rest = Math.max(total, files.length) - Math.min(shown, files.length);
  return rest > 0 ? `${head} and ${rest} more` : head;
}
