/**
 * Laytekz V2 (WP16): citation keys in the three project styles, and the
 * suffix a key gets when another paper already has it. Pure.
 *   authoryear  vaswani2017               (the default, V1's rule)
 *   scholar     vaswani2017attention      (Google Scholar's)
 *   bbt         vaswaniAttentionAllYou2017 (Zotero / Better BibTeX's default)
 */
import { parseEntry, type BibFieldValue } from './bibtex.js';

export type KeyStyle = 'authoryear' | 'scholar' | 'bbt';
export const KEY_STYLES: readonly KeyStyle[] = ['authoryear', 'scholar', 'bbt'];

const TEX_ACCENT: Record<string, string> = { ss: 'ss', ae: 'ae', AE: 'AE', oe: 'oe', OE: 'OE', o: 'o', O: 'O', l: 'l', L: 'L', aa: 'a', AA: 'A', i: 'i', j: 'j' };

/** ASCII letters and digits only: TeX accents and Unicode diacritics folded (Müller, M{\"u}ller → Muller). */
export function asciiFold(s: string): string {
  return s
    .replace(/\\([a-zA-Z]{1,2})(?![a-zA-Z])\s*/g, (m, name: string) => TEX_ACCENT[name] ?? '')
    .replace(/\\[^a-zA-Z\s]/g, '')
    .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/Æ/g, 'AE').replace(/ø/g, 'o').replace(/Ø/g, 'O').replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, '');
}

const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with', 'from', 'at', 'by', 'is', 'are', 'as', 'via', 'into', 'its', 'or', 'der', 'die', 'das', 'le', 'la', 'les', 'el', 'un', 'une']);
const ORG_STOP = new Set([...STOP, 'international', 'national', 'association', 'society', 'organization', 'organisation', 'institute', 'council', 'committee', 'department']);

/** The first author's surname for a key: `{World Health Organization}` gives `world`, `van der Berg, J.` gives `berg`. */
export function firstSurname(author: string): string {
  const first = (author.split(/\s+and\s+/i)[0] ?? '').trim();
  if (!first) return '';
  if (/^\{[^{}]*\}$/.test(first)) {
    const words = first.slice(1, -1).split(/\s+/).map(asciiFold).filter(Boolean);
    const sig = words.find((w) => !ORG_STOP.has(w.toLowerCase())) ?? words[0] ?? '';
    return sig.toLowerCase();
  }
  const family = first.includes(',') ? first.split(',')[0] : first.split(/\s+/).pop() ?? '';
  // particles (van, der, de, von) are dropped: the last word of the family name is the key
  const parts = family.replace(/[{}]/g, '').trim().split(/\s+/);
  const lowerParticles = parts.filter((p) => !/^[a-z]/.test(p));
  const surname = (lowerParticles.length ? lowerParticles.join('') : parts.at(-1)) ?? '';
  return asciiFold(surname).toLowerCase();
}

/** Significant title words in order (TeX commands, braces and stop words removed). */
export function titleWords(title: string): string[] {
  return title
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/\\[a-zA-Z]+\s*/g, ' ')
    .split(/[\s\-–—:;,./?!()[\]{}'"]+/)
    .map(asciiFold).filter((w) => w && !STOP.has(w.toLowerCase()));
}

function field(fields: BibFieldValue[], name: string): string {
  return fields.find((f) => f.name === name)?.value ?? '';
}

export function yearOf(fields: BibFieldValue[]): string {
  return /\d{4}/.exec(field(fields, 'year') || field(fields, 'date'))?.[0] ?? '';
}

/** The base key (no suffix) an entry gets in a style. Falls back to a title word, then `ref`. */
export function makeKey(fields: BibFieldValue[], style: KeyStyle = 'authoryear'): string {
  const author = field(fields, 'author') || field(fields, 'editor');
  const surname = firstSurname(author);
  const year = yearOf(fields);
  const words = titleWords(field(fields, 'title'));
  const first = (words[0] ?? '').toLowerCase();
  const name = surname || first || 'ref';
  if (style === 'scholar') return `${name}${year}${surname ? first : ''}`;
  if (style === 'bbt') {
    const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    return `${name}${surname ? words.slice(0, 3).map(cap).join('') : ''}${year}`;
  }
  return `${name}${year}`;
}

/** The key for a whole entry text; null when it does not parse. */
export function keyForEntry(entry: string, style: KeyStyle): string | null {
  const p = parseEntry(entry);
  return p ? makeKey(p.fields, style) : null;
}

/**
 * The first free key: `base`, then base+a, base+b, … (for the BBT style the
 * fourth title word is tried before the letters). `taken` is compared
 * case-insensitively, as biber does.
 */
export function uniqueKey(base: string, taken: Iterable<string>, fields?: BibFieldValue[], style: KeyStyle = 'authoryear'): string {
  const lower = new Set([...taken].map((k) => k.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  if (style === 'bbt' && fields) {
    const words = titleWords(field(fields, 'title'));
    const year = yearOf(fields);
    if (words[3] && year && base.endsWith(year)) {
      const alt = base.slice(0, -year.length) + words[3].charAt(0).toUpperCase() + words[3].slice(1).toLowerCase() + year;
      if (!lower.has(alt.toLowerCase())) return alt;
    }
  }
  for (let i = 0; i < 26 * 27; i++) {
    const suffix = i < 26 ? String.fromCharCode(97 + i) : String.fromCharCode(97 + Math.floor(i / 26) - 1) + String.fromCharCode(97 + (i % 26));
    if (!lower.has(`${base}${suffix}`.toLowerCase())) return `${base}${suffix}`;
  }
  return `${base}${Date.now().toString(36)}`;
}

/** A key the user typed: BibTeX keys may not hold spaces, commas, braces, quotes, # % ~ or a backslash. */
export function validKey(key: string): boolean {
  return /^[^\s,{}()"'#%~\\=]{1,120}$/.test(key);
}
