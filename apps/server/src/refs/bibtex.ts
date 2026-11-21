/**
 * Laytekz V2 (WP16): BibTeX cleaning, parsing and layout (moved here from
 * references.ts, which re-exports what it used), plus metadata → entry
 * conversion, capital protection in titles and the biblatex/BibTeX field
 * mapping. Pure.
 */

/** Decode the HTML entities upstream metadata (CrossRef, arXiv, OpenAlex) ships. */
export function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** Escape LaTeX specials that would break a compile, skipping already-escaped ones.
 *  Paired `$…$` is TeX math the author typed (arXiv titles carry it) and stays as
 *  it is, subscripts included; an odd stray `$` is escaped. */
export function latexEscape(s: string): string {
  const escape = (t: string) => t.replace(/(\\?)([&%$#_])/g, (_, bs, ch) => (bs ? bs + ch : `\\${ch}`));
  const dollars = s.match(/(?<!\\)\$/g)?.length ?? 0;
  if (dollars < 2 || dollars % 2) return escape(s);
  return s.split(/((?<!\\)\$(?:\\.|[^$\\])*\$)/).map((part, i) => (i % 2 ? part : escape(part))).join('');
}

/**
 * Characters pdflatex's utf8 inputenc has no macro for, with the macro that
 * typesets them under every engine. Latin-1 symbols (×, ±, °, ·) and the
 * typographic quotes and dashes are set up by inputenc and stay as they are;
 * so do Cyrillic and CJK, which compile under xelatex/lualatex.
 */
const TEX_FOR_CHAR: Record<string, string> = {
  ' ': '~', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  '−': '-', '‐': '-', '‑': '-',
  'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl',
  '≤': '$\\leq$', '≥': '$\\geq$', '≠': '$\\neq$', '≈': '$\\approx$', '≃': '$\\simeq$', '≡': '$\\equiv$',
  '∼': '$\\sim$', '∝': '$\\propto$', '∞': '$\\infty$', '→': '$\\rightarrow$', '←': '$\\leftarrow$',
  '↔': '$\\leftrightarrow$', '⇒': '$\\Rightarrow$', '∂': '$\\partial$', '∇': '$\\nabla$', '∑': '$\\sum$',
  '∏': '$\\prod$', '√': '$\\surd$', '∈': '$\\in$', '⋅': '$\\cdot$', '•': '$\\bullet$', '′': '$\\prime$',
  '″': '$\\prime\\prime$', '≪': '$\\ll$', '≫': '$\\gg$', '⊂': '$\\subset$', '∪': '$\\cup$', '∩': '$\\cap$', 'ℓ': '$\\ell$',
  'α': '$\\alpha$', 'β': '$\\beta$', 'γ': '$\\gamma$', 'δ': '$\\delta$', 'ε': '$\\varepsilon$', 'ϵ': '$\\epsilon$',
  'ζ': '$\\zeta$', 'η': '$\\eta$', 'θ': '$\\theta$', 'ι': '$\\iota$', 'κ': '$\\kappa$', 'λ': '$\\lambda$',
  'μ': '$\\mu$', 'ν': '$\\nu$', 'ξ': '$\\xi$', 'π': '$\\pi$', 'ρ': '$\\rho$', 'σ': '$\\sigma$', 'ς': '$\\varsigma$',
  'τ': '$\\tau$', 'υ': '$\\upsilon$', 'φ': '$\\varphi$', 'ϕ': '$\\phi$', 'χ': '$\\chi$', 'ψ': '$\\psi$', 'ω': '$\\omega$',
  'Γ': '$\\Gamma$', 'Δ': '$\\Delta$', 'Θ': '$\\Theta$', 'Λ': '$\\Lambda$', 'Ξ': '$\\Xi$', 'Π': '$\\Pi$',
  'Σ': '$\\Sigma$', 'Υ': '$\\Upsilon$', 'Φ': '$\\Phi$', 'Ψ': '$\\Psi$', 'Ω': '$\\Omega$',
};
const TEX_CHAR_RE = new RegExp(`[${Object.keys(TEX_FOR_CHAR).join('')}]`, 'g');

/**
 * Make upstream text typesettable with pdflatex, the default engine: emoji
 * and everything else outside the BMP go (no engine's default fonts have
 * them), so do zero-width and variation selectors, and combining marks left
 * after NFC composition, and the space a removal leaves before punctuation;
 * the symbols above become their macros.
 */
export function pdflatexSafe(s: string): string {
  return s.normalize('NFC')
    .replace(/[\u{10000}-\u{10FFFF}]|[​-‍⁠︎️﻿]|[̀-ͯ]/gu, '')
    .replace(/ {2,}/g, ' ').replace(/ (?=[,.:;!?)}])/g, '')
    .replace(TEX_CHAR_RE, (ch) => TEX_FOR_CHAR[ch]);
}

/** A field value built from upstream metadata: HTML-decode, LaTeX-escape, then make it
 *  pdflatex-safe — the macros that step adds carry `$`, which the escape must not see. */
export function bibField(s: string): string {
  return pdflatexSafe(latexEscape(unescapeHtml(s))).trim();
}

/**
 * doi.org emits `month = June`, an undefined macro to bibtex and biber; the
 * defined macros are the lowercase three-letter ones. An unbraced value that
 * is not a month name is braced so it is at least a string.
 */
const MONTH_NAME = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)$/i;
export function normalizeMonths(bib: string): string {
  return bib.replace(/\b(month\s*=\s*)([A-Za-z]+)(?=\s*[,}\n])/gi, (_, lhs: string, name: string) =>
    (MONTH_NAME.test(name) ? `${lhs}${name.slice(0, 3).toLowerCase()}` : `${lhs}{${name}}`));
}

