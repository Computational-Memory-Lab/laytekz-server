/**
 * What a ⌘/Ctrl-click at a spot of a source line points at (WP20, feature 18).
 * Pure and line-local, so it runs on every pointer move over the hovered line
 * and is tested without an editor.
 *
 * Every collaborator writes the sources, so an address found here is
 * untrusted: it goes through safeLinkUrl (http, https and mailto only, no
 * credentials) before it can become a link at all.
 */
import { safeLinkUrl } from '../../util/pdfLinks';

/** How a file is read: TeX (commands, `%` comments), BibTeX fields, or plain text (bare addresses only). */
export type LinkMode = 'tex' | 'bib' | 'plain';

/** Offsets are relative to the line's start; `to` is exclusive. */
export type LinkHit =
  /** A web or mail address, safe to open. */
  | { kind: 'url'; from: number; to: number; href: string }
  /** A project file a command reads; `fallbackHref` is what a relative \href opens when no such file exists. */
  | { kind: 'file'; from: number; to: number; name: string; command: string; fallbackHref?: string }
  /** A package, class or style: the project's own file, else its CTAN page. */
  | { kind: 'package'; from: number; to: number; name: string; command: string }
  /** A cross-reference key (\ref, \cref, \hyperref[…]). */
  | { kind: 'ref'; from: number; to: number; key: string }
  /** A citation key (\cite and its family). */
  | { kind: 'cite'; from: number; to: number; key: string }
  /** A key's definition (\label, \bibitem, a .bib entry's own key): its references are what to find. */
  | { kind: 'label'; from: number; to: number; key: string; bib?: boolean }
  /** An entry a .bib field names (crossref, xdata, related). */
  | { kind: 'bibkey'; from: number; to: number; key: string };

export interface FindOptions {
  /** A .bib entry's field around the line (eprinttype, archiveprefix), lower case, for eprint. */
  field?(name: string): string | null;
}

// ---- Unescaping ----

