/**
 * The settings page's search (WP23): which sections and rows stay on screen
 * for what is typed. Pure, over util/paletteRank's matchScore, so the rules
 * are unit-tested without a DOM.
 *
 * A row matches on its label or its keywords; a section whose title matches
 * shows whole. Blocks the page embeds (the project's rows, the account, the
 * connections, the shortcuts) are searched through their own terms and shown
 * whole when one of them matches.
 */
import { matchScore } from '../../util/paletteRank';
import type { SectionId } from '../../settings/types';
import type { PageSection } from './model';

/**
 * Scores under this are a match: a word, the start of a word or the inside
 * of a word of the label, every word of the query in the label, a whole
 * keyword, or the start of a keyword. The palette's scattered-letter match
 * (a score from 100) is left out: on a page of settings it only adds noise.
 */
export const MATCH_LIMIT = 60;

export function matches(query: string, title: string, keywords?: string): boolean {
  const s = matchScore(query, title, keywords);
  return s !== null && s < MATCH_LIMIT;
}

/** The words an embedded block answers to, by section. */
export const EMBEDDED_TERMS: Readonly<Partial<Record<SectionId, readonly string[]>>> = {
  account: ['Your name', 'Email', 'Name', 'ORCID iD', 'Sign-in methods', 'Commit email', 'Password'],
  connections: ['Claude and ChatGPT', 'Access tokens', 'GitHub, GitLab and Gitea', 'Personal templates', 'Zotero key'],
  project: ['Project name', 'Main document', 'Compiler', 'TeX Live', 'Stop on first error', 'Commit changes'],
  desktop: ['Desktop app settings', 'Server address', 'Open at login', 'Page zoom', 'Spelling languages'],
};

export interface FilteredSection extends PageSection {
  /** The embedded block is on screen (always, with nothing typed). */
  embeddedShown: boolean;
}

export interface SearchResult {
  sections: FilteredSection[];
  /** Matching rows and embedded terms, for "4 settings match". */
  count: number;
}

/**
 * The page's sections for `query`. `termsOf` gives a section's embedded
 * terms (EMBEDDED_TERMS, plus the shortcut labels the page knows).
 */
export function searchSections(sections: readonly PageSection[], query: string, termsOf: (id: SectionId) => readonly string[]): SearchResult {
  if (!query.trim()) return { sections: sections.map((s) => ({ ...s, embeddedShown: s.embedded })), count: 0 };
  const out: FilteredSection[] = [];
  let count = 0;
  for (const s of sections) {
    const terms = s.embedded ? termsOf(s.def.id) : [];
    if (matches(query, s.def.title)) {
      out.push({ ...s, embeddedShown: s.embedded });
      count += s.rows.length + s.automatic.length + terms.length;
      continue;
    }
    const hit = (d: PageSection['rows'][number]) => matches(query, d.label, d.keywords);
    const rows = s.rows.filter(hit);
    const automatic = s.automatic.filter(hit);
    const termHits = terms.filter((t) => matches(query, t)).length;
    if (!rows.length && !automatic.length && !termHits) continue;
    out.push({ ...s, rows, automatic, embeddedShown: termHits > 0 });
    count += rows.length + automatic.length + termHits;
  }
  return { sections: out, count };
}

/** The live region's sentence. */
export function countText(query: string, count: number): string {
  if (!query.trim()) return '';
  if (!count) return `No settings match “${query.trim()}”`;
  return count === 1 ? '1 setting matches' : `${count} settings match`;
}
