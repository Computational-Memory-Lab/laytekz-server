/**
 * Validation of a stored word-count rule (V2 WP24): the value of the project
 * setting `wordcount.rule` and of the account preference of the same name.
 * A stored rule is sparse: a field left out takes its default
 * (engine.resolveRule), so the stored value stays small.
 */
import { KINDS, PARTS, PATTERN_LISTS, PRESET_IDS } from './engine.js';

export const RULE_LIMITS = { patternsPerList: 50, patternLength: 100, sections: 200, sectionKeyLength: 200, maxTarget: 1_000_000 } as const;

const FIELDS = new Set(['v', 'preset', 'parts', 'kinds', 'formulas', 'target', 'abstractLimit', 'detect', 'patterns', 'sections']);

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

const limit = (v: unknown) => v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= RULE_LIMITS.maxTarget);

function listOf(v: unknown, known: readonly string[]): boolean {
  return Array.isArray(v) && v.length <= known.length && v.every((x) => typeof x === 'string' && known.includes(x)) && new Set(v).size === v.length;
}

/** Why `v` is not a valid stored rule, or null when it is. */
export function ruleProblem(v: unknown): string | null {
  if (!isObj(v)) return 'A word count rule is an object';
  for (const k of Object.keys(v)) if (!FIELDS.has(k)) return `Unknown field "${k.slice(0, 40)}"`;
  if (v.v !== undefined && v.v !== 1) return 'Unknown rule version';
  if (v.preset !== undefined && !PRESET_IDS.includes(v.preset as never)) return 'Unknown preset';
  if (v.parts !== undefined && !listOf(v.parts, PARTS)) return 'parts must list known parts once each';
  if (v.kinds !== undefined && !listOf(v.kinds, KINDS)) return 'kinds must list known kinds once each';
  if (v.formulas !== undefined && v.formulas !== 'none' && v.formulas !== 'one-word') return 'formulas is "none" or "one-word"';
  if (v.target !== undefined && !limit(v.target)) return `The target is a whole number from 1 to ${RULE_LIMITS.maxTarget.toLocaleString('en-US')}, or none`;
  if (v.abstractLimit !== undefined && !limit(v.abstractLimit)) return `The abstract limit is a whole number from 1 to ${RULE_LIMITS.maxTarget.toLocaleString('en-US')}, or none`;
  if (v.detect !== undefined && typeof v.detect !== 'boolean') return 'detect is true or false';
  if (v.patterns !== undefined) {
    if (!isObj(v.patterns)) return 'patterns is an object of lists';
    for (const [k, list] of Object.entries(v.patterns)) {
      if (!PATTERN_LISTS.includes(k as never)) return `Unknown pattern list "${k.slice(0, 40)}"`;
      if (!Array.isArray(list) || list.length > RULE_LIMITS.patternsPerList) return `A pattern list holds at most ${RULE_LIMITS.patternsPerList} patterns`;
      if (!list.every((p) => typeof p === 'string' && p.length <= RULE_LIMITS.patternLength)) return `A pattern is text of at most ${RULE_LIMITS.patternLength} characters`;
    }
  }
  if (v.sections !== undefined) {
    if (!isObj(v.sections)) return 'sections is an object';
    const entries = Object.entries(v.sections);
    if (entries.length > RULE_LIMITS.sections) return `At most ${RULE_LIMITS.sections} sections can be counted differently`;
    for (const [k, p] of entries) {
      if (!k || k.length > RULE_LIMITS.sectionKeyLength) return 'A section title is at most 200 characters';
      if (!PARTS.includes(p as never)) return 'A section counts as a known part';
    }
  }
  return null;
}

export const validRule = (v: unknown): boolean => ruleProblem(v) === null;
