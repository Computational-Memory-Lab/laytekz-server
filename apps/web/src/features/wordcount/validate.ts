/**
 * The stored word-count rule (the project setting `wordcount.rule` and the
 * account preference of the same name), checked as the server checks it
 * (apps/server/src/wordcount/validate.ts). Pure data with no imports, because
 * settings.ts loads it on every page: the lists below mirror the engine's
 * (a unit test compares them).
 *
 * A stored rule is sparse: a field left out takes its default
 * (engine.resolveRule), so the value stays small.
 */

export const STORED_PARTS = ['front', 'abstract', 'main', 'statements', 'appendix', 'supplementary', 'references', 'excluded'] as const;
export const STORED_KINDS = ['text', 'headings', 'citations', 'footnotes', 'captions', 'tables'] as const;
export const STORED_PRESETS = ['main', 'main-captions', 'main-abstract', 'main-statements-appendix', 'everything', 'custom'] as const;
export const STORED_PATTERN_LISTS = [
  'supplementaryHeadings', 'supplementaryEnvironments', 'supplementaryCommands', 'supplementaryFiles',
  'statementHeadings', 'appendixHeadings', 'referenceHeadings', 'ignoredEnvironments',
] as const;

export const RULE_LIMITS = { patternsPerList: 50, patternLength: 100, sections: 200, sectionKeyLength: 200, maxTarget: 1_000_000 } as const;

const FIELDS = new Set(['v', 'preset', 'parts', 'kinds', 'formulas', 'target', 'abstractLimit', 'detect', 'patterns', 'sections']);

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

const limit = (v: unknown) => v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= RULE_LIMITS.maxTarget);

function listOf(v: unknown, known: readonly string[]): boolean {
  return Array.isArray(v) && v.length <= known.length && v.every((x) => typeof x === 'string' && known.includes(x)) && new Set(v).size === v.length;
}

/** Why `v` is not a valid stored rule, or null when it is (the server's wording). */
export function ruleProblem(v: unknown): string | null {
  if (!isObj(v)) return 'A word count rule is an object';
  for (const k of Object.keys(v)) if (!FIELDS.has(k)) return `Unknown field "${k.slice(0, 40)}"`;
  if (v.v !== undefined && v.v !== 1) return 'Unknown rule version';
  if (v.preset !== undefined && !(STORED_PRESETS as readonly unknown[]).includes(v.preset)) return 'Unknown preset';
  if (v.parts !== undefined && !listOf(v.parts, STORED_PARTS)) return 'parts must list known parts once each';
  if (v.kinds !== undefined && !listOf(v.kinds, STORED_KINDS)) return 'kinds must list known kinds once each';
  if (v.formulas !== undefined && v.formulas !== 'none' && v.formulas !== 'one-word') return 'formulas is "none" or "one-word"';
  if (v.target !== undefined && !limit(v.target)) return 'The target is a whole number from 1 to 1,000,000, or none';
  if (v.abstractLimit !== undefined && !limit(v.abstractLimit)) return 'The abstract limit is a whole number from 1 to 1,000,000, or none';
  if (v.detect !== undefined && typeof v.detect !== 'boolean') return 'detect is true or false';
  if (v.patterns !== undefined) {
    if (!isObj(v.patterns)) return 'patterns is an object of lists';
    for (const [k, list] of Object.entries(v.patterns)) {
      if (!(STORED_PATTERN_LISTS as readonly string[]).includes(k)) return `Unknown pattern list "${k.slice(0, 40)}"`;
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
      if (!(STORED_PARTS as readonly unknown[]).includes(p)) return 'A section counts as a known part';
    }
  }
  return null;
}

/** A stored rule, or null for "no rule here" (the project follows the account default, the account the built-in rule). */
export type StoredRule = Record<string, unknown>;
export const validStoredRule = (v: unknown): v is StoredRule | null => v === null || ruleProblem(v) === null;
