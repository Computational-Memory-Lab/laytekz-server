import { describe, it, expect } from 'vitest';
import {
  atSentenceStart, buildCitation, citationFor, commandFor, detectFamilyIn, escapeNote, familyOfCommand, formatLocator,
  locatorOf, minimalChange, notesOf, parseCitationAt, styleOf, stylesFor, toggledCommand, wantsSpaceBefore,
} from '../citeCommands';

/** The citation at the | in `marked`. */
const at = (marked: string) => parseCitationAt(marked.replace('|', ''), marked.indexOf('|'));

describe('commands by family', () => {
  it('biblatex: \\parencite and \\textcite, \\Textcite at a sentence start', () => {
    expect(citationFor('biblatex', 'parenthetical', ['lamport1994'])).toBe('\\parencite{lamport1994}');
    expect(citationFor('biblatex', 'narrative', ['a'])).toBe('\\textcite{a}');
    expect(citationFor('biblatex', 'narrative', ['a'], {}, { sentenceStart: true })).toBe('\\Textcite{a}');
    expect(citationFor('biblatex', 'narrative', ['a'], {}, { sentenceStart: true, capitalise: false })).toBe('\\textcite{a}');
    expect(citationFor('biblatex', 'parenthetical', ['a', 'b'])).toBe('\\parencite{a,b}');
    expect(citationFor('biblatex', 'year', ['a'])).toBe('\\parencite*{a}');
  });

  it('biblatex takes a bare page and adds p. itself', () => {
    expect(citationFor('biblatex', 'parenthetical', ['a'], { postnote: formatLocator('biblatex', 'page', '12') })).toBe('\\parencite[12]{a}');
    expect(formatLocator('biblatex', 'page', '23-25')).toBe('23--25');
    expect(citationFor('biblatex', 'parenthetical', ['a'], { prenote: 'see' })).toBe('\\parencite[see][]{a}');
    expect(citationFor('biblatex', 'parenthetical', ['a'], { prenote: 'see', postnote: '23' })).toBe('\\parencite[see][23]{a}');
  });

  it('natbib writes p.~12', () => {
    expect(citationFor('natbib', 'parenthetical', ['a'], { postnote: formatLocator('natbib', 'page', '12') })).toBe('\\citep[p.~12]{a}');
    expect(formatLocator('natbib', 'page', '12–15')).toBe('pp.~12--15');
    expect(citationFor('natbib', 'narrative', ['a'])).toBe('\\citet{a}');
    expect(citationFor('natbib', 'full', ['a'])).toBe('\\citet*{a}');
  });

  it('apacite puts the prenote in <…>', () => {
    expect(citationFor('apacite', 'parenthetical', ['a'], { prenote: 'e.g.,', postnote: formatLocator('apacite', 'page', '3') })).toBe('\\cite<e.g.,>[p.~3]{a}');
    expect(citationFor('apacite', 'narrative', ['a'])).toBe('\\citeA{a}');
  });

  it('plain BibTeX keeps \\cite, has no narrative and drops prenotes', () => {
    expect(citationFor('bibtex', 'parenthetical', ['a'], { prenote: 'see' })).toBe('\\cite{a}');
    expect(citationFor('bibtex', 'narrative', ['a'])).toBeNull();
    expect(stylesFor('bibtex')).toEqual(['parenthetical']);
    expect(commandFor('bibtex', 'parenthetical')).toBe('cite');
  });

  it('writes other locators out and escapes notes', () => {
    expect(formatLocator('biblatex', 'paragraph', '4')).toBe('para.~4');
    expect(formatLocator('natbib', 'chapter', '3')).toBe('Chapter~3');
    expect(formatLocator('natbib', 'section', '2.1')).toBe('Section~2.1');
    expect(formatLocator('natbib', 'other', '1:23:45')).toBe('1:23:45');
    expect(escapeNote('50% & more_x')).toBe('50\\% \\& more\\_x');
    expect(escapeNote('already \\%')).toBe('already \\%');
    expect(buildCitation({ command: 'cite', keys: ['a'], postnote: 'p.~2', angle: true })).toBe('\\cite[p.~2]{a}');
  });
});

describe('parseCitationAt', () => {
  it('finds the citation the caret is in, on its command, or right after', () => {
    expect(at('see \\parencite[see][12]{a,|b} here')).toMatchObject({ command: 'parencite', options: ['see', '12'], keys: ['a', 'b'] });
    expect(at('see \\textcite{a}| here')?.command).toBe('textcite');
    expect(at('see \\tex|tcite{a} here')?.command).toBe('textcite');
    expect(at('see | \\textcite{a}')).toBeNull();
    expect(at('see \\textcite{a} h|ere')).toBeNull();
  });

  it('reads apacite notes, stars and plural groups', () => {
    const c = at('\\cite<e.g.,>[p.~3]{a|}')!;
    expect(c.angle).toBe('e.g.,');
    expect(notesOf(c)).toEqual({ prenote: 'e.g.,', postnote: 'p.~3' });
    expect(at('\\citet*{a|}')?.command).toBe('citet*');
    const plural = at('\\textcites[12]{a}[3]{b|} next')!;
    expect(plural.command).toBe('textcites');
    expect(plural.to).toBe('\\textcites[12]{a}[3]{b}'.length);
  });

  it('skips an unclosed citation and a line break before a command', () => {
    expect(at('\\cite{a|')).toBeNull();
    expect(notesOf(at('\\citep[p.~5]{a|}')!)).toEqual({ prenote: '', postnote: 'p.~5' });
  });
});