export interface BibFieldValue { name: string; value: string; bare: boolean }
export interface ParsedEntry { type: string; key: string; fields: BibFieldValue[] }

/** One entry's fields; null when the blob is not a single well-formed entry (it is then kept as received). */
export function parseEntry(bib: string): ParsedEntry | null {
  const head = /^\s*@(\w+)\s*\{\s*([^,\s]+)\s*,/.exec(bib);
  if (!head) return null;
  const fields: BibFieldValue[] = [];
  const nameRe = /([A-Za-z][\w-]*)\s*=\s*/y;
  const n = bib.length;
  let i = head[0].length;
  while (i < n) {
    while (i < n && /[\s,]/.test(bib[i])) i++;
    if (i >= n) return null;
    if (bib[i] === '}') return /^\s*$/.test(bib.slice(i + 1)) ? { type: head[1].toLowerCase(), key: head[2], fields } : null;
    nameRe.lastIndex = i;
    const nm = nameRe.exec(bib);
    if (!nm) return null;
    i = nameRe.lastIndex;
    let value: string;
    let bare = false;
    if (bib[i] === '{') {
      const start = i;
      for (let depth = 0; i < n; i++) {
        if (bib[i] === '{') depth++;
        else if (bib[i] === '}' && --depth === 0) break;
      }
      if (i >= n) return null;
      value = bib.slice(start + 1, i++);
    } else if (bib[i] === '"') {
      const start = ++i;
      while (i < n && bib[i] !== '"') i++;
      if (i >= n) return null;
      value = bib.slice(start, i++);
    } else {
      const start = i;
      while (i < n && !/[,}\s]/.test(bib[i])) i++;
      value = bib.slice(start, i);
      bare = true;
    }
    fields.push({ name: nm[1].toLowerCase(), value: value.trim(), bare });
  }
  return null;
}

/**
 * The V1 key rule (kept for MCP `references_add` and the old add route): the
 * first author's surname in ASCII lowercase plus the year, falling back to
 * the upstream's key when either is missing.
 */
export function entryKey(fields: BibFieldValue[], fallback: string): string {
  const author = fields.find((f) => f.name === 'author')?.value ?? '';
  const year = /\d{4}/.exec(fields.find((f) => f.name === 'year')?.value ?? '')?.[0] ?? '';
  const first = author.split(/\s+and\s+/i)[0] ?? '';
  const surname = first.includes(',') ? first.split(',')[0] : first.trim().split(/\s+/).pop() ?? '';
  const slug = surname.normalize('NFD').replace(/[^A-Za-z]/g, '').toLowerCase();
  return slug && year ? `${slug}${year}` : fallback;
}

