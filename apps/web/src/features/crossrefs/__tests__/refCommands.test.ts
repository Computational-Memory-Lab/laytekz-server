import { describe, expect, it } from 'vitest';
import {
  buildReference, detectSetupIn, groupOf, joinRefs, kindLabel, nameBefore, NO_SETUP, plural, rankLabels, refSetupOf, stylesFor,
  type LabelDetail, type RefSetup,
} from '../refCommands';

const fig = (label: string, title = ''): LabelDetail => ({ label, file: 'main.tex', kind: 'figure', env: 'figure', title });
const tab = (label: string): LabelDetail => ({ label, file: 'main.tex', kind: 'table', env: 'table' });
const eq = (label: string): LabelDetail => ({ label, file: 'main.tex', kind: 'equation', env: 'align' });
const sec = (label: string, title = ''): LabelDetail => ({ label, file: 'sec/intro.tex', kind: 'section', env: 'section', title });
const hyp = (label: string): LabelDetail => ({ label, file: 'main.tex', kind: 'theorem', env: 'hyp', envTitle: 'Hypothesis' });
const item = (label: string): LabelDetail => ({ label, file: 'main.tex', kind: 'item', env: 'enumerate' });

const cleveref: RefSetup = { ...NO_SETUP, cleveref: true };
const apa7: RefSetup = { ...NO_SETUP, cleveref: true, documentClass: 'apa7' };
const ams: RefSetup = { ...NO_SETUP, amsmath: true };

describe('the automatic form', () => {
  it('without cleveref names the kind: Figure~\\ref{fig:x}', () => {
    expect(buildReference([fig('fig:x')], { style: 'auto', setup: NO_SETUP })).toBe('Figure~\\ref{fig:x}');
    expect(buildReference([tab('tab:a')], { style: 'auto', setup: NO_SETUP })).toBe('Table~\\ref{tab:a}');
    expect(buildReference([sec('sec:m')], { style: 'auto', setup: NO_SETUP })).toBe('Section~\\ref{sec:m}');
    expect(buildReference([hyp('hyp:1')], { style: 'auto', setup: NO_SETUP })).toBe('Hypothesis~\\ref{hyp:1}');
    expect(buildReference([item('item:a')], { style: 'auto', setup: NO_SETUP })).toBe('\\ref{item:a}');
    expect(buildReference([{ label: 'ch:a', file: 'a.tex', kind: 'chapter', env: 'chapter' }], { style: 'auto', setup: NO_SETUP })).toBe('Chapter~\\ref{ch:a}');
    expect(buildReference([{ label: 'app:a', file: 'a.tex', kind: 'appendix', env: 'section' }], { style: 'auto', setup: NO_SETUP })).toBe('Appendix~\\ref{app:a}');
  });

  it('equations: \\eqref with amsmath, else (\\ref)', () => {
    expect(buildReference([eq('eq:1')], { style: 'auto', setup: ams })).toBe('\\eqref{eq:1}');
    expect(buildReference([eq('eq:1')], { style: 'auto', setup: NO_SETUP })).toBe('(\\ref{eq:1})');
  });

  it('with cleveref: \\cref mid-sentence, \\Cref at a sentence start, \\Cref everywhere under apa7', () => {
    expect(buildReference([fig('fig:x')], { style: 'auto', setup: cleveref })).toBe('\\cref{fig:x}');
    expect(buildReference([fig('fig:x')], { style: 'auto', setup: cleveref, sentenceStart: true })).toBe('\\Cref{fig:x}');
    expect(buildReference([fig('fig:x')], { style: 'auto', setup: cleveref, sentenceStart: true, capitalise: false })).toBe('\\cref{fig:x}');
    expect(buildReference([fig('fig:x')], { style: 'auto', setup: apa7 })).toBe('\\Cref{fig:x}');
    expect(buildReference([fig('a'), tab('b')], { style: 'auto', setup: apa7 })).toBe('\\Cref{a,b}');
  });

  it('joins several labels APA-style', () => {
    expect(buildReference([fig('a'), fig('b')], { style: 'auto', setup: NO_SETUP })).toBe('Figures~\\ref{a} and~\\ref{b}');
    expect(buildReference([fig('a'), fig('b'), fig('c')], { style: 'auto', setup: NO_SETUP })).toBe('Figures~\\ref{a}, \\ref{b}, and~\\ref{c}');
    expect(buildReference([hyp('a'), hyp('b')], { style: 'auto', setup: NO_SETUP })).toBe('Hypotheses~\\ref{a} and~\\ref{b}');
    expect(buildReference([fig('a'), tab('b')], { style: 'auto', setup: NO_SETUP })).toBe('Figure~\\ref{a} and Table~\\ref{b}');
    expect(buildReference([eq('a'), eq('b')], { style: 'auto', setup: ams })).toBe('\\eqref{a} and~\\eqref{b}');
    expect(joinRefs(['x'])).toBe('x');
  });

  it('leaves the name out when the text already names the kind', () => {
    expect(buildReference([fig('fig:x')], { style: 'auto', setup: NO_SETUP, named: true })).toBe('\\ref{fig:x}');
    expect(buildReference([fig('fig:x')], { style: 'auto', setup: cleveref, named: true })).toBe('\\ref{fig:x}');
    expect(buildReference([fig('a'), fig('b')], { style: 'name', setup: NO_SETUP, named: true })).toBe('\\ref{a} and~\\ref{b}');
  });
});