describe('the narrative/parenthetical toggle', () => {
  it('switches the main pairs in each family', () => {
    expect(toggledCommand('parencite', 'biblatex')).toBe('textcite');
    expect(toggledCommand('Textcite', 'biblatex')).toBe('parencite');
    expect(toggledCommand('autocite', 'biblatex')).toBe('textcite');
    expect(toggledCommand('parencites', 'biblatex')).toBe('textcites');
    expect(toggledCommand('citep', 'biblatex')).toBe('citet');
    expect(toggledCommand('citet*', 'natbib')).toBe('citep*');
    expect(toggledCommand('citealp', 'natbib')).toBe('citealt');
    expect(toggledCommand('cite', 'apacite')).toBe('citeA');
    expect(toggledCommand('citeA', 'apacite')).toBe('cite');
    expect(toggledCommand('cite', 'biblatex')).toBe('textcite');
  });

  it('leaves the others alone', () => {
    expect(toggledCommand('citeauthor', 'biblatex')).toBeNull();
    expect(toggledCommand('cite', 'bibtex')).toBeNull();
    expect(toggledCommand('nocite', 'natbib')).toBeNull();
  });
});

describe('helpers', () => {
  it('styles and families of commands', () => {
    expect(styleOf('Textcite', 'biblatex')).toBe('narrative');
    expect(styleOf('citep', 'biblatex')).toBe('parenthetical');
    expect(styleOf('cite', 'apacite')).toBe('parenthetical');
    expect(styleOf('cite', 'biblatex')).toBe('bare');
    expect(familyOfCommand('citep')).toBe('natbib');
    expect(familyOfCommand('parencite')).toBe('biblatex');
    expect(familyOfCommand('citeA')).toBe('apacite');
    expect(familyOfCommand('cite')).toBeNull();
  });

  it('locators read back from postnotes', () => {
    expect(locatorOf('12')).toEqual({ kind: 'page', value: '12' });
    expect(locatorOf('p.~12')).toEqual({ kind: 'page', value: '12' });
    expect(locatorOf('para.~4')).toEqual({ kind: 'paragraph', value: '4' });
    expect(locatorOf('Chapter~3')).toEqual({ kind: 'chapter', value: '3' });
    expect(locatorOf('table 2')).toEqual({ kind: 'other', value: 'table 2' });
  });

  it('minimal changes touch only what differs', () => {
    expect(minimalChange('\\parencite{a}', '\\parencite{a,b}', 10)).toEqual({ from: 22, to: 22, insert: ',b' });
    expect(minimalChange('\\parencite{a}', '\\textcite{a}', 0)).toEqual({ from: 1, to: 6, insert: 'text' });
    expect(minimalChange('x', 'x')).toBeNull();
  });

  it('sentence starts and spacing', () => {
    expect(atSentenceStart('')).toBe(true);
    expect(atSentenceStart('One. ')).toBe(true);
    expect(atSentenceStart('One.\n\n')).toBe(true);
    expect(atSentenceStart('as shown by ')).toBe(false);
    expect(wantsSpaceBefore('word')).toBe(true);
    expect(wantsSpaceBefore('word ')).toBe(false);
    expect(wantsSpaceBefore('(')).toBe(false);
  });

  it('reads the family from the open file\u2019s preamble', () => {
    expect(detectFamilyIn('\\documentclass[man,biblatex]{apa7}\n\\begin{document}')).toBe('biblatex');
    expect(detectFamilyIn('\\documentclass[natbib]{apa7}')).toBe('natbib');
    expect(detectFamilyIn('\\documentclass{article}\n\\usepackage[style=apa]{biblatex}')).toBe('biblatex');
    expect(detectFamilyIn('\\documentclass{article}\n% \\usepackage{biblatex}\n\\usepackage{natbib}')).toBe('natbib');
    expect(detectFamilyIn('\\documentclass{article}\n\\usepackage[natbibapa]{apacite}')).toBe('natbib');
    expect(detectFamilyIn('\\documentclass{article}\n\\usepackage{apacite}')).toBe('apacite');
    expect(detectFamilyIn('\\documentclass{article}')).toBe('bibtex');
    expect(detectFamilyIn('\\section{Intro}')).toBeNull();
  });
});
