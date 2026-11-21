import { describe, expect, it } from 'vitest';
import {
  addedText, badges, byline, entryKey, keyToQuery, looksLikeBibtex, newBibPath, previewBody,
  setEntryKey, targetChoices, undefinedCitations, undoneText, validKey,
} from '../../../../../../plugins/references/core.js';

describe('References panel logic (plugins/references/core.js)', () => {
  it('recognises pasted BibTeX', () => {
    expect(looksLikeBibtex('@article{vaswani2017attention,\n  title={Attention}}')).toBe(true);
    expect(looksLikeBibtex('  @inproceedings(x,')).toBe(true);
    expect(looksLikeBibtex('attention is all you need')).toBe(false);
    expect(looksLikeBibtex('10.48550/arXiv.1706.03762')).toBe(false);
  });

  it('reads the undefined citations a typeset reported, once each', () => {
    const result = {
      errors: [
        { message: 'Citation `vaswani2017attention\' on page 1 undefined on input line 12.' },
        { message: 'Overfull \\hbox (3pt too wide)' },
      ],
      log: "LaTeX Warning: Citation 'smith2020' on page 2 undefined on input line 30.\n"
        + 'Warning--I didn\'t find a database entry for "knuth1984"\n'
        + "LaTeX Warning: Citation `vaswani2017attention' on page 3 undefined on input line 40.\n",
    };
    expect(undefinedCitations(result)).toEqual(['vaswani2017attention', 'smith2020', 'knuth1984']);
    expect(undefinedCitations(null)).toEqual([]);
  });

  it('turns a citation key into a search for its paper', () => {
    expect(keyToQuery('vaswani2017attention')).toBe('vaswani 2017 attention');
    expect(keyToQuery('vaswaniAttentionAllYou2017')).toBe('vaswani attention all you 2017');
    expect(keyToQuery('smith2020a')).toBe('smith 2020');
    expect(keyToQuery('wilkinson_fair_2016')).toBe('wilkinson fair 2016');
  });

  it('edits the key of an entry and reads it back', () => {
    const bib = '@article{old,\n  title = {X}\n}';
    expect(setEntryKey(bib, 'new2020')).toBe('@article{new2020,\n  title = {X}\n}');
    expect(entryKey(bib)).toBe('old');
    expect(validKey('smith2020a')).toBe(true);
    expect(validKey('smith 2020')).toBe(false);
    expect(validKey('a,b')).toBe(false);
  });

  it('describes a result: byline and badges', () => {
    const c = { id: 'doi:10.1/x', title: 'T', authors: ['A. One', 'B. Two', 'C. Three', 'D. Four'], venue: 'NeurIPS', year: 2017, doi: '10.1/x', arxiv: '1706.03762', preprint: true, inProject: { key: 'one2017', bibFile: 'refs.bib' } };
    expect(byline(c)).toBe('A. One, B. Two, C. Three et al. · NeurIPS · 2017');
    expect(badges(c).map((b) => b.text)).toEqual(['In project as one2017', 'DOI', 'arXiv', 'Preprint']);
    expect(badges({ id: 'x', weak: true, publishedDoi: '10.2/y' }).map((b) => b.text)).toEqual(['Published version available', 'Check this match']);
  });

  it('previews pasted BibTeX as text (its key kept) and anything else by id', () => {
    expect(previewBody({ id: 'pasted', bibtex: '@misc{k,}' })).toEqual({ bibtex: '@misc{k,}' });
    expect(previewBody({ id: 'doi:10.1/x' })).toEqual({ id: 'doi:10.1/x' });
  });

  it('offers editable targets with the default first, never a synced file', () => {
    const targets = [
      { path: 'zotero.bib', exists: true, loaded: true, synced: true, editable: true },
      { path: 'refs/extra.bib', exists: true, loaded: false, synced: false, editable: true },
      { path: 'references.bib', exists: true, loaded: true, synced: false, editable: true },
    ];
    expect(targetChoices(targets, 'references.bib').map((t) => t.path)).toEqual(['references.bib', 'refs/extra.bib']);
  });

  it('cleans a new file name', () => {
    expect(newBibPath('refs/more')).toBe('refs/more.bib');
    expect(newBibPath('/extra.bib')).toBe('extra.bib');
    expect(newBibPath('../escape.bib')).toBe('');
    expect(newBibPath('.hidden.bib')).toBe('');
    expect(newBibPath('  ')).toBe('');
  });

  it('words the toasts', () => {
    expect(addedText({ key: 'v2017', bibFile: 'refs.bib', cited: true, citeResult: 'inserted' })).toBe('Added v2017 to refs.bib and cited it.');
    expect(addedText({ key: 'v2017', bibFile: 'refs.bib', duplicate: true, cited: false })).toBe('v2017 is in refs.bib already.');
    expect(undoneText({ entry: true, cite: true })).toBe('Removed the reference and its citation.');
    expect(undoneText({ entry: true, cite: null })).toBe('Removed the reference.');
    expect(undoneText({ entry: null, cite: true })).toBe('Removed the citation.');
    expect(undoneText({ entry: false, cite: true })).toMatch(/^Removed the citation\./);
    expect(undoneText({ entry: true, cite: false })).toMatch(/^Removed the entry\./);
  });
});
