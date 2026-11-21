/**
 * F13 word count, the pure half of the status and the breakdown (WP27): the
 * live splice of the open file into the server's breakdown, the numbers the
 * status and the popover show, their wording, and the edits the popover
 * makes to a rule. No DOM, no network: the store (store.ts) feeds it.
 */
import {
  DEFAULT_PATTERNS, KINDS, KIND_LABELS, PARTS, PART_LABELS, PATTERN_LISTS, PRESETS,
  addTally, applyRule, countText, emptyTally, initialState, printedWords, sameState, sectionKey, sectionsOf,
  type Kind, type Occurrence, type Part, type PresetId, type ScanState, type SectionCount, type Segment, type Tally,
  type Unresolved, type Why, type WordCountRule,
} from '../../wordcount/engine';
import type { StoredRule } from './validate';

export type RuleSource = 'project' | 'account' | 'default';

/** GET /api/projects/:id/wordcount/breakdown (apps/server/src/wordcount/count.ts, WordCountResult). */
export interface Breakdown {
  rootFile: string;
  total: number;
  files: Record<string, number>;
  tally: Tally;
  segments: Segment[];
  occurrences: Occurrence[];
  sections: SectionCount[];
  why: Why[];
  unresolved: Unresolved[];
  citedKeys: string[];
  macros: [string, string][];
  rule: WordCountRule;
  ruleSource: RuleSource;
  ruleName: string;
  citeWords: Record<string, number>;
  worksCited: number;
  otherDocuments: { file: string; total: number }[];
  unreachable: string[];
}

/** What the status and the popover show, recomputed from segments under a rule. */
export interface CountView {
  total: number;
  files: Record<string, number>;
  tally: Tally;
  /** Words per part, within the rule's kinds. */
  parts: Record<Part, number>;
  /** Words per kind, within the rule's parts. */
  kinds: Record<Kind, number>;
  formulas: { inline: number; display: number };
  sections: SectionCount[];
  characters: { counted: number; countedWithSpaces: number };
  readingMinutes: number;
  target: { words: number; over: number } | null;
  abstract: { words: number; limit: number | null };
}

/** Average silent reading speed for English non-fiction (Brysbaert, 2019), as the server uses. */
export const WORDS_PER_MINUTE = 238;
const BASE_KINDS: readonly Kind[] = ['text', 'headings', 'citations', 'footnotes'];

/** The document's numbers from its segments, as the server summarises them (count.ts). */
export function deriveView(segments: readonly Segment[], rule: WordCountRule): CountView {
  const tally = emptyTally();
  const files: Record<string, number> = {};
  let total = 0;
  for (const s of segments) {
    addTally(tally, s.tally);
    const n = applyRule(s.tally, rule);
    files[s.file] = (files[s.file] ?? 0) + n;
    total += n;
  }
  const parts = {} as Record<Part, number>;
  for (const p of PARTS) { let n = 0; for (const k of rule.kinds) n += tally.words[`${p}:${k}`] ?? 0; parts[p] = n; }
  const kinds = {} as Record<Kind, number>;
  for (const k of KINDS) { let n = 0; for (const p of rule.parts) n += tally.words[`${p}:${k}`] ?? 0; kinds[k] = n; }
  let inline = 0, display = 0;
  for (const p in tally.formulas) { inline += tally.formulas[p][0]; display += tally.formulas[p][1]; }
  let chars = 0;
  for (const p of rule.parts) for (const k of rule.kinds) chars += tally.chars[`${p}:${k}`] ?? 0;
  const abstractWords = BASE_KINDS.reduce((n, k) => n + (tally.words[`abstract:${k}`] ?? 0), 0);
  return {
    total, files, tally, parts, kinds, formulas: { inline, display },
    sections: sectionsOf(segments, rule),
    characters: { counted: chars, countedWithSpaces: chars + Math.max(0, total - 1) },
    readingMinutes: Math.max(total > 0 ? 1 : 0, Math.round(total / WORDS_PER_MINUTE)),
    target: rule.target ? { words: rule.target, over: Math.max(0, total - rule.target) } : null,
    abstract: { words: abstractWords, limit: rule.abstractLimit },
  };
}

const INCLUDE_RE = /\\(?:input|include|import|subimport|subfile|inputfrom|includefrom|subinputfrom|subincludefrom)(?![A-Za-z@])/;

/** The text pulls in another file outside a comment (the live scan follows no includes). */
export function hasIncludes(text: string): boolean {
  if (!INCLUDE_RE.test(text)) return false;
  for (const line of text.split('\n')) {
    const code = line.replace(/(^|[^\\])%.*$/, '$1');
    if (INCLUDE_RE.test(code)) return true;
  }
  return false;
}

