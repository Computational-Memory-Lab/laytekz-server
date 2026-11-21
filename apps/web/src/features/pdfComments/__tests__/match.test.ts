import { describe, it, expect } from 'vitest';
import { lineStarts, locateSelection, paragraphSpan, pdfKey, sourceKey } from '../match';

const at = (doc: string, r: { from: number; to: number } | null) => (r ? doc.slice(r.from, r.to) : null);
const lineOf = (doc: string, needle: string) => doc.slice(0, doc.indexOf(needle)).split('\n').length;

describe('pdfKey', () => {
  it('keeps letters and digits, folds case, accents and ligatures, drops soft hyphens', () => {
    expect(pdfKey('Eﬃcient   Café, 2nd-order­!')).toBe('efficientcafe2ndorder');
  });
});

describe('sourceKey', () => {
  it('leaves out comments, command names and arguments that do not print as themselves', () => {
    const src = 'See \\emph{this} \\label{sec:a}and \\cite[p.~3]{knuth} % not this\nthat \\\'e\\\\ end';
    const sk = sourceKey(src, 0, src.length);
    expect(sk.key).toBe('seethisandthateend');
    // every kept character points back at itself
    for (let i = 0; i < sk.key.length; i++) expect(pdfKey(src.slice(sk.at[i], sk.end[i]))).toBe(sk.key[i]);
  });
});

describe('paragraphSpan', () => {
  it('runs to the blank lines around the lines asked about', () => {
    const doc = 'a\n\nb1\nb2\nb3\n\nc';
    const starts = lineStarts(doc);
    const span = paragraphSpan(doc, starts, 4, 4);
    expect(doc.slice(span.from, span.to)).toBe('b1\nb2\nb3\n');
  });
});

describe('locateSelection', () => {
  const doc = [
    '\\documentclass{article}',
    '\\begin{document}',
    '\\section{Intro}\\label{sec:intro}',
    'The \\emph{quick} brown fox jumps over',
    'the lazy dog, as shown by Knuth \\cite{knuth}, and the',
    'algorithm is efficient in practice.',
    '',
    'A caf\\\'e serves the quick brown fox.',
    '\\end{document}',
  ].join('\n');

  it('finds words across commands and line breaks', () => {
    const r = locateSelection(doc, 4, 'quick brown fox jumps over the lazy');
    expect(at(doc, r)).toBe('quick} brown fox jumps over\nthe lazy');
    expect(r?.exact).toBe(true);
  });

  it('takes the occurrence nearest the line SyncTeX gave', () => {
    const second = locateSelection(doc, lineOf(doc, 'A caf'), 'the quick brown fox');
    expect(second && second.from).toBeGreaterThan(doc.indexOf('A caf'));
    const first = locateSelection(doc, 4, 'quick brown');
    expect(first && first.from).toBeLessThan(doc.indexOf('A caf'));
  });

  it('matches PDF text with ligatures, hyphenation and accents', () => {
    expect(at(doc, locateSelection(doc, 6, 'algo-\nrithm is eﬃcient'))).toBe('algorithm is efficient');
    expect(at(doc, locateSelection(doc, 8, 'A café serves'))).toBe('A caf\\\'e serves');
  });

  it('spans a citation the PDF prints as a number, from the start to the end of the selection', () => {
    const r = locateSelection(doc, 5, 'the lazy dog, as shown by Knuth [1], and the algorithm is efficient');
    expect(at(doc, r)).toBe('the lazy dog, as shown by Knuth \\cite{knuth}, and the\nalgorithm is efficient');
    expect(r?.exact).toBe(false);
  });

  it('looks a little beyond the paragraph when SyncTeX is a few lines off', () => {
    expect(at(doc, locateSelection(doc, 9, 'lazy dog'))).toBe('lazy dog');
  });

  it('gives null when the words are not there, rather than anchoring elsewhere', () => {
    expect(locateSelection(doc, 4, 'nothing of the sort appears here')).toBeNull();
    expect(locateSelection(doc, 4, '  — ')).toBeNull();
  });

  it('clamps a line past the end of a document that changed since the typeset', () => {
    expect(at(doc, locateSelection(doc, 400, 'serves the'))).toBe('serves the');
  });
});
