/**
 * Statistics house style (feature 16). A project stores only its differences
 * from APA 7 under the project setting 'stats.style', so co-authors format
 * identically.
 *
 * This file has a byte-identical twin, apps/server/src/features/stats/style.ts
 * (the web image builds from apps/web alone, and NodeNext cannot import across
 * the apps); a test compares them. It imports nothing.
 */

export type LeadingZero = 'apa' | 'always' | 'never';
export type GreekStyle = 'auto' | 'upright' | 'italic';
export type PThreshold = '.001' | '.01' | '.0001' | 'none';

export interface StatsStyle {
  /** 'apa': a leading zero only where the value can exceed 1. */
  leadingZero: LeadingZero;
  /** Decimals for test statistics, effect sizes and other values. */
  decimals: number;
  /** Decimals for exact p values. */
  pDecimals: 2 | 3;
  /** Decimals for means, SDs and other descriptives (1 suits integer scales). */
  descriptiveDecimals: number;
  /** Below it, p is written "< threshold"; 'none' writes exact values (scientific below .001). */
  pThreshold: PThreshold;
  /** 'cap': p that rounds to 1 is written "> .999". */
  largestP: 'cap' | 'exact';
  /** Pad to the set number of decimals; off, rounding never adds digits that were not typed. */
  padDecimals: boolean;
  greek: GreekStyle;
  decimalMarker: 'point' | 'comma';
  credibleLabel: 'CrI' | 'HDI';
  kruskalSymbol: 'H' | 'chi2';
}

export const STATS_STYLE_SETTING = 'stats.style';

export const APA7: Readonly<StatsStyle> = Object.freeze({
  leadingZero: 'apa',
  decimals: 2,
  pDecimals: 3,
  descriptiveDecimals: 2,
  pThreshold: '.001',
  largestP: 'cap',
  padDecimals: false,
  greek: 'auto',
  decimalMarker: 'point',
  credibleLabel: 'CrI',
  kruskalSymbol: 'H',
});

const oneOf = (...values: readonly unknown[]) => (v: unknown) => values.includes(v);
const intIn = (min: number, max: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

const CHECKS: { readonly [K in keyof StatsStyle]: (v: unknown) => boolean } = {
  leadingZero: oneOf('apa', 'always', 'never'),
  decimals: intIn(0, 4),
  pDecimals: oneOf(2, 3),
  descriptiveDecimals: intIn(0, 4),
  pThreshold: oneOf('.001', '.01', '.0001', 'none'),
  largestP: oneOf('cap', 'exact'),
  padDecimals: (v) => typeof v === 'boolean',
  greek: oneOf('auto', 'upright', 'italic'),
  decimalMarker: oneOf('point', 'comma'),
  credibleLabel: oneOf('CrI', 'HDI'),
  kruskalSymbol: oneOf('H', 'chi2'),
};

export const STYLE_KEYS = Object.keys(CHECKS) as (keyof StatsStyle)[];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** The stored value: a plain object holding only known keys with valid values (the server's validator). */
export function isStatsStyleDiff(v: unknown): v is Partial<StatsStyle> {
  if (!isPlainObject(v)) return false;
  for (const [key, value] of Object.entries(v)) {
    const check = (CHECKS as Record<string, ((x: unknown) => boolean) | undefined>)[key];
    if (!Object.prototype.hasOwnProperty.call(CHECKS, key) || !check || !check(value)) return false;
  }
  return true;
}

/** The full style for a stored value; unknown keys and bad values fall back to APA 7, never throw. */
export function resolveStyle(stored: unknown): StatsStyle {
  const out: StatsStyle = { ...APA7 };
  if (!isPlainObject(stored)) return out;
  for (const key of STYLE_KEYS) {
    const value = stored[key];
    if (value !== undefined && CHECKS[key](value)) (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** What to store: only the options that differ from APA 7 (an empty object means APA 7). */
export function styleDiff(style: Partial<StatsStyle>): Partial<StatsStyle> {
  const out: Record<string, unknown> = {};
  for (const key of STYLE_KEYS) {
    const value = style[key];
    if (value !== undefined && value !== APA7[key] && CHECKS[key](value)) out[key] = value;
  }
  return out as Partial<StatsStyle>;
}

/** True when the style is APA 7 exactly (the settings row then says "APA 7", otherwise "Custom"). */
export const isApa7 = (style: Partial<StatsStyle>): boolean => Object.keys(styleDiff(style)).length === 0;
