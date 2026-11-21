import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { buildVocabulary, createWordProvider, lookupWord, mergeVocabularies, proseOf, typedWordAt, DOC_VOCAB_MS } from '../wordProvider';

const words = (text: string) => [...buildVocabulary([text]).counts.keys()].sort();

describe('proseOf', () => {
  it('keeps prose and text arguments, drops command names', () => {
    expect(words('The \\textbf{measurement} and \\emph{experiment} \\section{Introduction}')).toEqual(['experiment', 'introduction', 'measurement']);
  });

  it('drops math, comments, verbatim and key or path arguments', () => {
    const src = [
      'Prose before $\\alphabetical + \\variable$ and \\[ displayed formulation \\] and \\(inlinemath\\).',
      '% a commented paragraph here',
      '50\\% percentage remains',
      '\\cite{measurementkey} \\ref{fig:experimental} \\label{sec:introduction} \\includegraphics[width=1cm]{figures/landscape}',
      '\\begin{equation} equationword \\end{equation}',
      '\\begin{verbatim} verbatimword \\end{verbatim}',
      '\\href{https://example.org/somewhere}{clickable description}',
      '\\usepackage{hyperrefs}',
    ].join('\n');
    expect(words(src)).toEqual(['clickable', 'description', 'percentage', 'remains']);
  });

  it('drops a typesetting file\'s preamble', () => {
    const src = '\\documentclass{article}\n\\title{Preamblewords}\n\\begin{document}\nDocumentwords here\n\\end{document}';
    expect(words(src)).toEqual(['documentwords']);
  });

  it('keeps line breaks, so positions line up', () => {
    const src = 'a $x$\n% c\nb';
    expect(proseOf(src).split('\n')).toHaveLength(3);
    expect(proseOf(src).length).toBe(src.length);
  });
});

describe('lookupWord', () => {
  const v = buildVocabulary(['The measurement was careful. The measurement again. A measure of meaning. Mechanism mechanisms.']);

  it('completes a word seen twice after three letters', () => {
    expect(lookupWord(v, 'mea')).toBe('surement');
    expect(lookupWord(v, 'measu')).toBe('rement');
    expect(lookupWord(v, 'me')).toBeNull();
  });

  it('needs two occurrences and a clear winner', () => {
    expect(lookupWord(v, 'mech')).toBeNull(); // mechanism 1, mechanisms 1
    expect(lookupWord(buildVocabulary(['experiment once']), 'exp')).toBeNull();
    const tie = buildVocabulary(['observation observation observer observer']);
    expect(lookupWord(tie, 'obs')).toBeNull();
    const clear = buildVocabulary(['observation observation observation observation observers observers']);
    expect(lookupWord(clear, 'obs')).toBe('ervation');
  });

  it('never suggests the word already typed out', () => {
    expect(lookupWord(v, 'measurement')).toBeNull();
  });

  it('copies the case that was typed', () => {
    expect(lookupWord(v, 'Meas')).toBe('urement');
    expect(lookupWord(v, 'MEAS')).toBe('UREMENT');
  });

  it('relaxes the thresholds when asked for explicitly', () => {
    expect(lookupWord(v, 'mech', { explicit: true })).toBe('anism');
    expect(lookupWord(v, 'm', { explicit: true })).toBe('easurement');
  });

  it('adds the counts of two vocabularies', () => {
    const merged = mergeVocabularies(buildVocabulary(['experiment here']), buildVocabulary(['another experiment']));
    expect(merged.counts.get('experiment')).toBe(2);
    expect(lookupWord(merged, 'expe')).toBe('riment');
  });
});

describe('typedWordAt', () => {
  const at = (src: string) => {
    const pos = src.indexOf('|');
    const doc = src.slice(0, pos) + src.slice(pos + 1);
    return typedWordAt(EditorState.create({ doc, selection: EditorSelection.cursor(pos) }), pos);
  };
  it('finds the word the caret ends', () => {
    expect(at('the meas|')).toEqual({ from: 4, word: 'meas' });
    expect(at('(meas|)')).toEqual({ from: 1, word: 'meas' });
  });
  it('ignores commands, mid-word carets and subscripts', () => {
    expect(at('\\meas|')).toBeNull();
    expect(at('mea|sure')).toBeNull();
    expect(at('x_abc|')).toBeNull();
    expect(at('the |')).toBeNull();
  });
});

describe('createWordProvider', () => {
  const state = (src: string) => {
    const pos = src.indexOf('|');
    const doc = src.slice(0, pos) + src.slice(pos + 1);
    return { state: EditorState.create({ doc, selection: EditorSelection.cursor(pos) }), pos };
  };

  it('reads the open file without the word being typed, and the project\'s files', async () => {
    let clock = 0;
    let reads = 0;
    const p = createWordProvider({ now: () => clock, projectTexts: async () => { reads++; return ['The experiment worked. The experiment failed.']; } });
    const a = state('One measurement and another measurement. measurement measu|');
    // the open file's third "measurement" counts; the typed "measu" never does
    expect(p.suggest({ ...a, word: 'measu', explicit: false }, new AbortController().signal)).toBe('rement');
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock += DOC_VOCAB_MS;
    const b = state('Nothing here. expe|');
    expect(p.suggest({ ...b, word: 'expe', explicit: false }, new AbortController().signal)).toBe('riment');
    expect(reads).toBe(1);
  });

  it('answers nothing at a word boundary', () => {
    const p = createWordProvider();
    const a = state('measurement measurement |');
    expect(p.suggest({ ...a, word: '', explicit: false }, new AbortController().signal)).toBeNull();
  });
});