/** TeX escapes undone, as a URL means them: `\_` → `_`, `\%` → `%`, `\~{}` → `~`, … Percent-encoding stays. */
export function unescapeTex(s: string): string {
  return s
    .replace(/\\(?:textasciitilde|~)(?:\{\})?|\\string~/g, '~')
    .replace(/\\textunderscore(?:\{\})?/g, '_')
    .replace(/\\([%#&_${}])/g, '$1')
    .replace(/\{\}/g, '');
}

// ---- Addresses and identifiers ----

const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
/** A host without a scheme (`www.x.org/a`, `example.org`): opened as https. */
const HOST_LIKE = /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?(?:[/?#]|$)/;
/** A host followed by a path: what a relative \href may still mean when no project file has its name. */
const HOST_PATH = /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?\//;

/** A delimited address (\url, \href, a .bib url field): the whole value, unescaped; null if it may not open. */
export function addressHref(raw: string): string | null {
  const text = unescapeTex(raw.trim());
  if (!text) return null;
  if (HAS_SCHEME.test(text)) return safeLinkUrl(text);
  if (/^www\./i.test(text) || HOST_LIKE.test(text)) return safeLinkUrl(`https://${text}`);
  return null;
}

const DOI_RE = /^10\.\d{4,9}\/\S+$/;

/** https://doi.org/<doi>, with `#` and `?` percent-encoded; null for something that is no DOI. */
export function doiHref(raw: string): string | null {
  let doi = unescapeTex(raw.trim());
  doi = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  if (!DOI_RE.test(doi)) return null;
  return safeLinkUrl(`https://doi.org/${encodeURI(doi).replace(/#/g, '%23').replace(/\?/g, '%3F')}`);
}

const ARXIV_ID = /^(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/;

export function arxivHref(raw: string): string | null {
  const id = unescapeTex(raw.trim()).replace(/^arxiv:\s*/i, '');
  return ARXIV_ID.test(id) ? safeLinkUrl(`https://arxiv.org/abs/${id}`) : null;
}

export function orcidHref(raw: string): string | null {
  const id = raw.trim().replace(/^https?:\/\/orcid\.org\//i, '');
  return /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(id) ? `https://orcid.org/${id}` : null;
}

export function pubmedHref(raw: string): string | null {
  const id = raw.trim();
  return /^\d{1,9}$/.test(id) ? `https://pubmed.ncbi.nlm.nih.gov/${id}/` : null;
}

/** An eprint field: arXiv by its type or prefix (or an id that can only be arXiv's), PubMed, JSTOR, handles. */
export function eprintHref(raw: string, type: string | null): string | null {
  const t = (type ?? '').toLowerCase();
  if (t === 'pubmed') return pubmedHref(raw);
  if (t === 'jstor') return /^\d+$/.test(raw.trim()) ? `https://www.jstor.org/stable/${raw.trim()}` : null;
  if (t === 'hdl' || t === 'handle') return /^[\w.-]+\/\S+$/.test(raw.trim()) ? safeLinkUrl(`https://hdl.handle.net/${encodeURI(raw.trim())}`) : null;
  if (t === 'arxiv' || !t) return arxivHref(raw);
  return null;
}

// ---- Bare addresses in text ----

const URL_CHAR = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%\p{L}\p{N}]/u;
const TRAIL = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '”', '’', '»', '…']);
const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c);

/**
 * Where a bare address starting at `start` ends (exclusive). It stops at
 * whitespace, `{ } < > " | ^` and a backtick, a command or `\\`, and in TeX
 * text at an unescaped `%` (a comment starts there) and `~` (a tie). TeX
 * escapes (`\_`, `\%`, `\~{}`) are part of it.
 */
function walk(line: string, start: number, texText: boolean, escapes: boolean): number {
  let j = start;
  while (j < line.length) {
    const c = line[j];
    if (c === '\\') {
      if (!escapes) break;
      const nx = line[j + 1];
      if (nx && '%#&_${}'.includes(nx)) { j += 2; continue; }
      if (nx === '~') { j += line.startsWith('{}', j + 2) ? 4 : 2; continue; }
      const m = /^\\(?:textasciitilde|textunderscore)(?:\{\})?|^\\string~/.exec(line.slice(j, j + 24));
      if (m) { j += m[0].length; continue; }
      break;
    }
    if (/\s/.test(c) || '{}<>"|^`'.includes(c)) break;
    if (texText && (c === '%' || c === '~')) break;
    if (!URL_CHAR.test(c)) break;
    j++;
  }
  return j;
}

const count = (s: string, c: string) => s.split(c).length - 1;

/** Prose punctuation after an address is not part of it; a closing bracket only when unbalanced inside it. */
function trimTrailing(s: string): string {
  for (;;) {
    const last = s[s.length - 1];
    if (last === undefined) return s;
    if (TRAIL.has(last) && !s.endsWith('\\' + last)) { s = s.slice(0, -1); continue; }
    if (last === ')' && count(s, '(') < count(s, ')')) { s = s.slice(0, -1); continue; }
    if (last === ']' && count(s, '[') < count(s, ']')) { s = s.slice(0, -1); continue; }
    return s;
  }
}

interface Bare { from: number; to: number; href: string | null }

/** Every bare address and identifier on a line, in order, with what each opens (null: refused). */
export function bareLinks(line: string, mode: LinkMode, comment = -1): Bare[] {
  const out: Bare[] = [];
  // .bib values are TeX too (escapes), but only a .tex line has comments and ties.
  const texFile = mode !== 'plain';
  const lower = line.toLowerCase();
  let i = 0;
  while (i < line.length) {
    const prevWord = isWordChar(line[i - 1]);
    const texText = mode === 'tex' && (comment < 0 || i < comment);
    let found: Bare | null = null;
    if (!prevWord) {
      const rest = lower.slice(i, i + 8);
      if (rest.startsWith('http://') || rest.startsWith('https://') || rest.startsWith('mailto:') || rest.startsWith('www.')) {
        const raw = trimTrailing(line.slice(i, walk(line, i, texText, texFile)));
        const text = unescapeTex(raw);
        const href = /^www\./i.test(text) ? safeLinkUrl(`https://${text}`) : safeLinkUrl(text);
        if (raw.length > 4) found = { from: i, to: i + raw.length, href };
      } else if (rest.startsWith('doi:')) {
        let v = i + 4;
        while (line[v] === ' ') v++;
        const raw = trimTrailing(line.slice(v, walk(line, v, texText, texFile)));
        if (raw) found = { from: i, to: v + raw.length, href: doiHref(raw) };
      } else if (rest.startsWith('arxiv:')) {
        let v = i + 6;
        while (line[v] === ' ') v++;
        const m = /^(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/.exec(line.slice(v));
        if (m) found = { from: i, to: v + m[0].length, href: arxivHref(m[0]) };
      } else if (line.startsWith('10.', i) && line[i - 1] !== '.' && line[i - 1] !== '/' && /^10\.\d{4,9}\//.test(line.slice(i, i + 16))) {
        const raw = trimTrailing(line.slice(i, walk(line, i, texText, texFile)));
        found = { from: i, to: i + raw.length, href: doiHref(raw) };
      }
    }
    if (found && found.to > found.from) {
      out.push(found);
      i = found.to;
    } else i++;
  }
  return out;
}

// ---- Commands ----

interface Group { open: string; from: number; to: number; end: number; closed: boolean }

const CLOSER: Record<string, string> = { '{': '}', '[': ']', '<': '>' };

/** A `{…}`, `[…]` or `<…>` group starting at `i`: content span, balanced braces, escapes skipped. An
 *  unescaped `%` ends the line (a comment) unless `literalPercent` (\url's argument). */
function readGroup(line: string, i: number, literalPercent: boolean): Group {
  const open = line[i];
  const close = CLOSER[open];
  let depth = 0;
  for (let j = i + 1; j < line.length; j++) {
    const c = line[j];
    if (c === '\\') { j++; continue; }
    if (c === '%' && !literalPercent) return { open, from: i + 1, to: j, end: j, closed: false };
    if (c === '{') depth++;
    else if (c === '}') {
      if (depth === 0 && open === '{') return { open, from: i + 1, to: j, end: j + 1, closed: true };
      depth--;
    } else if (c === close && depth <= 0) return { open, from: i + 1, to: j, end: j + 1, closed: true };
  }
  return { open, from: i + 1, to: line.length, end: line.length, closed: false };
}

/** The argument groups right after a command name (spaces allowed between them). */
function readArgs(line: string, i: number, o: { angle?: boolean; literalFirst?: boolean; max?: number } = {}): { args: Group[]; end: number } {
  const args: Group[] = [];
  let j = i;
  while (args.length < (o.max ?? 6)) {
    let k = j;
    while (line[k] === ' ' || line[k] === '\t') k++;
    const c = line[k];
    if (c !== '{' && c !== '[' && !(c === '<' && o.angle)) break;
    const literal = !!o.literalFirst && c === '{' && !args.some((a) => a.open === '{');
    const g = readGroup(line, k, literal);
    args.push(g);
    j = g.end;
    if (!g.closed) break;
  }
  return { args, end: j };
}

interface Item { text: string; from: number; to: number }

/** The comma-separated item of a group under `col` (the first one when `col` is outside its content). */
function itemAt(line: string, g: Group, col: number): Item | null {
  const items: Item[] = [];
  let start = g.from;
  for (let j = g.from; j <= g.to; j++) {
    if (j === g.to || line[j] === ',') {
      const raw = line.slice(start, j);
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      if (text) items.push({ text, from: start + lead, to: start + lead + text.length });
      start = j + 1;
    }
  }
  if (!items.length) return null;
  if (col >= g.from && col <= g.to) {
    for (const it of items) if (col >= it.from && col <= it.to) return it;
    // On a comma or a space: the key before it.
    let best: Item = items[0];
    for (const it of items) if (it.from <= col) best = it;
    return best;
  }
  return items[0];
}

const mandatory = (args: Group[]) => args.filter((a) => a.open === '{');

const URL_COMMANDS = new Set(['url', 'nolinkurl']);
const FILE_COMMANDS = new Set([
  'input', 'include', 'subfile', 'includegraphics', 'includepdf', 'includestandalone', 'lstinputlisting',
  'verbatiminput', 'VerbatimInput', 'addbibresource', 'addglobalbib', 'bibliography', 'includeonly',
]);
/** Two arguments, a folder then a file. */
const IMPORT_COMMANDS = new Set(['import', 'subimport', 'inputfrom', 'subinputfrom', 'includefrom', 'subincludefrom']);
const PACKAGE_COMMANDS = new Set(['usepackage', 'RequirePackage', 'documentclass', 'LoadClass', 'bibliographystyle']);
const REF_NAME = /^[A-Za-z]*(?:ref|refrange)$/;
const NOT_REF = new Set(['href', 'hyperref']);
const CITE_NAME = /^[A-Za-z]*[cC]ite[A-Za-z]*$/;
const NOT_CITE = new Set(['citetext']);

function urlCommandHit(raw: string, from: number, to: number): LinkHit | null {
  const href = addressHref(raw);
  return href ? { kind: 'url', from, to, href } : null;
}

/**
 * The hit of one command whose span holds `col`. `undefined`: this command
 * is not one that links (keep looking); `null`: it is, but leads nowhere
 * (a refused address), so nothing under the pointer opens.
 */
function commandHit(line: string, name: string, start: number, nameEnd: number, col: number): { hit: LinkHit | null | undefined; end: number } {
  if (URL_COMMANDS.has(name)) {
    const { args, end } = readArgs(line, nameEnd, { literalFirst: true, max: 1 });
    const g = mandatory(args)[0];
    if (!g || col < start || col > end) return { hit: undefined, end };
    return { hit: urlCommandHit(line.slice(g.from, g.to), start, end), end };
  }
  if (name === 'href') {
    const { args, end } = readArgs(line, nameEnd, { literalFirst: true, max: 3 });
    const g = mandatory(args)[0];
    if (!g || col < start || col > end) return { hit: undefined, end };
    const raw = line.slice(g.from, g.to).trim();
    const text = unescapeTex(raw);
    if (text && !HAS_SCHEME.test(text) && !/^www\./i.test(text) && !text.startsWith('#') && !text.startsWith('/')) {
      // A relative \href names a file beside the PDF (`x.pdf`), or a host and path without the scheme (`x.org/a`).
      const fallbackHref = HOST_PATH.test(text) ? safeLinkUrl(`https://${text}`) ?? undefined : undefined;
      return { hit: { kind: 'file', from: start, to: end, name: text, command: 'href', ...(fallbackHref ? { fallbackHref } : {}) }, end };
    }
    return { hit: urlCommandHit(raw, start, end), end };
  }
  if (name === 'doi' || name === 'orcidlink' || name === 'orcid') {
    const { args, end } = readArgs(line, nameEnd, { literalFirst: true, max: 1 });
    const g = mandatory(args)[0];
    if (!g || col < start || col > end) return { hit: undefined, end };
    const raw = line.slice(g.from, g.to);
    const href = name === 'doi' ? doiHref(raw) : orcidHref(raw);
    return { hit: href ? { kind: 'url', from: start, to: end, href } : null, end };
  }
  const isRef = REF_NAME.test(name) && !NOT_REF.has(name);
  const isCite = (CITE_NAME.test(name) && !NOT_CITE.has(name)) || name === 'nocite';
  if (isRef || isCite || name === 'label' || name === 'bibitem') {
    const { args, end } = readArgs(line, nameEnd, { angle: isCite });
    const groups = mandatory(args);
    if (!groups.length || col < start || col > end) return { hit: undefined, end };
    const g = groups.find((a) => col >= a.from && col <= a.to) ?? groups[0];
    const it = itemAt(line, g, col);
    if (!it || it.text === '*' || /[\\{}%]/.test(it.text)) return { hit: null, end };
    const kind = isRef ? 'ref' : isCite ? 'cite' : 'label';
    return { hit: { kind, from: it.from, to: it.to, key: it.text }, end };
  }
  if (name === 'hyperref') {
    const { args, end } = readArgs(line, nameEnd);
    const opt = args[0]?.open === '[' ? args[0] : null;
    if (!opt || col < start || col > end) return { hit: undefined, end };
    const it = itemAt(line, opt, col);
    return { hit: it ? { kind: 'ref', from: it.from, to: it.to, key: it.text } : null, end };
  }
  if (FILE_COMMANDS.has(name) || IMPORT_COMMANDS.has(name) || name === 'inputminted') {
    const { args, end } = readArgs(line, nameEnd);
    const groups = mandatory(args);
    if (!groups.length || col < start || col > end) return { hit: undefined, end };
    let g: Group | undefined;
    let dir = '';
    if (IMPORT_COMMANDS.has(name)) {
      if (groups.length < 2) return { hit: null, end };
      dir = line.slice(groups[0].from, groups[0].to).trim();
      g = groups[1];
    } else g = name === 'inputminted' ? groups[1] : groups[0];
    if (!g) return { hit: null, end };
    const multi = name === 'bibliography' || name === 'includeonly' || name === 'addbibresource';
    const it = multi ? itemAt(line, g, col) : (() => {
      const raw = line.slice(g.from, g.to);
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      return text ? { text, from: g.from + lead, to: g.from + lead + text.length } : null;
    })();
    if (!it || /[\\#]/.test(it.text)) return { hit: null, end };
    const file = it.text.replace(/^"(.*)"$/, '$1');
    const joined = dir ? `${dir.replace(/\/?$/, '/')}${file}` : file;
    return { hit: { kind: 'file', from: it.from, to: it.to, name: joined, command: name }, end };
  }
  if (PACKAGE_COMMANDS.has(name)) {
    const { args, end } = readArgs(line, nameEnd);
    const g = mandatory(args)[0];
    if (!g || col < start || col > end) return { hit: undefined, end };
    const it = itemAt(line, g, col);
    if (!it || !/^[A-Za-z0-9_.:+-]+$/.test(it.text)) return { hit: null, end };
    return { hit: { kind: 'package', from: it.from, to: it.to, name: it.text, command: name }, end };
  }
  return { hit: undefined, end: nameEnd };
}

/** The command hit under `col` (undefined: none there), and where the line's comment starts (-1: none). */
function scanCommands(line: string, col: number, mode: LinkMode): { hit: LinkHit | null | undefined; comment: number } {
  let comment = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '%' && mode === 'tex') { if (comment < 0) comment = i; continue; }
    if (c !== '\\') continue;
    const m = /^[A-Za-z@]+\*?/.exec(line.slice(i + 1, i + 64));
    if (!m) { i++; continue; }
    const name = m[0].replace(/\*$/, '');
    const nameEnd = i + 1 + m[0].length;
    const r = commandHit(line, name, i, nameEnd, col);
    if (r.hit !== undefined) return { hit: r.hit, comment };
    // Past a linking command's arguments (a \url's literal % is no comment); into any other command's.
    i = Math.max(nameEnd, r.end) - 1;
  }
  return { hit: undefined, comment };
}

// ---- .bib fields ----

const FIELD_RE = /(^|[\s,{])(url|doi|eprint|pmid|crossref|xdata|related)\s*=\s*/gi;

/** A field value: braced (balanced), quoted, or bare up to `,` or `}`. */
function fieldValue(line: string, at: number): { from: number; to: number; end: number } {
  const c = line[at];
  if (c === '{') {
    const g = readGroup(line, at, true);
    return { from: g.from, to: g.to, end: g.end };
  }
  if (c === '"') {
    let j = at + 1;
    while (j < line.length && !(line[j] === '"' && line[j - 1] !== '\\')) j++;
    return { from: at + 1, to: j, end: Math.min(line.length, j + 1) };
  }
  let j = at;
  while (j < line.length && !/[,}\s]/.test(line[j])) j++;
  return { from: at, to: j, end: j };
}

function bibHit(line: string, col: number, o: FindOptions): LinkHit | null | undefined {
  const head = /^(\s*@\s*([A-Za-z]+)\s*[{(]\s*)([^,\s{}()]+)/.exec(line);
  if (head && head[2].toLowerCase() !== 'string' && head[2].toLowerCase() !== 'comment' && head[2].toLowerCase() !== 'preamble') {
    const from = head[1].length, to = from + head[3].length;
    if (col >= from && col <= to) return { kind: 'label', from, to, key: head[3], bib: true };
  }
  FIELD_RE.lastIndex = 0;
  for (let m = FIELD_RE.exec(line); m; m = FIELD_RE.exec(line)) {
    const nameFrom = m.index + m[1].length;
    const field = m[2].toLowerCase();
    const v = fieldValue(line, m.index + m[0].length);
    if (col < nameFrom || col > v.end) continue;
    const raw = line.slice(v.from, v.to);
    const span = { from: v.from, to: v.to };
    if (field === 'url') {
      const href = addressHref(raw);
      return href ? { kind: 'url', ...span, href } : null;
    }
    if (field === 'doi') {
      const href = doiHref(raw);
      return href ? { kind: 'url', ...span, href } : null;
    }
    if (field === 'pmid') {
      const href = pubmedHref(raw);
      return href ? { kind: 'url', ...span, href } : null;
    }
    if (field === 'eprint') {
      const href = eprintHref(raw, o.field?.('eprinttype') ?? o.field?.('archiveprefix') ?? null);
      return href ? { kind: 'url', ...span, href } : null;
    }
    // crossref, xdata, related: entry keys.
    const it = itemAt(line, { open: '{', from: v.from, to: v.to, end: v.end, closed: true }, col);
    return it ? { kind: 'bibkey', from: it.from, to: it.to, key: it.text } : null;
  }
  return undefined;
}

/** What a ⌘/Ctrl-click at `col` of `line` follows, or null (a plain click adds a cursor). */
export function findLink(line: string, col: number, mode: LinkMode, o: FindOptions = {}): LinkHit | null {
  if (col < 0 || col > line.length) return null;
  if (mode === 'bib') {
    const b = bibHit(line, col, o);
    if (b !== undefined) return b;
  }
  let comment = -1;
  if (mode !== 'plain') {
    const r = scanCommands(line, col, mode);
    if (r.hit !== undefined) return r.hit;
    comment = r.comment;
  }
  for (const b of bareLinks(line, mode, comment)) {
    if (col >= b.from && col <= b.to) return b.href ? { kind: 'url', from: b.from, to: b.to, href: b.href } : null;
    if (b.from > col) break;
  }
  return null;
}

/** The mode a file is read in, from its path. */
export function modeFor(path: string): LinkMode {
  if (/\.bib$/i.test(path)) return 'bib';
  if (/\.(tex|ltx|sty|cls|dtx|bbx|cbx)$/i.test(path)) return 'tex';
  return 'plain';
}
