import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../api', () => ({ api: { bib: async () => [], labels: async () => [] }, apiRequest: async () => null }));

import { apaByline, rankEntries, type Entry } from '../entries';
import { citeRank, foldText, surnames } from '../../../editor/latexExtras';

const lamport: Entry = { key: 'lamport1994', type: 'book', author: 'Lamport, Leslie', title: 'LaTeX: A Document Preparation System', year: '1994', file: 'refs.bib' };
const knuth: Entry = { key: 'knuth1984', type: 'book', author: 'Knuth, Donald E.', title: 'The TeXbook', year: '1984', file: 'refs.bib' };
const muller: Entry = { key: 'mueller2020', type: 'article', author: 'Müller, Anna and Lee, Ben', title: 'Reading times', year: '2020', file: 'refs.bib' };
const many: Entry = { key: 'smith2019', type: 'article', author: 'Smith, A. and Jones, B. and Brown, C.', title: 'Many hands', year: '2019', file: 'zotero.bib' };

describe('citation search', () => {
  it('folds case and diacritics, TeX accents included', () => {
    expect(foldText('M{\\"u}ller')).toBe('muller');
    expect(foldText('Müller')).toBe('muller');
    expect(foldText('Ørsted')).toBe('orsted');
  });

  it('finds the family names of a name list', () => {
    expect(surnames('Lamport, Leslie and Donald E. Knuth and others')).toEqual(['Lamport', 'Knuth']);
  });

  it('every word must match: "lamport 94" finds lamport1994 first', () => {
    const rows = rankEntries([knuth, lamport, muller], 'lamport 94', new Set());
    expect(rows.map((r) => r.entry.key)).toEqual(['lamport1994']);
    expect(citeRank(knuth, 'lamport 94')).toBe(0);
  });

  it('finds Müller by "muller 2020" and by title words', () => {
    expect(rankEntries([knuth, lamport, muller], 'muller 2020', new Set()).map((r) => r.entry.key)).toEqual(['mueller2020']);
    expect(rankEntries([knuth, lamport, muller], 'texbook', new Set()).map((r) => r.entry.key)).toEqual(['knuth1984']);
  });

  it('ranks key prefixes above names above titles, and boosts keys cited here', () => {
    expect(citeRank(lamport, 'lam')).toBeGreaterThan(citeRank(lamport, 'leslie'));
    expect(citeRank(knuth, '', new Set(['knuth1984']))).toBeGreaterThan(citeRank(lamport, '', new Set(['knuth1984'])));
  });

  it('collapses duplicate keys into one row that says where else they are', () => {
    const rows = rankEntries([lamport, { ...lamport, file: 'extra.bib' }], '', new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0].alsoIn).toEqual(['extra.bib']);
  });
});

describe('apaByline', () => {
  it('one, two and several authors, and n.d.', () => {
    expect(apaByline(lamport)).toBe('Lamport (1994)');
    expect(apaByline(muller)).toBe('Müller & Lee (2020)');
    expect(apaByline(many)).toBe('Smith et al. (2019)');
    expect(apaByline({ key: 'x', type: 'misc', title: 'Untitled report', file: 'r.bib' })).toBe('Untitled report (n.d.)');
  });
});
