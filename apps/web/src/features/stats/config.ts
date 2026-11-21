import { Facet, type EditorState } from '@codemirror/state';
import { contextAt, documentPackages, tableEnvAt } from '../../editor/texContext';
import { rootPreambleText } from '../../editor/visual/context';
import { loadedPackages } from '../../editor/visual/preamble';
import { APA7, type StatsStyle } from './core/style';
import { greekMode, type GreekMode, type InsertContext } from './core/render';

/**
 * What the statistics editor reads from the settings, provided by the
 * feature's compartment (rebuilt when one of the settings changes), so the
 * editor code and the automatic math formatter stay pure functions of the
 * editor state.
 */
export interface StatsConfig {
  style: StatsStyle;
  /** Triggers in the completion list, and Tab after a typed trigger. */
  triggers: boolean;
  /** Format each number as its field is left. */
  formatOnLeave: boolean;
  /** Statistics typed in prose get the house style when automatic math mode wraps them. */
  typed: boolean;
  /** Offer to convert pasted program output. */
  paste: boolean;
}

export const DEFAULT_STATS_CONFIG: StatsConfig = Object.freeze({
  style: APA7, triggers: true, formatOnLeave: true, typed: true, paste: true,
});

export const statsConfig: Facet<StatsConfig, StatsConfig> = Facet.define<StatsConfig, StatsConfig>({
  combine: (values) => values[values.length - 1] ?? DEFAULT_STATS_CONFIG,
});

export interface Insertion {
  context: InsertContext;
  sColumn: boolean;
  /** Where a trigger may expand: text, a table cell or math (not comments, verbatim, keys, URLs or code). */
  triggerOk: boolean;
}

/** How a statistic inserted at `pos` is written. */
export function insertionAt(state: EditorState, pos: number): Insertion {
  let ctx = null;
  try { ctx = contextAt(state, pos); } catch { ctx = null; }
  if (!ctx) return { context: 'prose', sColumn: false, triggerOk: false };
  if (ctx.kind === 'math') return { context: 'math', sColumn: false, triggerOk: true };
  if (ctx.kind === 'table' && ctx.table) {
    return { context: 'cell', sColumn: sColumnAt(state, pos, ctx.table.column), triggerOk: true };
  }
  return { context: 'prose', sColumn: false, triggerOk: ctx.kind === 'text' };
}

/** The column letters of a tabular preamble ("l S[table-format=1.3] |c" → l, S, c). */
export function columnLetters(spec: string): string[] {
  let s = spec.replace(/\s+/g, '');
  // *{n}{cols}, once deep.
  s = s.replace(/\*\{(\d+)\}\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, n: string, cols: string) => cols.repeat(Math.min(Number(n), 50)));
  s = s.replace(/[@!<>]\{(?:[^{}]|\{[^{}]*\})*\}/g, '').replace(/\[[^\]]*\]/g, '').replace(/\{(?:[^{}]|\{[^{}]*\})*\}/g, '').replace(/[|:]/g, '');
  return [...s].filter((c) => /[A-Za-z]/.test(c));
}

function sColumnAt(state: EditorState, pos: number, column: number): boolean {
  let env = null;
  try { env = tableEnvAt(state, pos); } catch { env = null; }
  if (!env) return false;
  const head = state.sliceDoc(env.from, Math.min(env.bodyFrom, env.from + 600));
  const groups = [...head.matchAll(/\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g)];
  const spec = groups[groups.length - 1]?.[1];
  if (!spec) return false;
  return columnLetters(spec)[column] === 'S';
}

/** Upright Greek where this file's preamble or the main file's loads upgreek or unicode-math. */
export function greekFor(state: EditorState, style: StatsStyle): GreekMode {
  let packages: ReadonlySet<string> = new Set();
  try { packages = documentPackages(state); } catch { /* the tree is not ready */ }
  let root: Set<string> = new Set();
  try { root = loadedPackages(rootPreambleText() ?? ''); } catch { /* no root preamble yet */ }
  const has = (p: string) => packages.has(p) || root.has(p);
  return greekMode(style, { upgreek: has('upgreek'), unicodeMath: has('unicode-math') });
}

const DEFINITION = /\\(?:(?:re|provide)?newcommand\*?|DeclareMathOperator\*?|(?:New|Renew|Provide|Declare)DocumentCommand|DeclareRobustCommand\*?)\s*\{?\s*\\([A-Za-z]+)|\\[gex]?def\s*\\([A-Za-z]+)|\\let\s*\\([A-Za-z]+)/g;

const definedCache = new WeakMap<object, Set<string>>();
let rootCache: { text: string; names: Set<string> } | null = null;

/** Control words the text defines (\newcommand, \def, \DeclareMathOperator, \let …), without the backslash. */
export function definedMacros(text: string): Set<string> {
  const out = new Set<string>();
  DEFINITION.lastIndex = 0;
  for (let m = DEFINITION.exec(text); m; m = DEFINITION.exec(text)) out.add(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The paper's own macros (this file and the main file's preamble): a trigger of the same name is hidden. */
export function paperMacros(state: EditorState): ReadonlySet<string> {
  let own = definedCache.get(state.doc);
  if (!own) { own = definedMacros(state.doc.toString()); definedCache.set(state.doc, own); }
  const rootText = (() => { try { return rootPreambleText() ?? ''; } catch { return ''; } })();
  if (!rootText) return own;
  if (rootCache?.text !== rootText) rootCache = { text: rootText, names: definedMacros(rootText) };
  if (!rootCache.names.size) return own;
  return new Set([...own, ...rootCache.names]);
}
