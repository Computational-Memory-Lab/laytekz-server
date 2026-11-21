/**
 * The References panel's pure logic (no DOM, no network), unit-tested from
 * apps/web/src/features/references/__tests__/pluginCore.test.ts.
 */

/** The text starts with a BibTeX entry (pasted from Google Scholar, a publisher or a .bib). */
export const looksLikeBibtex = (text) => /^\s*@[a-zA-Z]+\s*[{(]/.test(String(text || ''));

/** At least this many characters before a search runs by itself. */
export const MIN_SEARCH = 3;

const MISSING_PATTERNS = [
  // LaTeX and natbib: Citation `key' on page 1 undefined; biblatex: Citation 'key' on page 1 undefined
  /Citation [`'‘"]([^'’"`\s]+)['’"]\s+(?:on page \d+\s+)?undefined/g,
  // BibTeX: Warning--I didn't find a database entry for "key"
  /I didn't find a database entry for ["']([^"'\s]+)["']/g,
  // biber: WARN - I didn't find a database entry for 'key' (section 0)
  /didn't find a database entry for '([^'\s]+)'/g,
];

/**
 * The citation keys a typeset reported as undefined, in order of first
 * mention, from its problem list and its log.
 * @param {{ errors?: Array<{ message?: string }>, log?: string } | null | undefined} result
 */
export function undefinedCitations(result) {
  if (!result) return [];
  const texts = [...(result.errors || []).map((e) => String(e?.message || '')), String(result.log || '')];
  const seen = new Set();
  const out = [];
  for (const text of texts) {
    for (const re of MISSING_PATTERNS) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const key = m[1].replace(/[.,;]+$/, '');
        if (key && !seen.has(key)) { seen.add(key); out.push(key); }
      }
    }
  }
  return out;
}

/**
 * A search for the paper a citation key names: surname, year and any title
 * words the key carries (vaswani2017attention → "vaswani 2017 attention",
 * vaswaniAttentionAllYou2017 → "vaswani attention all you 2017").
 */
export function keyToQuery(key) {
  return String(key || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .replace(/[_\-:./+]+/g, ' ')
    // the collision suffix of smith2020a is not a word
    .replace(/\b(\d{4}) [a-z]\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** `bibtex` with its first entry's key replaced by `key`. */
export function setEntryKey(bibtex, key) {
  return String(bibtex || '').replace(/^(\s*@[a-zA-Z]+\s*[{(]\s*)([^,\s]*)(\s*,)/, (_m, a, _old, c) => `${a}${key}${c}`);
}

/** The key of the first entry in `bibtex`, or ''. */
export function entryKey(bibtex) {
  const m = /^\s*@[a-zA-Z]+\s*[{(]\s*([^,\s]*)\s*,/.exec(String(bibtex || ''));
  return m ? m[1] : '';
}

/** A citation key LaTeX accepts as typed (the server checks the same set). */
export const validKey = (key) => /^[^\s,{}"#%~\\]+$/.test(String(key || ''));

/** "Vaswani, Shazeer, Parmar et al." from a candidate's authors. */
export function authorLine(authors) {
  const list = (Array.isArray(authors) ? authors : String(authors || '').split(/\s+and\s+|;\s*/)).map((a) => String(a).trim()).filter(Boolean);
  if (list.length <= 3) return list.join(', ');
  return `${list.slice(0, 3).join(', ')} et al.`;
}

/** Authors · venue · year. */
export function byline(c) {
  return [authorLine(c?.authors), c?.venue, c?.year].filter((v) => v !== undefined && v !== null && String(v).trim() !== '').join(' · ');
}

/**
 * The small labels under a result: identifiers, preprint state, and the key
 * when the branch already has the paper.
 * @returns {Array<{ text: string, kind: 'id' | 'note' | 'project' | 'warn' }>}
 */
export function badges(c) {
  if (!c) return [];
  const out = [];
  if (c.inProject?.key) out.push({ text: `In project as ${c.inProject.key}`, kind: 'project' });
  if (c.doi) out.push({ text: 'DOI', kind: 'id' });
  if (c.arxiv) out.push({ text: 'arXiv', kind: 'id' });
  if (c.pmid) out.push({ text: 'PMID', kind: 'id' });
  if (c.isbn) out.push({ text: 'ISBN', kind: 'id' });
  if (c.preprint) out.push({ text: 'Preprint', kind: 'note' });
  if (c.publishedDoi) out.push({ text: 'Published version available', kind: 'note' });
  if (c.weak) out.push({ text: 'Check this match', kind: 'warn' });
  return out;
}

/** What the preview sends to identify a candidate: its pasted BibTeX, else its id. */
export function previewBody(c) {
  if (c?.bibtex) return { bibtex: c.bibtex };
  return { id: c?.id };
}

/** The .bib choices for "Add to": synced files are left out; others in path order, the default first. */
export function targetChoices(targets, def) {
  const list = (Array.isArray(targets) ? targets : []).filter((t) => t && !t.synced);
  return list.sort((a, b) => (a.path === def ? -1 : b.path === def ? 1 : a.path.localeCompare(b.path)));
}

/** The path the user typed for a new .bib, cleaned; '' when it is not one. */
export function newBibPath(text) {
  let p = String(text || '').trim().replace(/^\/+/, '').replace(/\\/g, '/');
  if (!p) return '';
  if (!/\.bib$/i.test(p)) p += '.bib';
  if (p.split('/').some((seg) => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))) return '';
  return p;
}

/** The toast after an add: what was written and what was cited. */
export function addedText({ key, bibFile, duplicate, cited, citeResult }) {
  const where = duplicate ? `${key} is in ${bibFile} already` : `Added ${key} to ${bibFile}`;
  if (!cited) return `${where}.`;
  if (citeResult === 'present') return `${where}; it is in this citation already.`;
  return `${where} and cited it.`;
}

/** The toast after Undo, saying which part could not be taken back. */
export function undoneText({ entry, cite }) {
  // null: that part was not tried (nothing was cited, or nothing was written)
  if (entry === false && cite === false) return 'Nothing was undone: the citation and the entry have both changed since.';
  if (entry === false) return `${cite ? 'Removed the citation. ' : ''}The entry has changed since it was added, so it stays in the .bib.`;
  if (cite === false) return `${entry ? 'Removed the entry. ' : ''}The citation has moved or changed since, so it stays in the text.`;
  if (entry && cite) return 'Removed the reference and its citation.';
  if (entry) return 'Removed the reference.';
  if (cite) return 'Removed the citation.';
  return 'Nothing to undo.';
}
