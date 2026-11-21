import { describe, expect, it } from 'vitest';
import {
  citeKeySpans, countRenamed, defaultBibFile, jobFinished, linkedBibReason, normalizeLinks, normalizeRenames,
  renameCiteKeys, renameSummary, validBibFile, type LibraryLink,
} from '../model';

const apply = (text: string, changes: Array<{ from: number; to: number; insert: string }> | null) => {
  if (!changes) return text;
  let out = text;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
};

const link = (o: Partial<LibraryLink>): LibraryLink => ({
  id: 'l1', provider: 'mendeley', linkedBy: 'u1', linkedByName: 'Ana', libraryName: 'My library', collectionName: 'Thesis',
  bibFile: 'mendeley.bib', recursive: true, lastSyncedAt: null, pausedReason: null, ...o,
});

describe('normalizeLinks', () => {
  it('reads the contract array and drops rows without an id or a file', () => {
    const l = normalizeLinks([
      { id: 'a', provider: 'mendeley', linkedBy: 'u1', libraryName: 'Lib', collectionName: 'Thesis', bibFile: './refs/mendeley.bib', recursive: false, lastSyncedAt: '2026-11-20T10:00:00Z' },
      { id: 'b' },
      null,
      { provider: 'zotero', bibFile: 'x.bib' },
    ]);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ id: 'a', provider: 'mendeley', bibFile: 'refs/mendeley.bib', recursive: false, pausedReason: null });
  });
  it('accepts {links} and {libraries} wrappers, and nothing else', () => {
    expect(normalizeLinks({ links: [{ id: 'z', bibFile: 'zotero.bib' }] })[0]).toMatchObject({ id: 'z', provider: 'zotero', recursive: true });
    expect(normalizeLinks({ libraries: [{ id: 'z', bibFile: 'zotero.bib' }] })).toHaveLength(1);
    expect(normalizeLinks('nope')).toEqual([]);
    expect(normalizeLinks({ error: 'x' })).toEqual([]);
  });
});

describe('linkedBibReason', () => {
  const links = [link({}), link({ id: 'zotero', provider: 'zotero', bibFile: 'zotero.bib', libraryName: null, collectionName: null }), link({ id: 'd', provider: 'desktop-file', bibFile: 'local.bib' })];
  it('names the provider and the source for a synced file', () => {
    expect(linkedBibReason(links, 'mendeley.bib')).toBe('Synced from Mendeley (My library › Thesis), so it opens read-only: each sync replaces this file. Change entries in Mendeley, then sync.');
    expect(linkedBibReason(links, './zotero.bib')).toContain('Synced from Zotero (Ana’s library)');
    expect(linkedBibReason(links, 'local.bib')).toContain('on Ana’s computer');
  });
  it('leaves every other file alone', () => {
    expect(linkedBibReason(links, 'main.tex')).toBeNull();
    expect(linkedBibReason(links, 'refs/mendeley.bib')).toBeNull();
    expect(linkedBibReason(links, null)).toBeNull();
    expect(linkedBibReason([], 'mendeley.bib')).toBeNull();
  });
});

describe('normalizeRenames', () => {
  it('takes pairs, objects and maps; drops identities, duplicates and bad keys', () => {
    expect(normalizeRenames([{ from: 'a', to: 'b' }, ['c', 'd'], { from: 'a', to: 'z' }, { from: 'e', to: 'e' }, { from: 'f g', to: 'h' }]))
      .toEqual([{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }]);
    expect(normalizeRenames({ smith2020: 'smithAttention2020' })).toEqual([{ from: 'smith2020', to: 'smithAttention2020' }]);
    expect(normalizeRenames(null)).toEqual([]);
    expect(normalizeRenames('x')).toEqual([]);
  });
});

describe('citation key rewrite', () => {
  const renames = [{ from: 'smith2020', to: 'smithAttention2020' }, { from: 'doe19', to: 'doe2019' }];
  it('renames keys inside every citation command, and only there', () => {
    const text = [
      'As \\cite{smith2020} and \\citep[see][p.~2]{doe19, smith2020x,smith2020} showed.',
      '\\parencite*{smith2020} \\cites{doe19}[p.~3]{smith2020} \\nocite{doe19}',
      'smith2020 in prose, \\label{smith2020} and \\ref{doe19} stay.',
      '% \\cite{smith2020} in a comment stays',
      '50\\% off \\textcite{smith2020}',
    ].join('\n');
    const out = apply(text, renameCiteKeys(text, renames));
    expect(out).toBe([
      'As \\cite{smithAttention2020} and \\citep[see][p.~2]{doe2019, smith2020x,smithAttention2020} showed.',
      '\\parencite*{smithAttention2020} \\cites{doe2019}[p.~3]{smithAttention2020} \\nocite{doe2019}',
      'smith2020 in prose, \\label{smith2020} and \\ref{doe19} stay.',
      '% \\cite{smith2020} in a comment stays',
      '50\\% off \\textcite{smithAttention2020}',
    ].join('\n'));
    expect(countRenamed(text, renames)).toBe(8);
  });
  it('returns null when nothing cites an old key', () => {
    expect(renameCiteKeys('\\cite{other}', renames)).toBeNull();
    expect(countRenamed('no citations', renames)).toBe(0);
  });
  it('stops at an unclosed group instead of reading the rest of the file', () => {
    expect(citeKeySpans('\\cite{smith2020\n\nNext paragraph}').map((s) => s.key)).toEqual([]);
    expect(citeKeySpans('\\cite{a}\\cite{b').map((s) => s.key)).toEqual(['a']);
  });
  it('summarises the first pairs', () => {
    expect(renameSummary(renames)).toBe('smith2020 → smithAttention2020, doe19 → doe2019');
    expect(renameSummary([...renames, { from: 'x', to: 'y' }, { from: 'p', to: 'q' }])).toBe('smith2020 → smithAttention2020, doe19 → doe2019, x → y, and 1 more');
  });
});

describe('file names', () => {
  it('defaults next to the root file, then by first name, then numbered', () => {
    expect(defaultBibFile('mendeley', [], 'Ana', 'main.tex')).toBe('mendeley.bib');
    expect(defaultBibFile('zotero', ['paper/zotero.bib'], 'Ána María', 'paper/main.tex')).toBe('paper/zotero-ana-maria.bib');
    expect(defaultBibFile('zotero', ['zotero.bib', 'zotero-ana.bib'], 'Ana', null)).toBe('zotero-ana-2.bib');
    expect(defaultBibFile('mendeley', ['mendeley.bib'], null, null)).toBe('mendeley-2.bib');
  });
  it('accepts relative .bib paths only', () => {
    expect(validBibFile('refs/mendeley.bib')).toBe(true);
    expect(validBibFile('mendeley.txt')).toBe(false);
    expect(validBibFile('../out.bib')).toBe(false);
    expect(validBibFile('a//b.bib')).toBe(false);
  });
});

describe('jobFinished', () => {
  it('reads the job states', () => {
    expect(jobFinished('done')).toBe('done');
    expect(jobFinished('failed')).toBe('failed');
    expect(jobFinished('running')).toBeNull();
    expect(jobFinished(undefined)).toBeNull();
  });
});
