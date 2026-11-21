import { describe, expect, it } from 'vitest';
import {
  describeFile, downloadNameFor, fallbackOutputDir, formatSize, keepState, outputHref, parseOutputList, parseWarnings, sortGenerated,
  type GeneratedFile,
} from '../generated';

const f = (name: string, o: Partial<GeneratedFile> = {}): GeneratedFile => ({ name, size: null, mtime: null, fromLastRun: true, tracked: null, ...o });

describe('parseOutputList', () => {
  it('reads the WP30 shape: {files: [{name, size, mtime, fromLastRun, tracked}]}', () => {
    const { dir, files } = parseOutputList({
      dir: 'paper/.aldine-out',
      files: [
        { name: 'main.log', size: 4096, mtime: 1_700_000_000_000, fromLastRun: true },
        { name: 'main.bbl', size: 812, mtime: '2026-11-21T10:00:00Z', fromLastRun: true, tracked: 'differs' },
        { name: 'old.idx', size: 10, mtime: 1_700_000_000, fromLastRun: false },
      ],
    });
    expect(dir).toBe('paper/.aldine-out');
    expect(files.map((x) => x.name)).toEqual(['main.bbl', 'main.log', 'old.idx']);
    expect(files[0]).toEqual({ name: 'main.bbl', size: 812, mtime: Date.parse('2026-11-21T10:00:00Z'), fromLastRun: true, tracked: 'differs', keepable: null });
    expect(files[2].mtime).toBe(1_700_000_000_000); // seconds become milliseconds
  });

  it('reads what WP30 answers: {root, outDir, typesetAt, files: [{name, path, size, mtime, fromLastRun, keepable, tracked}]}', () => {
    const { dir, files } = parseOutputList({
      root: 'paper/main.tex', outDir: 'paper/.aldine-out', typesetAt: '2026-11-21T10:00:00.000Z',
      files: [
        { name: 'main.aux', path: 'paper/.aldine-out/main.aux', size: 2, mtime: '2026-11-21T10:00:00.000Z', fromLastRun: true, keepable: false },
        { name: 'main.bbl', path: 'paper/.aldine-out/main.bbl', size: 9, mtime: '2026-11-21T10:00:00.000Z', fromLastRun: true, keepable: true, tracked: 'same' },
        { name: 'main.sls', path: 'paper/.aldine-out/main.sls', size: 9, mtime: '2026-11-21T10:00:00.000Z', fromLastRun: true, keepable: true, tracked: null },
      ],
    });
    expect(dir).toBe('paper/.aldine-out');
    expect(files.map((x) => [x.name, keepState(x, { partial: false }, true)])).toEqual([['main.bbl', 'same'], ['main.sls', 'add'], ['main.aux', null]]);
    // the server's word wins over the client's list
    expect(keepState(f('main.bbl', { keepable: false }), { partial: false }, true)).toBeNull();
    expect(keepState(f('main.xyz', { keepable: true }), { partial: false }, true)).toBe('add');
  });

  it('takes a bare array, or the list under entries/outputs, and names alone', () => {
    expect(parseOutputList([{ name: 'a.log' }]).files.map((x) => x.name)).toEqual(['a.log']);
    expect(parseOutputList({ entries: ['b.bbl'] }).files.map((x) => x.name)).toEqual(['b.bbl']);
    expect(parseOutputList({ outputs: [{ name: 'c.aux' }], outDir: '.aldine-out/' }).dir).toBe('.aldine-out');
  });

  it('drops dotfiles, folders, fmt/, paths, duplicates and junk, and never throws', () => {
    const { files } = parseOutputList({ files: [
      { name: '.aldine-run' }, { name: 'fmt' }, { name: '../secret' }, { name: 'sub/x.log' }, { name: 'a\\b' },
      { name: 'main.log' }, { name: 'main.log' }, null, 7, { size: 3 }, { name: 'ok.blg', size: -1, tracked: 'yes' },
    ] });
    expect(files.map((x) => x.name)).toEqual(['main.log', 'ok.blg']);
    expect(files[1]).toMatchObject({ size: null, tracked: null });
    expect(parseOutputList(null).files).toEqual([]);
    expect(parseOutputList('nonsense').files).toEqual([]);
    expect(parseOutputList({ files: 'x' }).files).toEqual([]);
  });

  it('refuses an output folder that climbs out of the project', () => {
    expect(parseOutputList({ dir: '../elsewhere', files: [] }).dir).toBeNull();
    expect(parseOutputList({ dir: 'a/../../b', files: [] }).dir).toBeNull();
  });
});