describe('the other forms', () => {
  it('writes what was chosen', () => {
    const l = [fig('a'), fig('b')];
    expect(buildReference(l, { style: 'cref', setup: NO_SETUP })).toBe('\\cref{a,b}');
    expect(buildReference(l, { style: 'Cref', setup: NO_SETUP })).toBe('\\Cref{a,b}');
    expect(buildReference(l, { style: 'ref', setup: NO_SETUP })).toBe('\\ref{a} and~\\ref{b}');
    expect(buildReference(l, { style: 'name', setup: cleveref })).toBe('Figures~\\ref{a} and~\\ref{b}');
    expect(buildReference([fig('a')], { style: 'pageref', setup: NO_SETUP })).toBe('page~\\pageref{a}');
    expect(buildReference([fig('a')], { style: 'pageref', setup: NO_SETUP, sentenceStart: true })).toBe('Page~\\pageref{a}');
    expect(buildReference([fig('a')], { style: 'autoref', setup: NO_SETUP })).toBe('\\autoref{a}');
  });

  it('offers only the forms the document can use, plus the one chosen in settings', () => {
    expect(stylesFor(NO_SETUP)).toEqual(['auto', 'name', 'ref', 'pageref']);
    expect(stylesFor({ ...NO_SETUP, cleveref: true, hyperref: true, amsmath: true })).toEqual(['auto', 'cref', 'Cref', 'name', 'ref', 'autoref', 'pageref', 'nameref', 'eqref']);
    expect(stylesFor(NO_SETUP, 'cref')).toContain('cref');
  });
});

describe('a kind name before the caret', () => {
  it('finds "Figure ", "fig." and "Tables~" for the matching kind only', () => {
    expect(nameBefore('as shown in Figure ', fig('a'))).toEqual({ from: 18, sep: ' ' });
    expect(nameBefore('see fig.', fig('a'))).toEqual({ from: 8, sep: '' });
    expect(nameBefore('see Tables~', tab('a'))).toEqual({ from: 10, sep: '~' });
    expect(nameBefore('see Table ', fig('a'))).toBeNull();
    expect(nameBefore('as shown in ', fig('a'))).toBeNull();
    expect(nameBefore('see \\figure ', fig('a'))).toBeNull();
    expect(nameBefore('Hypothesis ', hyp('a'))).not.toBeNull();
  });
});

describe('groups, kinds and search', () => {
  it('groups by kind and names it', () => {
    expect(groupOf({ kind: 'subfigure' })).toBe('figure');
    expect(groupOf({ kind: 'subsubsection' })).toBe('section');
    expect(groupOf({ kind: 'algorithm' })).toBe('listing');
    expect(groupOf({ kind: 'footnote' })).toBe('other');
    expect(kindLabel(eq('a'))).toBe('Equation');
    expect(plural('Property')).toBe('Properties');
    expect(plural('Lemma')).toBe('Lemmas');
  });

  it('lists by group then file order, and ranks a search by label, then title', () => {
    const labels = [sec('sec:intro', 'Introduction'), fig('fig:rt', 'Mean reaction times'), tab('tab:demo'), fig('fig:acc', 'Accuracy by condition')];
    expect(rankLabels(labels, '').map((l) => l.label)).toEqual(['fig:rt', 'fig:acc', 'tab:demo', 'sec:intro']);
    expect(rankLabels(labels, 'reaction').map((l) => l.label)).toEqual(['fig:rt']);
    expect(rankLabels(labels, 'fig acc').map((l) => l.label)).toEqual(['fig:acc']);
    expect(rankLabels(labels, 'intro').map((l) => l.label)).toEqual(['sec:intro']);
    expect(rankLabels(labels, '', 'table').map((l) => l.label)).toEqual(['tab:demo']);
  });
});

describe('the document setup', () => {
  it('reads the preamble when the server has not answered', () => {
    const s = detectSetupIn('\\documentclass[man]{apa7}\n\\usepackage{amsmath,hyperref}\n% \\usepackage{varioref}\n\\usepackage[capitalise]{cleveref}\n\\begin{document}\\usepackage{nameref}');
    expect(s).toEqual({ documentClass: 'apa7', cleveref: true, cleverefCapitalise: true, hyperref: true, amsmath: true, varioref: false, nameref: true });
  });

  it('takes the server answer\u2019s fields', () => {
    expect(refSetupOf({ documentClass: 'article', cleveref: true, hyperref: false, amsmath: true, family: 'bibtex' })).toMatchObject({ documentClass: 'article', cleveref: true, amsmath: true, varioref: false });
    expect(refSetupOf(null)).toBeNull();
  });
});
