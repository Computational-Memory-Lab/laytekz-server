import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { latexCompletions } from 'codemirror-lang-latex';
import { CATALOGUE, entryByTrigger, searchCatalogue, triggersStartingWith } from '../catalogue';
import { render, templateFields } from '../render';
import { KINDS } from '../format';
import { everydayLabels } from '../../../../editor/completions';
import * as vocab from '../../../../latex/vocab';
import { APA7, isStatsStyleDiff, resolveStyle, styleDiff } from '../style';

/** Control words defined by the kernel, plain TeX and packages papers commonly load. */
const COMMON = [
  'bf', 'it', 'rm', 'sf', 'tt', 'sc', 'sl', 'em', 'cal', 'mit', 'pi', 'kappa', 'sec', 'deg', 'det', 'dim', 'exp', 'inf',
  'ker', 'lg', 'ln', 'log', 'max', 'min', 'Pr', 'sin', 'sup', 'tan', 'cos', 'cot', 'csc', 'arg', 'gcd', 'hom', 'lim', 'mod',
  'num', 'si', 'SI', 'qty', 'unit', 'ang', 'per', 'tablenum', 'over', 'atop', 'span', 'char', 'count', 'box', 'copy', 'mark',
  'show', 'the', 'par', 'kern', 'hbox', 'vbox', 'mbox', 'text', 'textit', 'mathit', 'mathrm', 'hat', 'bar', 'dot', 'vec',
  'cite', 'ref', 'eqref', 'label', 'url', 'href', 'item', 'pm', 'mp', 'times', 'div', 'cdot', 'ast', 'star', 'circ', 'bullet',
  'iff', 'implies', 'mid', 'nmid', 'parallel', 'perp', 'neq', 'leq', 'geq', 'approx', 'sim', 'equiv', 'cong', 'propto',
];

const realCommands = new Set<string>([
  ...latexCompletions.commands.map((c) => c.replace(/^\\/, '').replace(/[{[].*$/, '')),
  ...latexCompletions.mathCommands.map((c) => c.replace(/^\\/, '').replace(/[{[].*$/, '')),
  ...everydayLabels().map((l) => l.replace(/^\\/, '')),
  ...vocab.GREEK_LETTERS, ...vocab.MATH_ONLY_COMMANDS, ...vocab.MATH_OPERATOR_NAMES,
  ...vocab.GREEK_LETTERS.map((g) => `up${g}`),
  ...COMMON,
]);

describe('the statistics catalogue', () => {
  it('has unique triggers of the form \\letters with optional digits', () => {
    const triggers = CATALOGUE.map((e) => e.trigger).filter(Boolean) as string[];
    expect(triggers.length).toBeGreaterThan(80);
    expect(new Set(triggers).size).toBe(triggers.length);
    expect(new Set(CATALOGUE.map((e) => e.id)).size).toBe(CATALOGUE.length);
    for (const t of triggers) expect(t).toMatch(/^\\[a-z]+\d*$/);
  });

  it('never shadows a real LaTeX command', () => {
    for (const e of CATALOGUE) {
      if (!e.trigger) continue;
      // TeX reads a control word as letters only, so \bf10 would be \bf followed by 10.
      const word = e.trigger.slice(1).replace(/\d+$/, '');
      expect(realCommands.has(word), `${e.trigger} shadows \\${word}`).toBe(false);
    }
  });

  it('gives every entry unique field labels and known kinds', () => {
    for (const e of CATALOGUE) {
      const fields = templateFields(e.template);
      expect(new Set(fields.map((f) => f.label)).size, e.id).toBe(fields.length);
      for (const f of fields) expect(KINDS, `${e.id}: ${f.kind}`).toContain(f.kind);
    }
  });

  it('renders balanced in prose and without dollars in math, never with \\text', () => {
    for (const e of CATALOGUE) {
      const prose = render(e).text;
      const math = render(e, { context: 'math' }).text;
      expect((prose.replace(/\\\$/g, '').match(/\$/g) ?? []).length % 2, e.id).toBe(0);
      if (e.id !== 'pcell') expect(math, e.id).not.toMatch(/(?<!\\)\$/);
      for (const s of [prose, math]) {
        let depth = 0;
        for (const c of s.replace(/\\[{}]/g, '')) { depth += c === '{' ? 1 : c === '}' ? -1 : 0; expect(depth, e.id).toBeGreaterThanOrEqual(0); }
        expect(depth, e.id).toBe(0);
        expect(s, e.id).not.toMatch(/\\text(?![a-z])/);
      }
    }
  });

  it('finds entries by prefix and by search words', () => {
    expect(triggersStartingWith('\\pv').map((e) => e.trigger)).toEqual(['\\pval']);
    expect(triggersStartingWith('\\bayes1').map((e) => e.trigger)).toEqual(['\\bayes10']);
    expect(searchCatalogue('mann whitney').map((e) => e.id)).toContain('mannwhitney');
    expect(searchCatalogue('eta partial').map((e) => e.id)).toContain('etasqp');
    expect(searchCatalogue('anova')[0]).toBeTruthy();
    expect(entryByTrigger('\\anova')?.group).toBe('Report lines');
  });
});

describe('the house style', () => {
  it('validates stored differences and resolves them over APA 7', () => {
    expect(isStatsStyleDiff({})).toBe(true);
    expect(isStatsStyleDiff({ leadingZero: 'always', pDecimals: 2 })).toBe(true);
    expect(isStatsStyleDiff({ leadingZero: 'sometimes' })).toBe(false);
    expect(isStatsStyleDiff({ decimals: 2.5 })).toBe(false);
    expect(isStatsStyleDiff({ unknown: 1 })).toBe(false);
    expect(isStatsStyleDiff([])).toBe(false);
    expect(isStatsStyleDiff(null)).toBe(false);
    expect(isStatsStyleDiff(JSON.parse('{"__proto__": {"x": 1}}'))).toBe(false);
    expect(resolveStyle({ leadingZero: 'always', decimals: 'x' })).toEqual({ ...APA7, leadingZero: 'always' });
    expect(resolveStyle('garbage')).toEqual(APA7);
    expect(styleDiff({ ...APA7, pDecimals: 2 })).toEqual({ pDecimals: 2 });
  });

  it('is byte-identical to the server copy and imports nothing', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
    const web = read('../style.ts');
    const server = read('../../../../../../server/src/features/stats/style.ts');
    expect(Buffer.compare(web, server)).toBe(0);
    expect(web.toString('utf8')).not.toMatch(/^\s*import\s/m);
  });
});
