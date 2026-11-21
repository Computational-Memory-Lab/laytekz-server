/** The picker's rows from the project's bibliography (pure). */
import type { BibEntry } from '../../api';
import { citeRank, surnames } from '../../editor/latexExtras';

/** WP15 adds `editor` (and line, doi …) to the server's entries; the web type predates it. */
export type Entry = BibEntry & { editor?: string };

export interface EntryRow {
  entry: Entry;
  /** Other .bib files that hold the same key. */
  alsoIn: string[];
  rank: number;
}

const plain = (s: string) => s.replace(/[{}]/g, '').trim();

/** An APA-like byline: "Smith (2020)", "Smith & Lee (2020)", "Smith et al. (2020)"; "n.d." without a year; the editors, else the title, without authors. */
export function apaByline(e: Entry): string {
  const year = e.year?.trim() || 'n.d.';
  const names = surnames(e.author || e.editor).map(plain).filter(Boolean);
  let who: string;
  if (names.length === 1) who = names[0];
  else if (names.length === 2) who = `${names[0]} & ${names[1]}`;
  else if (names.length > 2) who = `${names[0]} et al.`;
  else {
    const t = plain(e.title || e.key);
    who = t.length > 48 ? `${t.slice(0, 47)}…` : t;
  }
  return `${who} (${year})`;
}

/** Ranked rows for a query, one per key (duplicates say where else they are), best first, at most `limit`. */
export function rankEntries(entries: readonly Entry[], query: string, cited: ReadonlySet<string>, limit = 50): EntryRow[] {
  const byKey = new Map<string, EntryRow>();
  for (const entry of entries) {
    const known = byKey.get(entry.key);
    if (known) {
      if (entry.file !== known.entry.file && !known.alsoIn.includes(entry.file)) known.alsoIn.push(entry.file);
      continue;
    }
    byKey.set(entry.key, { entry, alsoIn: [], rank: 0 });
  }
  const rows: EntryRow[] = [];
  for (const row of byKey.values()) {
    row.rank = citeRank(row.entry, query, cited);
    if (row.rank > 0) rows.push(row);
  }
  // Ties keep the .bib order, which is the order people wrote them in.
  return rows.sort((a, b) => b.rank - a.rank).slice(0, limit);
}
