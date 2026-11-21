import { describe, expect, it } from 'vitest';
import { ctanUrl, graphicsPathsIn, normalize, referencePattern, resolveFile, type ResolveEnv } from '../targets';

const files = ['main.tex', 'sec/intro.tex', 'sec/part/a.tex', 'fig/plot.pdf', 'fig/plot.png', 'img/photo.jpg', 'refs.bib', 'other.bib',
  'thesis/main.tex', 'thesis/ch1.tex', 'thesis/ch1/sub.tex', 'mystyle.sty', 'papers/x.pdf'];
const env = (o: Partial<ResolveEnv> = {}): ResolveEnv => ({ currentFile: 'main.tex', rootFile: 'main.tex', files, ...o });

describe('resolveFile', () => {
  it('adds .tex for \\input and \\include, beside the main document', () => {
    expect(resolveFile('sec/intro', 'input', env())).toBe('sec/intro.tex');
    expect(resolveFile('sec/intro.tex', 'input', env())).toBe('sec/intro.tex');
    expect(resolveFile('sec/intro', 'include', env({ currentFile: 'sec/part/a.tex' }))).toBe('sec/intro.tex');
    expect(resolveFile('ch1', 'input', env({ currentFile: 'thesis/ch1/sub.tex', rootFile: 'thesis/main.tex' }))).toBe('thesis/ch1.tex');
  });
  it('reads \\subfile beside the current file', () => {
    expect(resolveFile('sub', 'subfile', env({ currentFile: 'thesis/ch1/x.tex', rootFile: 'thesis/main.tex' }))).toBe('thesis/ch1/sub.tex');
  });
  it('tries the graphics extensions in order, and \\graphicspath', () => {
    expect(resolveFile('fig/plot', 'includegraphics', env())).toBe('fig/plot.pdf');
    expect(resolveFile('photo', 'includegraphics', env({ graphicsPaths: ['fig/', 'img/'] }))).toBe('img/photo.jpg');
  });
  it('adds .bib for \\bibliography', () => {
    expect(resolveFile('other', 'bibliography', env())).toBe('other.bib');
    expect(resolveFile('refs.bib', 'addbibresource', env())).toBe('refs.bib');
  });
  it('finds a local package', () => {
    expect(resolveFile('mystyle', 'usepackage', env())).toBe('mystyle.sty');
    expect(resolveFile('amsmath', 'usepackage', env())).toBeNull();
  });
  it('falls back to the one file anywhere that ends with the name', () => {
    expect(resolveFile('x.pdf', 'href', env())).toBe('papers/x.pdf');
    expect(resolveFile('plot', 'includegraphics', env())).toBeNull(); // fig/plot.pdf or fig/plot.png: ambiguous
  });
  it('never leaves the project', () => {
    expect(resolveFile('../../etc/passwd', 'input', env())).toBeNull();
    expect(resolveFile('/etc/passwd', 'input', env())).toBeNull();
    expect(resolveFile('missing', 'input', env())).toBeNull();
  });
});

describe('helpers', () => {
  it('normalizes paths', () => {
    expect(normalize('a/./b/../c')).toBe('a/c');
    expect(normalize('../x')).toBeNull();
  });
  it('reads \\graphicspath', () => {
    expect(graphicsPathsIn('\\graphicspath{{fig/}{ img/ }}\n')).toEqual(['fig/', 'img/']);
    expect(graphicsPathsIn('no paths')).toEqual([]);
  });
  it('builds the CTAN page and the references pattern', () => {
    expect(ctanUrl('amsmath')).toBe('https://ctan.org/pkg/amsmath');
    const re = new RegExp(referencePattern('fig:a.b'));
    for (const s of ['\\ref{fig:a.b}', '\\cref{x, fig:a.b}', '\\label{fig:a.b}', '@article{fig:a.b,', 'crossref = { fig:a.b }']) expect(re.test(s), s).toBe(true);
    for (const s of ['\\ref{fig:aXb}', '\\ref{fig:a.bc}', 'fig:a.b in prose']) expect(re.test(s), s).toBe(false);
  });
});
