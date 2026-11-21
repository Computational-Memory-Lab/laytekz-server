import { APA7, type StatsStyle } from './style';

/**
 * Number formatting for statistics (feature 16). Every value is handled as a
 * decimal string, never as a binary float, and rounds half away from zero, so
 * 0.0285 becomes .029. Thresholds are compared with the value as typed, before
 * rounding. Rounding never adds digits that were not typed (.03 stays .03)
 * unless the style pads.
 *
 * Kinds:
 * - P: p value; writes its relation too ("= .028", "< .001", "> .999")
 * - PC: p value in an APA table cell (".015", "$<$.001")
 * - B: bounded, |x| <= 1, no leading zero
 * - U: can exceed 1, leading zero, digits grouped from 1,000
 * - M: descriptive, like U with the descriptive decimals
 * - DF: degrees of freedom, integers as typed and never grouped, fractions to 2 places
 * - N: counts, grouped
 * - BF: Bayes factor, scientific at or above 1000 and below .001
 * - PCT: percentage, the % stripped, at most 1 decimal
 * - LVL: interval level (95)
 * - PT: alpha or threshold, as typed, no leading zero
 * - RAW: untouched
 */
export type Kind = 'P' | 'PC' | 'B' | 'U' | 'M' | 'DF' | 'N' | 'BF' | 'PCT' | 'LVL' | 'PT' | 'RAW';
export const KINDS: readonly Kind[] = ['P', 'PC', 'B', 'U', 'M', 'DF', 'N', 'BF', 'PCT', 'LVL', 'PT', 'RAW'];

export type Relation = '=' | '<' | '>';

export interface Formatted {
  /** What the field holds: for P the relation and the value ("< .001"), otherwise the value. */
  text: string;
  /** The value alone (".029"). */
  value: string;
  rel?: Relation;
  /** Set when the value is kept as typed because it is out of range or not a number. */
  warning?: string;
}

/** A decimal as digit strings: `int` without leading zeros ('' for zero), `frac` with every typed digit. */
export interface Dec { neg: boolean; int: string; frac: string }

const MINUS = /[\u2212\u2012\u2013\u2014\uFE63\uFF0D]/g;

/** Text that formatting leaves alone: a macro, or letters other than a scientific e. */
export function passesThrough(raw: string): boolean {
  const s = raw.trim()
    .replace(/(?:\\times|×|x)\s*10\s*\^/g, '')
    .replace(/\\[,;: %!]|\{,\}/g, '');
  return /\\[A-Za-z]/.test(s) || /[A-DF-Za-df-z]/.test(s);
}

/** Parses "−1,234.5", "4.3e-05", "1{,}234.57", "0{,}84", "1.23 \times 10^{4}", ".000", "2.31***", "37.5%". */
export function parseDecimal(raw: string): Dec | null {
  let s = raw.trim()
    .replace(MINUS, '-')
    .replace(/^\$|\$$/g, '')
    .replace(/\*+$/, '')
    .replace(/\\%|%$/g, '')
    .replace(/[\u00A0\u2009\u202F]/g, ' ')
    .replace(/\{,\}/g, ',')
    .replace(/\{\.\}/g, '.')
    .replace(/\\[,;: ]|~/g, '')
    .trim();
  let exp = 0;
  const sci = /^(.*?)\s*(?:\\times|×|\*|x)\s*10\s*\^\s*\{?\s*([+-]?\d+)\s*\}?$/.exec(s);
  if (sci) { s = sci[1].trim(); exp = Number(sci[2]); }
  const e = /^(.*?)[eE]([+-]?\d+)$/.exec(s);
  if (e) { s = e[1]; exp += Number(e[2]); }
  s = s.replace(/^\+/, '').replace(/(\d) (?=\d{3}\b)/g, '$1');
  const hasComma = s.includes(','), hasPoint = s.includes('.');
  if (hasComma && hasPoint) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (hasComma) {
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || !(m[2] + (m[3] ?? ''))) return null;
  let int = m[2], frac = m[3] ?? '';
  if (exp > 0) { const take = frac.slice(0, exp).padEnd(exp, '0'); int += take; frac = frac.slice(exp); }
  else if (exp < 0) { const n = -exp; const pad = int.padStart(n, '0'); frac = pad.slice(pad.length - n) + frac; int = pad.slice(0, pad.length - n); }
  return { neg: !!m[1], int: int.replace(/^0+/, ''), frac };
}

