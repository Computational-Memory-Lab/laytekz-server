/**
 * Libraries (F8, F20): the pure parts. What a linked library looks like on the
 * wire (WP35's frozen contract, read tolerantly because both sides were built
 * at the same time), the read-only banner for a synced .bib, default file
 * names, and the citation-key rewrite behind "Update citations".
 */

export type LibraryProvider = 'zotero' | 'mendeley' | 'desktop-file' | 'url';

/** One entry of GET /api/projects/:id/libraries. */
export interface LibraryLink {
  id: string;
  provider: LibraryProvider | string;
  linkedBy: string | null;
  /** The linker's display name when the server sends one. */
  linkedByName: string | null;
  libraryName: string | null;
  collectionName: string | null;
  bibFile: string;
  recursive: boolean;
  lastSyncedAt: string | null;
  pausedReason: string | null;
}

/** A key that changed between two syncs. */
export interface KeyRename { from: string; to: string }

export const PROVIDER_LABEL: Record<string, string> = {
  zotero: 'Zotero',
  mendeley: 'Mendeley',
  'desktop-file': 'a file on a computer',
  url: 'a web link',
};

export const providerLabel = (p: string): string => PROVIDER_LABEL[p] ?? p;

/** At most this many links per project (plan F8). */
export const MAX_LINKS = 5;

/** A sync on open when the last one is older than this. */
export const STALE_SECONDS = 3600;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Project paths compare without a leading './' or '/'. */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/** The list from GET /api/projects/:id/libraries: an array, or `{links}` / `{libraries}`. Bad rows are dropped. */
export function normalizeLinks(raw: unknown): LibraryLink[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? ((raw as { links?: unknown }).links ?? (raw as { libraries?: unknown }).libraries)
      : null;
  if (!Array.isArray(list)) return [];
  const out: LibraryLink[] = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = str(o.id);
    const bibFile = str(o.bibFile);
    if (!id || !bibFile) continue;
    out.push({
      id,
      provider: str(o.provider) ?? 'zotero',
      linkedBy: str(o.linkedBy),
      linkedByName: str(o.linkedByName) ?? str(o.linkerName),
      libraryName: str(o.libraryName),
      collectionName: str(o.collectionName),
      bibFile: normPath(bibFile),
      recursive: o.recursive !== false,
      lastSyncedAt: str(o.lastSyncedAt),
      pausedReason: str(o.pausedReason),
    });
  }
  return out;
}

/** A job's `renamedKeys`: `[{from,to}]`, `[[from,to]]` or `{from: to}`. Identity and bad pairs are dropped. */
export function normalizeRenames(raw: unknown): KeyRename[] {
  const pairs: [unknown, unknown][] = Array.isArray(raw)
    ? raw.map((r) => (Array.isArray(r) ? [r[0], r[1]] : r && typeof r === 'object' ? [(r as { from?: unknown }).from, (r as { to?: unknown }).to] : [null, null]))
    : raw && typeof raw === 'object' ? Object.entries(raw as Record<string, unknown>) : [];
  const seen = new Set<string>();
  const out: KeyRename[] = [];
  for (const [f, t] of pairs) {
    if (typeof f !== 'string' || typeof t !== 'string') continue;
    const from = f.trim();
    const to = t.trim();
    if (!from || !to || from === to || seen.has(from) || /[\s,{}]/.test(from + to)) continue;
    seen.add(from);
    out.push({ from, to });
  }
  return out;
}

/** "Ana's library › Thesis", or what the link has of it. */
export function linkSource(l: Pick<LibraryLink, 'libraryName' | 'collectionName' | 'linkedByName'>): string {
  const lib = l.libraryName ?? (l.linkedByName ? `${l.linkedByName}’s library` : 'the library');
  return l.collectionName ? `${lib} › ${l.collectionName}` : lib;
}

/** The link that writes `path`, if any. */
export function linkForFile(links: readonly LibraryLink[], path: string | null): LibraryLink | null {
  if (!path) return null;
  const p = normPath(path);
  return links.find((l) => l.bibFile === p) ?? null;
}

/** The read-only banner for a synced file, or null when `path` is not one. */
export function linkedBibReason(links: readonly LibraryLink[], path: string | null): string | null {
  const l = linkForFile(links, path);
  if (!l) return null;
  if (l.provider === 'desktop-file') {
    const who = l.linkedByName ? `${l.linkedByName}’s computer` : 'a computer';
    return `Linked to a .bib on ${who}, so it opens read-only: each change there replaces this file. Edit the file on that computer.`;
  }
  if (l.provider === 'url') return 'Synced from a web link, so it opens read-only: each sync replaces this file.';
  const name = providerLabel(l.provider);
  return `Synced from ${name} (${linkSource(l)}), so it opens read-only: each sync replaces this file. Change entries in ${name}, then sync.`;
}

