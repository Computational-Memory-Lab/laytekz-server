/**
 * The project word count under its rule (V2 WP24): what the REST routes and
 * the MCP tool answer. The rule is the project's (`ext['wordcount.rule']`),
 * else the asking account's default (the account preference of the same
 * name), else the built-in "Main text" rule. Results are cached per branch,
 * root file and rule, keyed by the content version every write bumps.
 *
 * indexes.ts keeps the shared derived indexes; its `wordCount` delegates
 * here once request R1 (docs/galley-v2/WP24.md) lands. The bib index is
 * passed in rather than imported, so this module and indexes.ts never import
 * each other.
 */
import * as store from '../store.js';
import { flushBranchDocs, contentVersion } from '../collab.js';
import { isHiddenPath } from '../util.js';
import { AUTH_ENABLED } from '../auth.js';
import { readPrefs } from '../features/prefs.js';
import type { ProjectMeta } from '../db/types.js';
import type { BibEntry } from '../bib.js';
import {
  DEFAULT_RULE, PART_LABELS, PRESETS, citeEstimate, countDocument, resolveRule, ruleHash,
  type DocumentCount, type Kind, type Part, type Tally, type WordCountRule,
} from './engine.js';
import { validRule } from './validate.js';

/** The project setting and the account preference that hold a stored rule. */
export const RULE_SETTING = 'wordcount.rule';

export type RuleSource = 'project' | 'account' | 'default';

export interface OtherDocument { file: string; total: number }

export interface WordCountResult extends Omit<DocumentCount, 'macros'> {
  rule: WordCountRule;
  ruleSource: RuleSource;
  ruleName: string;
  /** Estimated words per cited key (author-date form, from the .bib files). */
  citeWords: Record<string, number>;
  worksCited: number;
  macros: [string, string][];
  /** Other .tex files with their own \documentclass (a supplement kept as a separate document), each with its counted total. */
  otherDocuments: OtherDocument[];
  /** .tex files the root never reaches. */
  unreachable: string[];
  characters: { counted: number; countedWithSpaces: number };
  readingMinutes: number;
  target: { words: number; over: number } | null;
  abstract: { words: number; limit: number | null };
}

export type BibSource = (projectId: string, branch: string) => BibEntry[];

/** The rule in force for a project and the account asking, and where it came from. */
export async function resolveProjectRule(meta: ProjectMeta, userId: string | null | undefined): Promise<{ rule: WordCountRule; source: RuleSource }> {
  const own = meta.ext?.[RULE_SETTING];
  if (own !== undefined && validRule(own)) return { rule: resolveRule(own), source: 'project' };
  if (userId && AUTH_ENABLED) {
    try {
      const pref = (await readPrefs(userId)).prefs[RULE_SETTING];
      if (pref !== undefined && validRule(pref)) return { rule: resolveRule(pref), source: 'account' };
    } catch { /* no preferences store: the built-in rule */ }
  }
  return { rule: DEFAULT_RULE, source: 'default' };
}

export function ruleName(rule: WordCountRule): string {
  return rule.preset === 'custom' ? 'Custom' : PRESETS[rule.preset].label;
}

const CACHE_MAX = 200;
const cache = new Map<string, { v: number; body: WordCountResult }>();

/** Average silent reading speed for English non-fiction (Brysbaert, 2019). */
const WORDS_PER_MINUTE = 238;

function countedChars(t: Tally, rule: WordCountRule): number {
  let n = 0;
  for (const p of rule.parts) for (const k of rule.kinds) n += t.chars[`${p}:${k}`] ?? 0;
  return n;
}

/**
 * The whole document's count under the rule in force. `bib` gives the
 * branch's bibliography entries (indexes.bibIndex), for the citation
 * estimate; without it every cited key counts 2 words.
 */