const isZero = (d: Dec) => /^0*$/.test(d.int + d.frac);

/** Compares absolute values. */
export function compareAbs(a: Dec, b: Dec): number {
  if (a.int.length !== b.int.length) return a.int.length < b.int.length ? -1 : 1;
  if (a.int !== b.int) return a.int < b.int ? -1 : 1;
  const n = Math.max(a.frac.length, b.frac.length);
  const fa = a.frac.padEnd(n, '0'), fb = b.frac.padEnd(n, '0');
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

/** Rounds half away from zero to `places`; a value with fewer typed decimals is left as it is. */
export function roundDec(d: Dec, places: number): Dec {
  if (d.frac.length <= places) return d;
  const keep = d.frac.slice(0, places);
  if (d.frac[places] < '5') return { neg: d.neg, int: d.int, frac: keep };
  const digits = (d.int + keep).split('');
  let i = digits.length - 1;
  while (i >= 0 && digits[i] === '9') { digits[i] = '0'; i--; }
  if (i >= 0) digits[i] = String(Number(digits[i]) + 1); else digits.unshift('1');
  const all = digits.join('');
  const intLen = all.length - keep.length;
  return { neg: d.neg, int: all.slice(0, intLen).replace(/^0+/, ''), frac: all.slice(intLen) };
}

const padDec = (d: Dec, places: number): Dec => ({ ...d, frac: d.frac.padEnd(places, '0') });

interface PlainOpts { zero: boolean; group: boolean; style: StatsStyle }

/** LaTeX for a decimal: `{,}` groups (or `\,` with a decimal comma), the minus only when nonzero. */
export function plain(d: Dec, o: PlainOpts): string {
  const comma = o.style.decimalMarker === 'comma';
  let int = d.int;
  if (o.group && int.length >= 4) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, comma ? '\\,' : '{,}');
  if (!int && (o.zero || !d.frac)) int = '0';
  const body = d.frac ? `${int}${comma ? '{,}' : '.'}${d.frac}` : int;
  return (d.neg && !isZero(d) ? '-' : '') + body;
}

/** a.bc \times 10^{k}, the mantissa rounded to `places`. */
function scientific(d: Dec, places: number, style: StatsStyle): string {
  const digits = d.int + d.frac;
  const first = digits.search(/[1-9]/);
  if (first < 0) return plain(d, { zero: true, group: false, style });
  let exp = d.int.length - first - 1;
  const mant = digits.slice(first);
  let m = roundDec({ neg: d.neg, int: mant[0], frac: mant.slice(1).replace(/0+$/, '') }, places);
  if (m.int.length > 1) { m = { neg: m.neg, int: m.int[0], frac: (m.int.slice(1) + m.frac).slice(0, places) }; exp += 1; }
  if (style.padDecimals) m = padDec(m, places);
  return `${plain(m, { zero: true, group: false, style })} \\times 10^{${exp}}`;
}

/** Whether a kind keeps its leading zero under the style. */
export function keepsZero(kind: Kind, style: StatsStyle): boolean {
  if (style.leadingZero === 'always') return true;
  if (style.leadingZero === 'never') return false;
  return !(kind === 'P' || kind === 'PC' || kind === 'B' || kind === 'PT');
}

const ONE: Dec = { neg: false, int: '1', frac: '' };
const kept = (raw: string, warning: string): Formatted => ({ text: raw.trim(), value: raw.trim(), warning });
const done = (value: string, rel?: Relation): Formatted =>
  rel ? { text: `${rel} ${value}`, value, rel } : { text: value, value };

