import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RULE, applyRule, countDocument, countText, printedWords, resolveRule, sameState } from '../engine';

/**
 * The word-count engine has a byte-identical twin on the server (the web
 * image builds from apps/web alone, and NodeNext cannot import across the
 * apps). Edit apps/server/src/wordcount/engine.ts and copy it here.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));

describe('the word-count engine', () => {
  it('is byte-identical to the server copy and imports nothing', () => {
    const web = read('../engine.ts');
    const server = read('../../../../server/src/wordcount/engine.ts');
    expect(Buffer.compare(web, server)).toBe(0);
    expect(web.toString('utf8')).not.toMatch(/^\s*import\s/m);
  });

  it('counts main text only by default, with the parts kept apart', () => {
    const files: Record<string, string> = {
      'main.tex': '\\documentclass{article}\n\\title{A Title Here}\n\\begin{document}\n\\begin{abstract}Four abstract words here.\\end{abstract}\n\\section{Intro}\nFive words of main text.\n\\begin{table}\\input{t}\\end{table}\n\\section{Supplementary material}\nSupplement words.\n\\end{document}',
      't.tex': '\\begin{tabular}{ll} a & b \\\\ \\end{tabular}',
    };
    const doc = countDocument('main.tex', (p) => files[p] ?? null);
    expect(doc.total).toBe(1 + 5);
    expect(doc.parts.front).toBe(3);
    expect(doc.parts.abstract).toBe(4);
    expect(doc.parts.supplementary).toBe(2 + 2);
    expect(doc.tally.words['main:tables']).toBe(2);
    expect(applyRule(doc.tally, resolveRule({ preset: 'custom', parts: ['main', 'supplementary'], kinds: ['text', 'headings'] }))).toBe(6 + 4);
  });

  it('re-scans one file from its entry state and detects a change that needs a refetch', () => {
    const files: Record<string, string> = { 'main.tex': 'Root words.\n\\input{ch}\nAfter.', 'ch.tex': 'Chapter words here.' };
    const doc = countDocument('main.tex', (p) => files[p] ?? null);
    const occ = doc.occurrences.find((o) => o.file === 'ch.tex')!;
    const same = countText(files['ch.tex'], DEFAULT_RULE, { file: 'ch.tex', entry: occ.entry, macros: doc.macros });
    expect(same.total).toBe(doc.files['ch.tex']);
    expect(sameState(same.occurrences[0].exit, occ.exit)).toBe(true);
    const typed = countText('Chapter words here.\n\\appendix\nMore.', DEFAULT_RULE, { file: 'ch.tex', entry: occ.entry, macros: doc.macros });
    expect(sameState(typed.occurrences[0].exit, occ.exit)).toBe(false);
  });

  it('counts a selection as everything that prints', () => {
    const sel = countText('Two words \\footnote{and three more} \\caption{cap}');
    expect(printedWords(sel.tally)).toBe(6);
  });
});