describe('grouping', () => {
  it('lists this typeset before an earlier one, the PDF and the .bbl first, numbers in order', () => {
    const sorted = sortGenerated([
      f('main.log'), f('old.gls', { fromLastRun: false }), f('main.aux'), f('main.pdf'), f('main.bbl'), f('main.ind'),
      f('ch10.aux'), f('ch2.aux'),
    ]);
    expect(sorted.map((x) => x.name)).toEqual(['main.pdf', 'main.bbl', 'main.ind', 'main.log', 'ch2.aux', 'ch10.aux', 'main.aux', 'old.gls']);
  });

  it('says which typeset wrote a file, and its size', () => {
    expect(describeFile(f('a.log', { size: 3482 }))).toBe('3.4 KB · this typeset');
    expect(describeFile(f('a.log', { size: 3482, fromLastRun: false }))).toBe('3.4 KB · earlier typeset');
    expect(describeFile(f('a.log', { fromLastRun: null }))).toBe('');
    expect(formatSize(812)).toBe('812 B');
    expect(formatSize(20 * 1024)).toBe('20 KB');
    expect(formatSize(1.25 * 1024 * 1024)).toBe('1.3 MB');
    expect(formatSize(null)).toBe('');
  });
});

describe('keepState', () => {
  const full = { partial: false };
  it('offers Add for what a submission needs, Update when the project copy differs, nothing for the rest', () => {
    expect(keepState(f('main.bbl'), full, true)).toBe('add');
    expect(keepState(f('main.ind'), full, true)).toBe('add');
    expect(keepState(f('main.gls'), full, true)).toBe('add');
    expect(keepState(f('main.nls'), full, true)).toBe('add');
    expect(keepState(f('main.acr'), full, true)).toBe('add');
    expect(keepState(f('main.bbl', { tracked: 'differs' }), full, true)).toBe('update');
    expect(keepState(f('main.bbl', { tracked: 'same' }), full, true)).toBe('same');
    expect(keepState(f('main.log'), full, true)).toBeNull();
    expect(keepState(f('main.aux'), full, true)).toBeNull();
  });

  it('offers nothing to change to someone who may only view, and nothing at all without the list route', () => {
    expect(keepState(f('main.bbl'), full, false)).toBeNull();
    expect(keepState(f('main.bbl', { tracked: 'differs' }), full, false)).toBeNull();
    expect(keepState(f('main.bbl', { tracked: 'same' }), full, false)).toBe('same');
    expect(keepState(f('main.bbl'), { partial: true }, true)).toBeNull();
  });
});

describe('download names and links', () => {
  it('names the PDF after the project and keeps TeX names for the rest', () => {
    expect(downloadNameFor(f('main.pdf'), 'My: thesis')).toBe('My- thesis.pdf');
    expect(downloadNameFor(f('main.bbl'), 'My thesis')).toBe('main.bbl');
    expect(downloadNameFor(f('main.log'), '')).toBe('main.log');
  });

  it('links through the output route, branch and folder encoded', () => {
    const href = outputHref('p1', 'rev/2', 'paper/.aldine-out', 'main.bbl');
    const u = new URL(href, 'http://x');
    expect(u.pathname).toBe('/api/projects/p1/output');
    expect(u.searchParams.get('branch')).toBe('rev/2');
    expect(u.searchParams.get('path')).toBe('paper/.aldine-out/main.bbl');
    expect(new URL(outputHref('p1', 'main', '', 'x.log'), 'http://x').searchParams.get('path')).toBe('x.log');
  });

  it('finds the output folder beside the PDF, else beside the main document', () => {
    expect(fallbackOutputDir('paper/.aldine-out', 'other/main.tex')).toBe('paper/.aldine-out');
    expect(fallbackOutputDir(null, 'paper/main.tex')).toBe('paper/.aldine-out');
    expect(fallbackOutputDir(null, 'main.tex')).toBe('.aldine-out');
    expect(fallbackOutputDir(null, null)).toBe('.aldine-out');
  });
});

describe('parseWarnings', () => {
  it('reads a JSON array, URI-encoded or not, or plain lines', () => {
    expect(parseWarnings(null)).toEqual([]);
    expect(parseWarnings(encodeURIComponent(JSON.stringify(['LuaLaTeX is not offered by arXiv.', ' ', 'Spaces in “my fig.png”.'])))).toEqual(['LuaLaTeX is not offered by arXiv.', 'Spaces in “my fig.png”.']);
    expect(parseWarnings('["one"]')).toEqual(['one']);
    expect(parseWarnings('first\nsecond\n')).toEqual(['first', 'second']);
  });
});
