import { describe, expect, it } from 'vitest';
import { DEFAULT_RULE, KINDS, PARTS, PATTERN_LISTS, PRESET_IDS, countDocument, resolveRule, type WordCountRule } from '../../../wordcount/engine';
import {
  breakdownText, deriveView, fileWords, hasIncludes, isOver, presetFor, selectionWords, sparseRule, splice, statusText, statusTitle,
  withKind, withPart, withPreset, withSection, type Breakdown,
} from '../model';
import { STORED_KINDS, STORED_PARTS, STORED_PATTERN_LISTS, STORED_PRESETS, ruleProblem, validStoredRule } from '../validate';

/** What the server's breakdown route answers for these files (count.ts, less the parts the status does not use). */
function breakdown(files: Record<string, string>, root = 'main.tex', rule: WordCountRule = DEFAULT_RULE): Breakdown {
  const doc = countDocument(root, (p) => files[p] ?? null, rule);
  return {
    ...doc, rule, ruleSource: 'default', ruleName: 'Main text', citeWords: {}, worksCited: doc.citedKeys.length,
    otherDocuments: [], unreachable: [],
  };
}

const PAPER: Record<string, string> = {
  'main.tex': [
    '\\documentclass{article}',
    '\\title{A Title Here}',
    '\\begin{document}',
    '\\section{Introduction}',
    'Five words of main text.',
    '\\input{sections/method}',
    '\\section{Supplementary Materials}',
    'Two words.',
    '\\end{document}',
  ].join('\n'),
  'sections/method.tex': '\\section{Method}\nWe asked six people a question.\n',
};

describe('the stored rule', () => {
  it('lists the same parts, kinds, presets and pattern lists as the engine', () => {
    expect([...STORED_PARTS]).toEqual([...PARTS]);
    expect([...STORED_KINDS]).toEqual([...KINDS]);
    expect([...STORED_PRESETS]).toEqual([...PRESET_IDS]);
    expect([...STORED_PATTERN_LISTS]).toEqual([...PATTERN_LISTS]);
  });

  it('accepts null and every sparse rule the editors write, and refuses what the server refuses', () => {
    expect(validStoredRule(null)).toBe(true);
    expect(sparseRule(DEFAULT_RULE)).toEqual({ v: 1, preset: 'main' });
    const custom = withSection(withKind(withPart(DEFAULT_RULE, 'supplementary', true), 'tables', true), 'Method', 'excluded');
    const stored = sparseRule({ ...custom, target: 4000, formulas: 'one-word' });
    expect(stored).toEqual({
      v: 1, preset: 'custom', parts: ['main', 'supplementary'], kinds: ['text', 'headings', 'citations', 'footnotes', 'tables'],
      formulas: 'one-word', target: 4000, sections: { method: 'excluded' },
    });
    expect(ruleProblem(stored)).toBeNull();
    // the round trip through the engine gives the same rule back
    expect(sparseRule(resolveRule(stored))).toEqual(stored);
    expect(validStoredRule({ preset: 'nope' })).toBe(false);
    expect(validStoredRule({ target: 0 })).toBe(false);
    expect(validStoredRule({ parts: ['main', 'main'] })).toBe(false);
    expect(validStoredRule({ extra: 1 })).toBe(false);
    expect(validStoredRule('main')).toBe(false);
  });

  it('names the preset that parts and kinds amount to', () => {
    expect(presetFor(['main'], ['text', 'headings', 'citations', 'footnotes'])).toBe('main');
    expect(withPart(DEFAULT_RULE, 'abstract', true).preset).toBe('main-abstract');
    expect(withKind(DEFAULT_RULE, 'captions', true).preset).toBe('main-captions');
    expect(withPart(DEFAULT_RULE, 'supplementary', true).preset).toBe('custom');
    expect(withPreset(withPart(DEFAULT_RULE, 'supplementary', true), 'main').parts).toEqual(['main']);
  });
});