export async function documentWordCount(projectId: string, branch: string, userId?: string | null, bib?: BibSource): Promise<WordCountResult> {
  flushBranchDocs(projectId, branch); // pending live edits reach disk first (may bump the version)
  const v = contentVersion(projectId, branch);
  const meta = await store.readMeta(projectId);
  const { rule, source } = await resolveProjectRule(meta, userId);
  // The root file and the rule are not branch content: switching either does not bump the version.
  const key = `${projectId}::${branch}::${meta.rootFile}::${ruleHash(rule)}`;
  const hit = cache.get(key);
  if (hit && hit.v === v) return { ...hit.body, ruleSource: source };

  const texts = new Map<string, string | null>();
  const read = (p: string): string | null => {
    if (texts.has(p)) return texts.get(p)!;
    let t: string | null = null;
    if (!isHiddenPath(p)) { try { t = store.readFile(projectId, branch, p).toString('utf8'); } catch { t = null; } }
    texts.set(p, t);
    return t;
  };
  const authors = new Map<string, string | undefined>();
  if (bib) { try { for (const e of bib(projectId, branch)) if (!authors.has(e.key)) authors.set(e.key, e.author); } catch { /* no estimate from the bib */ } }
  const citeWords = (k: string) => citeEstimate(authors.get(k));

  const doc = countDocument(meta.rootFile, read, rule, { citeWords });

  // Other documents and unreachable files: every .tex on the branch the root does not reach.
  const otherDocuments: OtherDocument[] = [];
  const unreachable: string[] = [];
  let tex: string[] = [];
  try { tex = store.listFiles(projectId, branch).filter((f) => f.type === 'file' && /\.(tex|ltx)$/i.test(f.path)).map((f) => f.path); } catch { tex = []; }
  for (const f of tex) {
    if (f === meta.rootFile || doc.files[f] !== undefined) continue;
    const t = read(f);
    if (t != null && /^[^%\n]*\\documentclass/m.test(t) && otherDocuments.length < 20) {
      otherDocuments.push({ file: f, total: countDocument(f, read, rule, { citeWords }).total });
    } else unreachable.push(f);
  }

  const cw: Record<string, number> = {};
  for (const k of doc.citedKeys) cw[k] = citeWords(k);
  const chars = countedChars(doc.tally, rule);
  const abstractWords = (['text', 'headings', 'citations', 'footnotes'] as Kind[]).reduce((n, k) => n + (doc.tally.words[`abstract:${k}`] ?? 0), 0);
  const body: WordCountResult = {
    ...doc,
    rule, ruleSource: source, ruleName: ruleName(rule),
    citeWords: cw, worksCited: doc.citedKeys.length,
    otherDocuments, unreachable,
    characters: { counted: chars, countedWithSpaces: chars + Math.max(0, doc.total - 1) },
    readingMinutes: Math.max(doc.total > 0 ? 1 : 0, Math.round(doc.total / WORDS_PER_MINUTE)),
    target: rule.target ? { words: rule.target, over: Math.max(0, doc.total - rule.target) } : null,
    abstract: { words: abstractWords, limit: rule.abstractLimit },
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { v, body });
  return body;
}

/**
 * The MCP tool's answer: the counted total and files (as before, now under
 * the rule) plus a compact breakdown an agent can relay. Fields are only
 * ever added (docs/STABILITY.md).
 */
export function mcpWordCount(r: WordCountResult) {
  const parts: Record<string, { words: number; counted: boolean; label: string }> = {};
  for (const p of Object.keys(r.parts) as Part[]) {
    if (r.parts[p] > 0 || r.rule.parts.includes(p)) parts[p] = { words: r.parts[p], counted: r.rule.parts.includes(p), label: PART_LABELS[p] };
  }
  return {
    rootFile: r.rootFile,
    total: r.total,
    files: r.files,
    rule: { name: r.ruleName, source: r.ruleSource, parts: r.rule.parts, kinds: r.rule.kinds, formulas: r.rule.formulas, target: r.rule.target, abstractLimit: r.rule.abstractLimit },
    parts,
    kinds: r.kinds,
    formulas: r.formulas,
    sections: r.sections.map((s) => ({ title: s.title, file: s.file, line: s.line, part: s.part, counted: s.counted })),
    target: r.target,
    abstract: r.abstract,
    worksCited: r.worksCited,
    why: r.why,
    unresolved: r.unresolved,
    otherDocuments: r.otherDocuments,
  };
}

/** The compact count for GET /api/projects/:id/wordcount and the MCP tool (requests R1 and R2); the full breakdown is GET …/wordcount/breakdown. */
export async function wordCountSummary(projectId: string, branch: string, userId?: string | null, bib?: BibSource) {
  return mcpWordCount(await documentWordCount(projectId, branch, userId, bib));
}