/** The default file for a new link: `<provider>.bib` next to the root file, else `<provider>-<first name>.bib`, else numbered. */
export function defaultBibFile(provider: string, taken: Iterable<string>, firstName: string | null, rootFile: string | null): string {
  const dir = rootFile && rootFile.includes('/') ? rootFile.slice(0, rootFile.lastIndexOf('/') + 1) : '';
  const used = new Set([...taken].map(normPath));
  const base = provider.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'library';
  const slug = (firstName ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const candidates = [`${base}.bib`, ...(slug ? [`${base}-${slug}.bib`] : [])];
  for (const c of candidates) if (!used.has(dir + c)) return dir + c;
  for (let i = 2; ; i++) {
    const c = `${dir}${base}${slug ? `-${slug}` : ''}-${i}.bib`;
    if (!used.has(c)) return c;
  }
}

/** A file name a link may write: a relative path ending in .bib, no '..'. */
export function validBibFile(p: string): boolean {
  const n = normPath(p.trim());
  return /\.bib$/i.test(n) && !n.split('/').some((s) => s === '..' || s === '') && !/[\0:*?"<>|]/.test(n);
}

/** \cite, \citep, \parencite, \textcite, \autocite, \cites, \nocite, … with an optional star. */
const CITE_RE = /\\([A-Za-z]*cite[A-Za-z]*|nocite)\*?/g;

interface KeySpan { key: string; from: number; to: number }

/** Every key inside a citation command's braces, with its offsets. Comments are skipped. */
export function citeKeySpans(text: string): KeySpan[] {
  const spans: KeySpan[] = [];
  const commentAt = commentStarts(text);
  CITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_RE.exec(text))) {
    if (inComment(commentAt, text, m.index)) continue;
    let i = m.index + m[0].length;
    // Optional [..] and mandatory {..} groups, as many as follow (\cites{a}[p]{b}).
    for (;;) {
      while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
      const open = text[i];
      if (open !== '[' && open !== '{') break;
      const close = open === '[' ? ']' : '}';
      let depth = 0;
      let j = i;
      for (; j < text.length; j++) {
        const c = text[j];
        if (c === '\\') { j++; continue; }
        if (c === open) depth++;
        else if (c === close && --depth === 0) break;
        if (c === '\n' && text[j + 1] === '\n') { j = -1; break; } // a paragraph break ends the command
      }
      if (j < 0 || j >= text.length) break;
      if (open === '{') {
        let k = i + 1;
        for (const part of text.slice(i + 1, j).split(',')) {
          const lead = part.length - part.trimStart().length;
          const key = part.trim();
          if (key) spans.push({ key, from: k + lead, to: k + lead + key.length });
          k += part.length + 1;
        }
      }
      i = j + 1;
    }
    CITE_RE.lastIndex = Math.max(CITE_RE.lastIndex, i);
  }
  return spans;
}

/** Line start → offset of its first unescaped %, for comment checks. */
function commentStarts(text: string): Map<number, number> {
  const at = new Map<number, number>();
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') { lineStart = i + 1; continue; }
    if (text[i] === '%' && !at.has(lineStart)) {
      let bs = 0;
      for (let j = i - 1; j >= lineStart && text[j] === '\\'; j--) bs++;
      if (bs % 2 === 0) at.set(lineStart, i);
    }
  }
  return at;
}

function inComment(at: Map<number, number>, text: string, pos: number): boolean {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const c = at.get(lineStart);
  return c !== undefined && c < pos;
}

/** How many citations of the old keys `text` holds. */
export function countRenamed(text: string, renames: readonly KeyRename[]): number {
  const from = new Set(renames.map((r) => r.from));
  return citeKeySpans(text).filter((s) => from.has(s.key)).length;
}

/** The edits that rename cited keys in `text`; null when there is nothing to change. */
export function renameCiteKeys(text: string, renames: readonly KeyRename[]): Array<{ from: number; to: number; insert: string }> | null {
  const map = new Map(renames.map((r) => [r.from, r.to]));
  const changes = citeKeySpans(text)
    .filter((s) => map.has(s.key))
    .map((s) => ({ from: s.from, to: s.to, insert: map.get(s.key)! }));
  return changes.length ? changes : null;
}

/** "smith2020 → smithAttention2020, …" for a notice, the first `max` pairs. */
export function renameSummary(renames: readonly KeyRename[], max = 3): string {
  const shown = renames.slice(0, max).map((r) => `${r.from} → ${r.to}`).join(', ');
  return renames.length > max ? `${shown}, and ${renames.length - max} more` : shown;
}

/** A job is over: finished or failed. */
export function jobFinished(state: unknown): 'done' | 'failed' | null {
  if (typeof state !== 'string') return null;
  if (/^(done|ok|finished|complete|completed|succeeded|success|synced|unchanged)$/i.test(state)) return 'done';
  if (/^(error|failed|failure|cancelled|canceled|paused)$/i.test(state)) return 'failed';
  return null;
}
