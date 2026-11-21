import { describe, expect, it } from 'vitest';
import { addressHref, bareLinks, doiHref, findLink, modeFor, unescapeTex, type LinkHit, type LinkMode } from '../detect';

/** `|` marks the click; the result's span is returned as the text it covers. */
function at(marked: string, mode: LinkMode = 'tex', field?: (n: string) => string | null): (LinkHit & { text: string }) | null {
  const col = marked.indexOf('|');
  const line = marked.slice(0, col) + marked.slice(col + 1);
  const hit = findLink(line, col, mode, field ? { field } : {});
  return hit ? { ...hit, text: line.slice(hit.from, hit.to) } : null;
}
const href = (marked: string, mode: LinkMode = 'tex') => {
  const h = at(marked, mode);
  return h?.kind === 'url' ? h.href : null;
};

describe('unescapeTex', () => {
  it('undoes the escapes a URL means literally', () => {
    expect(unescapeTex('a\\_b\\%20\\#x\\&y\\$')).toBe('a_b%20#x&y$');
    expect(unescapeTex('\\~{}me/\\textasciitilde{}you/\\string~them')).toBe('~me/~you/~them');
    expect(unescapeTex('a\\textunderscore{}b')).toBe('a_b');
  });
});

describe('\\url, \\href and friends', () => {
  it('opens \\url with its escapes undone', () => {
    expect(href('\\url{https://example.org/a\\_|b}')).toBe('https://example.org/a_b');
    expect(href('see \\u|rl{https://example.org/x}.')).toBe('https://example.org/x');
    expect(at('\\url{https://example.org/x}|')?.text).toBe('\\url{https://example.org/x}');
  });
  it('keeps % literal inside \\url and an \\href address', () => {
    expect(href('\\url{https://x.org/a%20|b}')).toBe('https://x.org/a%20b');
    expect(href('\\href{https://x.org/?q=a%2|0b}{text}')).toBe('https://x.org/?q=a%20b');
  });
  it('treats the whole \\href as the link, its text included', () => {
    const h = at('\\href{https://x.org/p}{the s|ite}');
    expect(h?.kind).toBe('url');
    expect(h?.text).toBe('\\href{https://x.org/p}{the site}');
    expect(href('\\href[pdfnewwindow]{https://x.org/}{te|xt}')).toBe('https://x.org/');
  });
  it('opens host-like values without a scheme as https', () => {
    expect(href('\\url{www.x.org/|a}')).toBe('https://www.x.org/a');
    expect(href('\\url{example.org|}')).toBe('https://example.org/');
  });
  it('refuses scripts, local files, data and credentials', () => {
    for (const s of [
      '\\href{javascript:alert(1)}{cl|ick}',
      '\\url{file:///etc/pass|wd}',
      '\\url{data:text/html,x|}',
      '\\url{https://user:pw@x.o|rg/}',
      'see https://user:pw@x.o|rg/ now',
    ]) expect(at(s), s).toBeNull();
  });
  it('reads a relative \\href as a project file', () => {
    expect(at('\\href{chapter2.pdf}{ch|apter}')).toMatchObject({ kind: 'file', name: 'chapter2.pdf', command: 'href' });
  });
  it('turns \\doi and \\orcidlink into their sites', () => {
    expect(href('\\doi{10.1037/a\\_b|}')).toBe('https://doi.org/10.1037/a_b');
    expect(href('\\orcidlink{0000-0002-1825-009|7}')).toBe('https://orcid.org/0000-0002-1825-0097');
  });
});

describe('bare addresses in TeX text', () => {
  it('trims prose punctuation and unbalanced brackets', () => {
    expect(href('(see https://x.org/a_(b|)).')).toBe('https://x.org/a_(b)');
    expect(href('at https://x.org/p|age.')).toBe('https://x.org/page');
    expect(href('``https://x.org/|q\'\'')).toBe('https://x.org/q');
    expect(href('[https://x.org/|a]')).toBe('https://x.org/a');
  });
  it('stops at a comment, a tie, a command and a line break', () => {
    expect(href('https://x.org/|a%comment')).toBe('https://x.org/a');
    expect(href('https://x.org/|a~and')).toBe('https://x.org/a');
    expect(href('https://x.org/|a\\\\next')).toBe('https://x.org/a');
    expect(href('https://x.org/|a\\textbf{b}')).toBe('https://x.org/a');
  });
  it('keeps escapes inside and undoes them', () => {
    expect(href('https://x.org/a\\_b\\%2|0c')).toBe('https://x.org/a_b%20c');
  });
  it('keeps % and ~ in a comment', () => {
    expect(href('text % see https://x.org/~me/a%2|0b')).toBe('https://x.org/~me/a%20b');
  });
  it('opens www. as https and mailto as mail', () => {
    expect(href('www.example.org/|x')).toBe('https://www.example.org/x');
    expect(href('write to mailto:me@exam|ple.org.')).toBe('mailto:me@example.org');
  });
  it('needs the scheme at a word start', () => {
    expect(at('xhttps://x.org/|a')).toBeNull();
  });
  it('finds DOIs and arXiv ids', () => {
    expect(href('doi:10.1037/abc#|1')).toBe('https://doi.org/10.1037/abc%231');
    expect(href('DOI: 10.1037/a|bc.')).toBe('https://doi.org/10.1037/abc');
    expect(href('see 10.1000/xy|z.')).toBe('https://doi.org/10.1000/xyz');
    expect(href('arXiv:2401.0123|4v2')).toBe('https://arxiv.org/abs/2401.01234v2');
    expect(href('arXiv:hep-th/990100|1')).toBe('https://arxiv.org/abs/hep-th/9901001');
    expect(href('https://doi.org/10.1037/ab|c')).toBe('https://doi.org/10.1037/abc');
  });
  it('is nothing off a link', () => {
    expect(at('plain te|xt here')).toBeNull();
    expect(bareLinks('no links at all', 'tex')).toEqual([]);
  });
});