export interface SpliceResult {
  /** The document's segments with the open file's re-counted, or null when it cannot be spliced (see `refetch`). */
  segments: Segment[] | null;
  /** The server must count again: the file pulls in other files, or it now leaves a different state for what follows. */
  refetch: boolean;
}

/**
 * Re-counts the open file's text at each place the document includes it,
 * from the state the server recorded there, and puts the result in place of
 * that occurrence's segments. A file that includes others (or now does) is
 * never spliced: its children's effect on what follows is the server's to
 * work out. A file outside the document gives { segments: null, refetch: false }.
 */
export function splice(b: Breakdown, file: string, text: string, rule: WordCountRule): SpliceResult {
  const occs = b.occurrences.filter((o) => o.file === file);
  if (!occs.length) return { segments: null, refetch: false };
  if (b.occurrences.some((o) => o.parent === file) || hasIncludes(text)) return { segments: null, refetch: true };
  let segments = b.segments;
  let refetch = false;
  const citeWords = (k: string) => b.citeWords[k] ?? 2;
  for (const occ of occs) {
    const res = countText(text, rule, { file, entry: occ.entry, macros: b.macros, citeWords });
    const exit = res.occurrences[0]?.exit;
    if (!exit || !sameState(exit, occ.exit)) refetch = true;
    const at = segments.findIndex((s) => s.file === file && s.occ === occ.occ);
    const fresh = res.segments.map((s, i) => ({ ...s, occ: occ.occ, cont: i === 0 && at >= 0 ? segments[at].cont : s.cont }));
    const kept = segments.filter((s) => !(s.file === file && s.occ === occ.occ));
    const insertAt = at < 0 ? kept.length : segments.slice(0, at).filter((s) => !(s.file === file && s.occ === occ.occ)).length;
    segments = [...kept.slice(0, insertAt), ...fresh, ...kept.slice(insertAt)];
  }
  return { segments, refetch };
}

/** The entry state for counting a text on its own (a selection, a file outside the document): in the body, with the document's macros. */
export function standaloneEntry(macros: readonly [string, string][]): ScanState {
  return { ...initialState(true), macros: macros.length };
}

/** Every word in a selection that would print, whatever the rule. */
export function selectionWords(text: string, macros: [string, string][] = []): number {
  return printedWords(countText(text, undefined, { entry: standaloneEntry(macros), macros }).tally);
}

/** A file outside the document, counted on its own under the rule. */
export function fileWords(text: string, rule: WordCountRule, macros: [string, string][] = []): number {
  return countText(text, rule, /\\documentclass/.test(text) ? {} : { entry: standaloneEntry(macros), macros }).total;
}

// ---- wording ----

export const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
export const words = (n: number) => `${fmt(n)} ${n === 1 ? 'word' : 'words'}`;

export interface StatusInput {
  total: number;
  target: number | null;
  /** Words in the selection, or null when nothing is selected. */
  sel: number | null;
  /** The open file is part of the document. */
  inDoc: boolean;
}

/** The status button's text. */
export function statusText(s: StatusInput): string {
  if (s.sel != null) return `${fmt(s.sel)} of ${words(s.total)}`;
  if (!s.inDoc) return `This file: ${words(s.total)}`;
  if (s.target) return `${fmt(s.total)} / ${words(s.target)}`;
  return words(s.total);
}

export const isOver = (s: StatusInput) => s.sel == null && s.inDoc && !!s.target && s.total > s.target;

/** The status button's tooltip. */
export function statusTitle(s: StatusInput, ruleName: string): string {
  if (s.sel != null) return 'Words in the selection that would print (every part and kind, no comments), of the counted total';
  if (!s.inDoc) return 'Words in this file. The main document never includes it, so it is not part of the count.';
  if (isOver(s)) return `${words(s.total - s.target!)} over the target. Counted under “${ruleName}”.`;
  return `Counted under “${ruleName}”. Show the breakdown.`;
}

export function sourceLabel(source: RuleSource): string {
  return source === 'project' ? 'set for this project' : source === 'account' ? 'your default' : 'the built-in rule';
}

export function ruleLabel(rule: WordCountRule): string {
  return rule.preset === 'custom' ? 'Custom' : PRESETS[rule.preset].label;
}