function formatP(raw: string, style: StatsStyle, cell: boolean): Formatted {
  let s = raw.trim().replace(/^\$|\$$/g, '').replace(/^p(?:-value)?\s*[:]?\s*/i, '');
  let rel: Relation | null = null;
  const r = /^(\\leq?|\\geq?|<=|>=|≤|≥|<|>|=)\s*/.exec(s);
  if (r) { rel = /^(<|≤|\\le)/.test(r[1]) ? '<' : /^(>|≥|\\ge)/.test(r[1]) ? '>' : '='; s = s.slice(r[0].length); }
  const zero = keepsZero('P', style);
  const out = (value: string, relation: Relation): Formatted => {
    if (!cell) return done(value, relation);
    return { text: relation === '=' ? value : `$${relation}$${value}`, value, rel: relation };
  };
  if (!s) return { text: '', value: '' };
  if (passesThrough(s)) return out(s, rel ?? '=');
  const d = parseDecimal(s);
  if (!d) return kept(raw, 'Not a number');
  if (d.neg || compareAbs(d, ONE) > 0) return kept(raw, 'A p value lies between 0 and 1');
  const places = style.pDecimals;
  const th = style.pThreshold === 'none' ? null : parseDecimal(style.pThreshold);
  const smallest = parseDecimal(`.${'1'.padStart(places, '0')}`)!;
  if (rel === '<' || rel === '>') {
    if (rel === '<' && th && compareAbs(d, th) <= 0) return out(plain(th, { zero, group: false, style }), '<');
    return out(plain(d, { zero, group: false, style }), rel);
  }
  if (th && compareAbs(d, th) < 0) return out(plain(th, { zero, group: false, style }), '<');
  if (!th && compareAbs(d, parseDecimal('.001')!) < 0) {
    return isZero(d) ? out(plain(smallest, { zero, group: false, style }), '<') : out(scientific(d, 1, style), '=');
  }
  const rounded = roundDec(d, places);
  if (compareAbs(rounded, ONE) >= 0) {
    if (style.largestP === 'cap') return out(plain({ neg: false, int: '', frac: '9'.repeat(places) }, { zero, group: false, style }), '>');
    return out(plain(style.padDecimals ? padDec(rounded, places) : rounded, { zero: true, group: false, style }), '=');
  }
  if (isZero(rounded)) return out(plain(smallest, { zero, group: false, style }), '<');
  return out(plain(style.padDecimals ? padDec(rounded, places) : rounded, { zero, group: false, style }), '=');
}

/** Formats one field's text. Empty text gives empty text; macros and words pass through untouched. */
export function formatValue(kind: Kind, raw: string, style: StatsStyle = APA7): Formatted {
  if (kind === 'P' || kind === 'PC') return formatP(raw, style, kind === 'PC');
  const s = raw.trim();
  if (!s || kind === 'RAW') return done(s);
  if (passesThrough(s)) return done(s);
  const d = parseDecimal(s);
  if (!d) return kept(raw, 'Not a number');
  const zero = keepsZero(kind, style);
  const rounded = (places: number, group: boolean) => {
    const r = roundDec(d, places);
    return plain(style.padDecimals ? padDec(r, places) : r, { zero, group, style });
  };
  switch (kind) {
    case 'B':
      if (compareAbs(d, ONE) > 0) return kept(raw, 'This value lies between -1 and 1');
      return done(rounded(style.decimals, false));
    case 'U':
      return done(rounded(style.decimals, true));
    case 'M':
      return done(rounded(style.descriptiveDecimals, true));
    case 'DF':
      if (d.neg) return kept(raw, 'Degrees of freedom cannot be negative');
      if (!d.frac.replace(/0+$/, '')) return done(plain({ ...d, frac: '' }, { zero: true, group: false, style }));
      return done(plain(roundDec(d, 2), { zero: true, group: false, style }));
    case 'N':
      if (d.neg) return kept(raw, 'A count cannot be negative');
      return done(plain(roundDec(d, 2), { zero: true, group: true, style }));
    case 'BF': {
      if (d.neg || isZero(d)) return kept(raw, 'A Bayes factor is above 0');
      const big = d.int.length >= 4, tiny = compareAbs(d, parseDecimal('.001')!) < 0;
      if (big || tiny) return done(scientific(d, 2, style));
      return done(plain(roundDec(d, 2), { zero: true, group: false, style }));
    }
    case 'PCT':
      if (d.neg) return kept(raw, 'A percentage cannot be negative');
      return done(plain(roundDec(d, 1), { zero: true, group: false, style }));
    case 'LVL':
      return done(plain(d, { zero: true, group: false, style }));
    case 'PT':
      if (d.neg || compareAbs(d, ONE) > 0) return kept(raw, 'This value lies between 0 and 1');
      return done(plain(d, { zero, group: false, style }));
  }
  return done(s);
}