/** One layout for every upstream: title, author, year first, then the rest as received, names aligned; macros (month) stay bare. */
const LEADING_FIELDS = ['title', 'author', 'year'];
export function formatEntry(type: string, key: string, fields: BibFieldValue[]): string {
  const ordered = [...LEADING_FIELDS.flatMap((n) => fields.filter((f) => f.name === n)), ...fields.filter((f) => !LEADING_FIELDS.includes(f.name))];
  const width = Math.max(0, ...ordered.map((f) => f.name.length));
  const lines = ordered.map((f) => `  ${f.name.padEnd(width)} = ${f.bare && !/^\d+$/.test(f.value) ? f.value : `{${f.value}}`},`);
  return `@${type}{${key},\n${lines.join('\n')}\n}`;
}

/** Decode, make pdflatex-safe, escape bare & and %, fix month macros: the text cleaning, without re-keying. */
export function cleanBibtexText(bib: string): string {
  return normalizeMonths(pdflatexSafe(unescapeHtml(bib)).replace(/(\\?)([&%])/g, (_, bs, ch) => (bs ? bs + ch : `\\${ch}`)));
}

/**
 * Sanitize a raw BibTeX blob (e.g. CrossRef via doi.org) so the entry
 * compiles, then re-key and lay the entry out like a synthesized one.
 */
export function sanitizeBibtex(bib: string): string {
  const safe = cleanBibtexText(bib);
  const parsed = parseEntry(safe);
  return parsed ? formatEntry(parsed.type, entryKey(parsed.fields, parsed.key), parsed.fields) : safe;
}