/** Plain text for a cover letter or an email. */
export function breakdownText(b: Pick<Breakdown, 'ruleSource' | 'worksCited'>, v: CountView, rule: WordCountRule): string {
  const out: string[] = [];
  out.push(`Word count: ${words(v.total)} (${ruleLabel(rule)}, ${sourceLabel(b.ruleSource)})`);
  if (v.target) out.push(`Target: ${fmt(v.total)} / ${words(v.target.words)}${v.target.over ? ` (${fmt(v.target.over)} over)` : ''}`);
  if (v.abstract.limit) out.push(`Abstract: ${fmt(v.abstract.words)} / ${words(v.abstract.limit)}`);
  out.push('', 'Parts:');
  for (const p of PARTS) {
    if (p === 'excluded' || p === 'references') continue;
    const n = v.parts[p];
    if (!n && !rule.parts.includes(p)) continue;
    out.push(`  ${PART_LABELS[p]}: ${fmt(n)}${rule.parts.includes(p) ? '' : ' (not counted)'}`);
  }
  out.push(`  References: generated at typeset, never counted (${fmt(b.worksCited)} works cited)`);
  out.push('', 'Kinds, in the counted parts:');
  for (const k of KINDS) out.push(`  ${KIND_LABELS[k]}: ${fmt(v.kinds[k])}${rule.kinds.includes(k) ? '' : ' (not counted)'}`);
  if (v.formulas.inline || v.formulas.display) out.push(`  Formulas: ${fmt(v.formulas.inline)} inline, ${fmt(v.formulas.display)} displayed${rule.formulas === 'one-word' ? ' (one word each)' : ' (not counted)'}`);
  if (v.sections.length) {
    out.push('', 'By section:');
    for (const s of v.sections) out.push(`  ${s.title ?? 'Before the first heading'}: ${fmt(s.counted)}`);
  }
  out.push('', `Characters: ${fmt(v.characters.counted)} (${fmt(v.characters.countedWithSpaces)} with spaces)`);
  out.push(`Reading time: about ${v.readingMinutes} min`);
  return out.join('\n');
}

// ---- rule edits ----

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** The preset these parts and kinds amount to, or 'custom'. */
export function presetFor(parts: readonly Part[], kinds: readonly Kind[]): PresetId {
  for (const [id, p] of Object.entries(PRESETS) as [Exclude<PresetId, 'custom'>, (typeof PRESETS)['main']][]) {
    if (sameSet(p.parts, parts) && sameSet(p.kinds, kinds)) return id;
  }
  return 'custom';
}

const ordered = <T extends string>(all: readonly T[], set: readonly T[]) => all.filter((x) => set.includes(x));

export function withPreset(rule: WordCountRule, preset: PresetId): WordCountRule {
  if (preset === 'custom') return { ...rule, preset };
  return { ...rule, preset, parts: [...PRESETS[preset].parts], kinds: [...PRESETS[preset].kinds] };
}

export function withPart(rule: WordCountRule, part: Part, on: boolean): WordCountRule {
  const parts = ordered(PARTS, on ? [...rule.parts, part] : rule.parts.filter((p) => p !== part));
  return { ...rule, parts, preset: presetFor(parts, rule.kinds) };
}

export function withKind(rule: WordCountRule, kind: Kind, on: boolean): WordCountRule {
  const kinds = ordered(KINDS, on ? [...rule.kinds, kind] : rule.kinds.filter((k) => k !== kind));
  return { ...rule, kinds, preset: presetFor(rule.parts, kinds) };
}

/** A section counted as `part`, or back to automatic (null). */
export function withSection(rule: WordCountRule, title: string, part: Part | null): WordCountRule {
  const sections = { ...rule.sections };
  const key = sectionKey(title);
  if (part) sections[key] = part; else delete sections[key];
  return { ...rule, sections };
}

/** The sparse form stored with the project or the account: only what differs from the defaults. */
export function sparseRule(rule: WordCountRule): StoredRule {
  const out: StoredRule = { v: 1, preset: rule.preset };
  if (rule.preset === 'custom') { out.parts = ordered(PARTS, rule.parts); out.kinds = ordered(KINDS, rule.kinds); }
  if (rule.formulas === 'one-word') out.formulas = 'one-word';
  if (rule.target) out.target = rule.target;
  if (rule.abstractLimit) out.abstractLimit = rule.abstractLimit;
  if (!rule.detect) out.detect = false;
  if (Object.keys(rule.sections).length) out.sections = { ...rule.sections };
  const patterns: Record<string, string[]> = {};
  for (const k of PATTERN_LISTS) if (!sameList(rule.patterns[k], DEFAULT_PATTERNS[k])) patterns[k] = [...rule.patterns[k]];
  if (Object.keys(patterns).length) out.patterns = patterns;
  return out;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The section override in force for a heading title, if any. */
export const sectionOverride = (rule: WordCountRule, title: string | null): Part | null => (title == null ? null : rule.sections[sectionKey(title)] ?? null);

export const COUNT_AS: readonly { value: Part; label: string }[] = [
  { value: 'main', label: 'Main text' },
  { value: 'statements', label: 'Statements' },
  { value: 'appendix', label: 'Appendix' },
  { value: 'supplementary', label: 'Supplementary' },
  { value: 'excluded', label: 'Not counted' },
];

/** The rows of the parts list: every part but 'references' (never counted) and 'excluded' (shown apart). */
export const COUNTABLE_PARTS: readonly Part[] = PARTS.filter((p) => p !== 'references' && p !== 'excluded');