describe('project targets', () => {
  it('reads files from \\input, \\includegraphics and \\bibliography', () => {
    expect(at('\\input{sec/in|tro}')).toMatchObject({ kind: 'file', name: 'sec/intro', command: 'input', text: 'sec/intro' });
    expect(at('\\includegraphics[width=\\linewidth]{fig/a|}')).toMatchObject({ kind: 'file', name: 'fig/a', command: 'includegraphics' });
    expect(at('\\bibliography{a,b|b}')).toMatchObject({ kind: 'file', name: 'bb', command: 'bibliography', text: 'bb' });
    expect(at('\\subimport{chap/}{o|ne}')).toMatchObject({ kind: 'file', name: 'chap/one', command: 'subimport' });
  });
  it('reads packages, keys and labels', () => {
    expect(at('\\usepackage[x]{amsmath,my|style}')).toMatchObject({ kind: 'package', name: 'mystyle', command: 'usepackage' });
    expect(at('\\cref{a, fig:b|}')).toMatchObject({ kind: 'ref', key: 'fig:b', text: 'fig:b' });
    expect(at('\\cr|ef{fig:a,fig:b}')).toMatchObject({ kind: 'ref', key: 'fig:a' });
    expect(at('\\parencite[see][12]{lamport|94}')).toMatchObject({ kind: 'cite', key: 'lamport94' });
    expect(at('\\cite<e.g.,>[p.~3]{a,b|}')).toMatchObject({ kind: 'cite', key: 'b' });
    expect(at('\\textcites{a}{b|}')).toMatchObject({ kind: 'cite', key: 'b' });
    expect(at('\\label{sec:in|tro}')).toMatchObject({ kind: 'label', key: 'sec:intro' });
    expect(at('\\hyperref[sec:a|]{text}')).toMatchObject({ kind: 'ref', key: 'sec:a' });
    expect(at('\\nocite{*|}')).toBeNull();
  });
  it('does not take \\href or \\hyperref as a \\ref', () => {
    expect(at('\\href{https://x.org}{te|xt}')?.kind).toBe('url');
  });
  it('finds a command inside another command\'s argument', () => {
    expect(at('\\footnote{See \\url{https://x.org/|a}.}')?.kind).toBe('url');
    expect(at('\\textbf{\\ref{fig:|x}}')).toMatchObject({ kind: 'ref', key: 'fig:x' });
  });
});

describe('.bib fields', () => {
  it('opens url, doi, pmid and eprint fields', () => {
    expect(href('  url = {https://x.org/a\\_|b},', 'bib')).toBe('https://x.org/a_b');
    expect(href('  doi = "10.1037/ab|c",', 'bib')).toBe('https://doi.org/10.1037/abc');
    expect(href('  doi = {https://doi.org/10.1037/ab|c},', 'bib')).toBe('https://doi.org/10.1037/abc');
    expect(href('  pmid = {1234|5},', 'bib')).toBe('https://pubmed.ncbi.nlm.nih.gov/12345/');
    expect(at('  eprint = {2401.0123|4},', 'bib', (n) => (n === 'eprinttype' ? 'arxiv' : null))).toMatchObject({ href: 'https://arxiv.org/abs/2401.01234' });
    expect(href('  url = {https://x.org/a%2|0b},', 'bib')).toBe('https://x.org/a%20b');
  });
  it('reads \\url in howpublished and bare addresses in note', () => {
    expect(href('  howpublished = {\\url{https://x.org/|p}},', 'bib')).toBe('https://x.org/p');
    expect(href('  note = {Online at https://x.org/|q},', 'bib')).toBe('https://x.org/q');
  });
  it('jumps to crossref keys and finds an entry key\'s references', () => {
    expect(at('  crossref = {proc|2020},', 'bib')).toMatchObject({ kind: 'bibkey', key: 'proc2020' });
    expect(at('@article{lamport|94,', 'bib')).toMatchObject({ kind: 'label', key: 'lamport94', bib: true });
  });
});

describe('plain files and modes', () => {
  it('finds only bare addresses in notes', () => {
    expect(href('[docs](https://x.org/|d)', 'plain')).toBe('https://x.org/d');
    expect(at('\\input{x|}', 'plain')).toBeNull();
  });
  it('picks the mode from the path', () => {
    expect(modeFor('a/main.tex')).toBe('tex');
    expect(modeFor('refs.bib')).toBe('bib');
    expect(modeFor('my.sty')).toBe('tex');
    expect(modeFor('README.md')).toBe('plain');
  });
});

describe('address helpers', () => {
  it('refuses what is no address', () => {
    expect(addressHref('chapter.tex x')).toBeNull();
    expect(addressHref('')).toBeNull();
    expect(doiHref('11.1/x')).toBeNull();
  });
});