describe('the status text', () => {
  it('reads as the plan has it', () => {
    expect(statusText({ total: 3412, target: null, sel: null, inDoc: true })).toBe('3,412 words');
    expect(statusText({ total: 1, target: null, sel: null, inDoc: true })).toBe('1 word');
    expect(statusText({ total: 3412, target: 4000, sel: null, inDoc: true })).toBe('3,412 / 4,000 words');
    const over = { total: 4212, target: 4000, sel: null, inDoc: true };
    expect(statusText(over)).toBe('4,212 / 4,000 words');
    expect(isOver(over)).toBe(true);
    expect(statusTitle(over, 'Main text')).toMatch(/^212 words over the target/);
    expect(isOver({ ...over, total: 4000 })).toBe(false);
    expect(statusText({ total: 3412, target: 4000, sel: 214, inDoc: true })).toBe('214 of 3,412 words');
    expect(isOver({ ...over, sel: 3 })).toBe(false);
    expect(statusText({ total: 812, target: null, sel: null, inDoc: false })).toBe('This file: 812 words');
  });
});

describe('the live splice', () => {
  it('counts main text only by default, and replaces only the edited file', () => {
    const b = breakdown(PAPER);
    // Introduction (1) + 5 words, Method (1) + 6 words; the title page and the supplement are not counted
    expect(deriveView(b.segments, b.rule).total).toBe(13);
    const r = splice(b, 'sections/method.tex', '\\section{Method}\nWe asked six people a question twice over.\n', b.rule);
    expect(r.refetch).toBe(false);
    expect(r.segments).not.toBeNull();
    const v = deriveView(r.segments!, b.rule);
    expect(v.total).toBe(15);
    expect(v.files['sections/method.tex']).toBe(9);
    expect(v.files['main.tex']).toBe(6);
    // the sections still run in document order across the files (the title page sits before the first heading)
    expect(v.sections.map((s) => s.title)).toEqual([null, 'Introduction', 'Method', 'Supplementary Materials']);
    // the root's segments are the server's own objects
    expect(r.segments!.filter((s) => s.file === 'main.tex')).toEqual(b.segments.filter((s) => s.file === 'main.tex'));
  });

  it('asks the server again when an edit changes what follows the file', () => {
    const b = breakdown(PAPER);
    const r = splice(b, 'sections/method.tex', '\\section{Method}\nWords.\n\\appendix\n', b.rule);
    expect(r.refetch).toBe(true);
  });

  it('leaves a file that includes others to the server, and a file outside the document alone', () => {
    const b = breakdown(PAPER);
    expect(splice(b, 'main.tex', PAPER['main.tex'], b.rule)).toEqual({ segments: null, refetch: true });
    expect(splice(b, 'notes.tex', 'Some notes.', b.rule)).toEqual({ segments: null, refetch: false });
    expect(splice(b, 'sections/method.tex', 'Text.\n\\input{more}\n', b.rule).refetch).toBe(true);
    expect(hasIncludes('% \\input{x}\nText')).toBe(false);
    expect(hasIncludes('100\\% \\include{x}')).toBe(true);
  });

  it('counts a single-file document live, from the root entry state', () => {
    const one = { 'main.tex': '\\documentclass{article}\n\\begin{document}\nOne two three.\n\\end{document}\n' };
    const b = breakdown(one);
    expect(deriveView(b.segments, b.rule).total).toBe(3);
    const r = splice(b, 'main.tex', one['main.tex'].replace('three.', 'three four.'), b.rule);
    expect(deriveView(r.segments!, b.rule).total).toBe(4);
    expect(r.refetch).toBe(false);
  });

  it('turning on Supplementary adds its words; a section marked Not counted drops them', () => {
    const supp = withPart(DEFAULT_RULE, 'supplementary', true);
    const b = breakdown(PAPER, 'main.tex', supp);
    expect(deriveView(b.segments, supp).total).toBe(13 + 2 + 2);
    const noMethod = withSection(DEFAULT_RULE, 'Method', 'excluded');
    const b2 = breakdown(PAPER, 'main.tex', noMethod);
    expect(deriveView(b2.segments, noMethod).total).toBe(6);
  });

  it('counts a selection by what would print, whatever the rule, and a stray file on its own', () => {
    expect(selectionWords('Some \\textbf{bold} words % and a comment')).toBe(3);
    expect(selectionWords('\\begin{table}a & b\\end{table}')).toBe(2);
    expect(fileWords('Notes for later.', DEFAULT_RULE)).toBe(3);
  });

  it('copies a plain-text breakdown', () => {
    const b = breakdown(PAPER);
    const text = breakdownText(b, deriveView(b.segments, b.rule), b.rule);
    expect(text).toContain('Word count: 13 words (Main text, the built-in rule)');
    expect(text).toContain('Supplementary material: 4 (not counted)');
    expect(text).toContain('Method: 7');
  });
});