/** The first entry of a pasted blob (Scholar's "BibTeX" link gives one), comments and @string blocks skipped. */
export function firstEntryText(blob: string): string | null {
  const starts = [...blob.matchAll(/@\s*([a-zA-Z]+)\s*[{(]/g)];
  for (let i = 0; i < starts.length; i++) {
    const type = starts[i][1].toLowerCase();
    if (['comment', 'preamble', 'string'].includes(type)) continue;
    const from = starts[i].index!;
    // balanced braces from the opening one
    let depth = 0;
    for (let j = blob.indexOf('{', from); j >= 0 && j < blob.length; j++) {
      if (blob[j] === '{') depth++;
      else if (blob[j] === '}' && --depth === 0) return blob.slice(from, j + 1).replace(/^@\s*/, '@');
    }
    return null;
  }
  return null;
}

// ---- capital protection ----

/**
 * Brace words with a capital after their first letter (BERT, ImageNet,
 * mRNA, COVID-19) so BibTeX styles that lowercase titles keep them. Text
 * already inside braces, math and macros is left alone.
 */
export function protectTitle(title: string): string {
  let out = '';
  let depth = 0;
  let math = false;
  let i = 0;
  while (i < title.length) {
    const ch = title[i];
    if (ch === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(title.slice(i));
      out += m ? m[0] : ch; i += m ? m[0].length : 1; continue;
    }
    if (ch === '$') { math = !math; out += ch; i++; continue; }
    if (ch === '{') { depth++; out += ch; i++; continue; }
    if (ch === '}') { depth = Math.max(0, depth - 1); out += ch; i++; continue; }
    if (depth === 0 && !math && /[\p{L}\d]/u.test(ch) && (i === 0 || !/[\p{L}\d]/u.test(title[i - 1]))) {
      const m = /^[\p{L}\d]+(?:-[\p{L}\d]+)*/u.exec(title.slice(i))!;
      const word = m[0];
      const inner = word.slice(1);
      out += /\p{Lu}/u.test(inner) ? `{${word}}` : word;
      i += word.length; continue;
    }
    out += ch; i++;
  }
  return out;
}

// ---- metadata → entry ----

export type BibFormat = 'biblatex' | 'bibtex';

/** CSL-like metadata every source maps to before it becomes BibTeX. */
export interface CslLike {
  type?: string;
  title?: string;
  /** Family/given, or a literal (an organisation). */
  author?: Array<{ family?: string; given?: string; literal?: string }>;
  editor?: Array<{ family?: string; given?: string; literal?: string }>;
  year?: number | null;
  month?: number | null;
  containerTitle?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  url?: string;
  isbn?: string;
  pmid?: string;
  eprint?: string;
  edition?: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function nameField(list: CslLike['author']): string {
  return (list || []).map((a) => (a.literal ? `{${bibField(a.literal)}}` : [a.family, a.given].filter(Boolean).map((p) => bibField(p!)).join(', '))).filter(Boolean).join(' and ');
}

/** An entry type and its fields from CSL-like metadata, in BibTeX field names (see applyFieldStyle). */
export function cslToEntry(csl: CslLike, format: BibFormat = 'bibtex', key = 'ref'): string {
  const t = (csl.type || '').toLowerCase();
  let type = 'article';
  let container = 'journal';
  if (t === 'proceedings-article' || t === 'paper-conference') { type = 'inproceedings'; container = 'booktitle'; }
  else if (t === 'book' || t === 'monograph' || t === 'edited-book' || t === 'reference-book') { type = 'book'; container = ''; }
  else if (t === 'chapter' || t === 'book-chapter' || t === 'book-section') { type = 'incollection'; container = 'booktitle'; }
  else if (t === 'dataset') { type = format === 'biblatex' ? 'dataset' : 'misc'; container = ''; }
  else if (t === 'posted-content' || t === 'preprint' || t === 'report' || t === 'thesis' || t === 'webpage' || t === 'other') {
    type = t === 'thesis' ? 'phdthesis' : t === 'report' ? 'techreport' : 'misc'; container = '';
  }
  const f: BibFieldValue[] = [];
  const add = (name: string, v: string | number | null | undefined, bare = false) => {
    if (v === undefined || v === null || v === '') return;
    f.push({ name, value: String(v), bare });
  };
  add('title', csl.title ? bibField(csl.title.replace(/\s+/g, ' ')) : '');
  add('author', nameField(csl.author));
  add('editor', nameField(csl.editor));
  add('year', csl.year ?? '');
  if (csl.month && csl.month >= 1 && csl.month <= 12) add('month', MONTHS[csl.month - 1], true);
  if (container && csl.containerTitle) add(container, bibField(csl.containerTitle));
  else if (!container && csl.containerTitle && type === 'misc') add('howpublished', bibField(csl.containerTitle));
  add('volume', csl.volume);
  add('number', csl.issue);
  add('pages', csl.pages ? csl.pages.replace(/\s*[-–]\s*/, '--') : '');
  add('edition', csl.edition);
  add('publisher', csl.publisher ? bibField(csl.publisher) : '');
  add('address', csl.place ? bibField(csl.place) : '');
  add('isbn', csl.isbn);
  add('doi', csl.doi);
  if (csl.eprint) { add('eprint', csl.eprint); add('archiveprefix', 'arXiv'); }
  add('pmid', csl.pmid);
  add('url', csl.url);
  return formatEntry(type, key, f);
}

/** biblatex ↔ BibTeX field names for an entry, following the paper's package. */
export function applyFieldStyle(entry: string, format: BibFormat): string {
  const p = parseEntry(entry);
  if (!p) return entry;
  const rename: Record<string, string> = format === 'biblatex'
    ? { journal: 'journaltitle', address: 'location' }
    : { journaltitle: 'journal', location: 'address' };
  let fields = p.fields.map((x) => (rename[x.name] && !p.fields.some((y) => y.name === rename[x.name]) ? { ...x, name: rename[x.name] } : x));
  if (format === 'bibtex') {
    const date = fields.find((x) => x.name === 'date');
    if (date && !fields.some((x) => x.name === 'year')) {
      const m = /^(\d{4})(?:-(\d{2}))?/.exec(date.value);
      if (m) {
        fields = fields.filter((x) => x !== date);
        fields.push({ name: 'year', value: m[1], bare: false });
        if (m[2] && !fields.some((x) => x.name === 'month')) fields.push({ name: 'month', value: MONTHS[Number(m[2]) - 1] ?? '', bare: true });
      }
    }
  }
  let type = p.type;
  if (format === 'bibtex' && ['dataset', 'online', 'software'].includes(type)) type = 'misc';
  return formatEntry(type, p.key, fields.filter((x) => x.value !== ''));
}

/** The entry with its title capital-protected (a no-op for an unparsable blob). */
export function protectEntryTitle(entry: string): string {
  const p = parseEntry(entry);
  if (!p) return entry;
  const fields = p.fields.map((x) => (x.name === 'title' || x.name === 'booktitle' ? { ...x, value: protectTitle(x.value) } : x));
  return formatEntry(p.type, p.key, fields);
}

/** The entry under another key. */
export function withKey(entry: string, key: string): string {
  return entry.replace(/^(\s*@\w+\s*\{\s*)[^,\s]+/, `$1${key}`);
}
