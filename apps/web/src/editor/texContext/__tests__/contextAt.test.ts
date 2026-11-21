import { describe, expect, it } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { contextAt, extraTableEnvironments, type TexContext } from '..';
import { at, inDoc, PREAMBLE } from './helpers';

const ctx = (src: string, o?: { side?: -1 | 1 }, extensions: Extension[] = []): TexContext => {
  const { state, pos } = at(src, extensions);
  const c = contextAt(state, pos, o);
  if (!c) throw new Error(`no context for ${JSON.stringify(src)}`);
  return c;
};

/** [document with ¦ at the position, what the context must contain]. Bodies are wrapped in a document unless they start with \documentclass or %!. */
type Case = [string, Record<string, unknown>];

const wrap = (src: string) => (src.startsWith('\\documentclass') || src.startsWith('%!') ? src.replace(/^%!/, '') : inDoc(src));

function run(cases: Case[]) {
  for (const [src, want] of cases) {
    it(`${JSON.stringify(src)} → ${want.kind}${want.detail ? ` · ${want.detail}` : ''}`, () => {
      expect(ctx(wrap(src))).toMatchObject(want);
    });
  }
}

describe('contextAt: text and tables', () => {
  run([
    ['R&¦D grew', { kind: 'text', detail: '', table: null, math: null, inDocument: true, preamble: false }],
    ['\\begin{tabular}{ll} a &¦ b \\\\ \\end{tabular}', { kind: 'table', detail: 'cell 2', table: { env: 'tabular', family: 'tabular', column: 1, topLevel: true } }],
    ['\\begin{tabular}{ll} a & b \\\\ c &¦ d \\\\ \\end{tabular}', { kind: 'table', detail: 'cell 2' }],
    ['\\begin{tabular}{lll} a & b & c¦ \\end{tabular}', { kind: 'table', detail: 'cell 3' }],
    ['\\begin{tabularx}{\\linewidth}{lX} a¦ & b \\end{tabularx}', { kind: 'table', detail: 'cell 1', table: { env: 'tabularx' } }],
    ['\\begin{longtable}{ll} a & b¦ \\end{longtable}', { kind: 'table', detail: 'cell 2' }],
    ['\\begin{tabular*}{\\textwidth}{ll} a & b & c¦ \\end{tabular*}', { kind: 'table', detail: 'cell 3', table: { env: 'tabular*', family: 'tabular' } }],
    ['\\begin{tblr}{colspec={ll}} a & b¦ \\end{tblr}', { kind: 'table', detail: 'cell 2', table: { env: 'tblr' } }],
    ['\\begin{NiceTabular}{cc} a¦ \\end{NiceTabular}', { kind: 'table' }],
    ['\\begin{mytabular} a¦ \\end{mytabular}', { kind: 'table', table: { env: 'mytabular', family: 'tabular' } }],
    ['\\begin{mytable} a¦ \\end{mytable}', { kind: 'text', table: null }],
    ['\\begin{tabular}{ll} \\multicolumn{2}{c}{R&¦D} \\\\ \\end{tabular}', { kind: 'text', table: { env: 'tabular', topLevel: false, column: 0 } }],
    ['\\begin{tabular}{ll} x & \\parbox{2cm}{R&¦D} \\\\ \\end{tabular}', { kind: 'text', table: { topLevel: false, column: 1 } }],
    ['\\begin{tabular}{ll} x & \\begin{minipage}{1cm}a&¦b\\end{minipage} \\end{tabular}', { kind: 'text', env: 'minipage', table: { topLevel: false, column: 1 } }],
    ['\\begin{tabular}{ll} a & {b &¦ c} \\\\ \\end{tabular}', { kind: 'text', table: { topLevel: false, column: 1 } }],
    ['\\begin{tabular}{ll} \\textbf{R&¦D} \\\\ \\end{tabular}', { kind: 'text', table: { topLevel: false } }],
    ['\\begin{tabular}{ll} \\makecell{a \\\\ b&¦} \\end{tabular}', { kind: 'text', table: { topLevel: false } }],
    ['\\begin{tabular}{l¦l} a \\end{tabular}', { kind: 'code', detail: 'option', table: null, arg: { command: 'begin', kind: 'option' } }],
    ['\\begin{tabular}{ll} a \\& b &¦ c \\end{tabular}', { kind: 'table', detail: 'cell 2' }],
    ['\\begin{tabular}{ll} a % & b\n & c¦ \\end{tabular}', { kind: 'table', detail: 'cell 2' }],
    ['\\section{Results &¦ more}', { kind: 'text', arg: { command: 'section', kind: 'text', index: 0 } }],
    ['\\caption{R&¦D}', { kind: 'text', arg: { command: 'caption', kind: 'text' } }],
    ['\\item[lab¦el] x', { kind: 'text', arg: { command: 'item', kind: 'text' } }],
    ['\\begin{theorem}[Na¦me] x \\end{theorem}', { kind: 'text', arg: { command: 'begin', kind: 'text' } }],
    ['\\begin{figure}[h¦t] x \\end{figure}', { kind: 'code', detail: 'option' }],
    ['\\href{http://x}{te¦xt}', { kind: 'text', arg: { command: 'href', kind: 'text', index: 1 } }],
    ['\\textcolor{red}{x¦}', { kind: 'text', arg: { command: 'textcolor', kind: 'text', index: 1 } }],
    ['\\cite[see¦][p.~3]{k}', { kind: 'text', arg: { command: 'cite', kind: 'text', index: 0 } }],
    ['\\texttt{x_¦1}', { kind: 'text', mono: true }],
    ['\\foo{some te¦xt}', { kind: 'text', arg: { command: 'foo', kind: 'text' } }],
  ]);

  it('takes extra table environments from the facet', () => {
    const src = inDoc('\\begin{grid} a & b¦ \\end{grid}');
    expect(ctx(src).kind).toBe('text');
    expect(ctx(src, undefined, [extraTableEnvironments.of(['grid'])])).toMatchObject({ kind: 'table', detail: 'cell 2', table: { env: 'grid', family: 'tabular' } });
  });

  it('knows a table environment the preamble wraps', () => {
    const src = `${PREAMBLE}\\newenvironment{results}{\\begin{tabular}{ll}}{\\end{tabular}}\n\\begin{document}\n\\begin{results} a & b¦ \\end{results}\n\\end{document}\n`;
    expect(ctx(src)).toMatchObject({ kind: 'table', detail: 'cell 2', table: { env: 'results', family: 'tabular' } });
  });

  it('takes the optional argument of a theorem the preamble declares as text', () => {
    const src = `${PREAMBLE}\\newtheorem{hyp}{Hypothesis}\n\\begin{document}\n\\begin{hyp}[Na¦me] x \\end{hyp}\n\\end{document}\n`;
    expect(ctx(src).kind).toBe('text');
  });
});

describe('contextAt: math', () => {
  run([
    ['\\begin{align*} a &¦= b \\end{align*}', { kind: 'math', detail: 'align*', math: { delim: 'env', env: 'align*', display: true, textInside: false }, table: { env: 'align*', family: 'align', column: 1, topLevel: true } }],
    ['\\begin{equation}\\begin{aligned} a¦ \\end{aligned}\\end{equation}', { kind: 'math', detail: 'aligned', env: 'aligned', math: { delim: 'env', env: 'equation', display: true } }],
    ['\\[ \\begin{pmatrix} a & b¦ \\end{pmatrix} \\]', { kind: 'math', detail: 'pmatrix', math: { delim: '\\[', display: true }, table: { env: 'pmatrix', family: 'array', column: 1 } }],
    ['$f(x) = \\begin{cases} 1 & x¦ \\end{cases}$', { kind: 'math', math: { delim: '$', display: false }, table: { family: 'array' } }],
    ['\\begin{equation}\\begin{split} a¦ \\end{split}\\end{equation}', { kind: 'math', detail: 'split' }],
    ['\\begin{gather} a¦ \\end{gather}', { kind: 'math', table: null }],
    ['$\\text{a¦}$', { kind: 'text', detail: 'text in math', math: { delim: '$', textInside: true }, arg: { command: 'text', kind: 'text' } }],
    ['$\\mbox{a¦}$', { kind: 'text', detail: 'text in math', math: { textInside: true } }],
    ['$\\textbf{a¦}$', { kind: 'text', detail: 'text in math' }],
    ['$\\operatorname{a¦}$', { kind: 'math', math: { textInside: false } }],
    ['$\\textcolor{red}{x¦}$', { kind: 'math' }],
    ['$\\frac{a¦}{b}$', { kind: 'math', arg: null }],
    ['x $¦$ y', { kind: 'math', detail: 'inline', math: { delim: '$', display: false } }],
    ['x $a$¦ y', { kind: 'text', math: null }],
    ['x $a$¦$b$ y', { kind: 'text' }],
    ['x ¦$a$ y', { kind: 'text' }],
    ['x $a¦$ y', { kind: 'math' }],
    ['x $¦a$ y', { kind: 'math' }],
    ['a $x + b¦\n\nc', { kind: 'math' }],
    ['\\begin{equation}¦\\end{equation}', { kind: 'math', env: 'equation' }],
    ['$$x¦$$', { kind: 'math', detail: 'display', math: { delim: '$$', display: true } }],
    ['\\(x¦\\)', { kind: 'math', math: { delim: '\\(', display: false } }],
    ['\\[x¦\\]', { kind: 'math', math: { delim: '\\[', display: true } }],
    ['\\[ \\text{if $x¦$} \\]', { kind: 'math', math: { delim: '$', display: false, textInside: false } }],
    ['\\begin{math} x¦ \\end{math}', { kind: 'math', math: { delim: 'env', env: 'math', display: false } }],
    ['$\\label{eq¦}$', { kind: 'literal', detail: 'label', math: { delim: '$' } }],
    ['\\begin{align} \\sqrt{a &¦ b} \\end{align}', { kind: 'math', table: { topLevel: false } }],
    ['\\begin{align} \\text{x &¦ y} \\end{align}', { kind: 'text', detail: 'text in math', table: { family: 'align', topLevel: false } }],
  ]);
});

describe('contextAt: comments', () => {
  run([
    ['% note¦', { kind: 'comment', math: null, table: null, arg: null }],
    ['text % note¦', { kind: 'comment' }],
    ['50\\%¦ more', { kind: 'text' }],
    ['a \\\\% c¦', { kind: 'comment' }],
    ['\\url{http://a%b¦}', { kind: 'literal', detail: 'URL' }],
    ['\\verb|50%|¦ x', { kind: 'text' }],
    ['\\path{a%b¦}', { kind: 'literal', detail: 'path', mono: true }],
    ['\\begin{verbatim}\n50% x¦\n\\end{verbatim}', { kind: 'verbatim' }],
    ['\\begin{tabular}{ll} % a¦ \\end{tabular}', { kind: 'comment', table: null }],
    ['$x % y¦$', { kind: 'comment' }],
  ]);

  it('reads a comment that ends the file', () => {
    expect(ctx('a\n% note¦').kind).toBe('comment');
    expect(ctx('a % note¦').kind).toBe('comment');
    expect(ctx('% note\nx¦').kind).toBe('text');
  });
});

describe('contextAt: verbatim, literal and code', () => {
  run([
    ['\\begin{verbatim}a&¦b\\end{verbatim}', { kind: 'verbatim', detail: 'verbatim', mono: true, env: 'verbatim' }],
    ['\\begin{verbatim*}a&¦b\\end{verbatim*}', { kind: 'verbatim', detail: 'verbatim*' }],
    ['\\begin{lstlisting}a¦\\end{lstlisting}', { kind: 'verbatim', detail: 'lstlisting' }],
    ['\\begin{minted}{python}a¦\\end{minted}', { kind: 'verbatim', detail: 'minted' }],
    ['\\begin{alltt}a¦\\end{alltt}', { kind: 'verbatim', detail: 'alltt' }],
    ['\\begin{filecontents}{a.bib}x & y¦\\end{filecontents}', { kind: 'verbatim', detail: 'filecontents' }],
    ['\\verb|a¦|', { kind: 'verbatim', detail: 'verb', mono: true, arg: null }],
    ['\\lstinline|a¦|', { kind: 'verbatim', detail: 'lstinline' }],
    ['\\url{http¦}', { kind: 'literal', detail: 'URL', mono: true, arg: { command: 'url', kind: 'url', index: 0 } }],
    ['\\href{http://x¦}{t}', { kind: 'literal', detail: 'URL', arg: { command: 'href', kind: 'url', index: 0 } }],
    ['\\includegraphics{fig/a_b¦.png}', { kind: 'literal', detail: 'path', arg: { kind: 'path' } }],
    ['\\includegraphics[width=¦2cm]{a}', { kind: 'code', detail: 'option', arg: { command: 'includegraphics', kind: 'option', index: 0 } }],
    ['\\input{chapters/one¦}', { kind: 'literal', detail: 'path' }],
    ['\\cite{smith_2020¦}', { kind: 'literal', detail: 'citation key', arg: { command: 'cite', kind: 'cite-key' } }],
    ['\\citep*{a¦}', { kind: 'literal', detail: 'citation key', arg: { command: 'citep*' } }],
    ['\\parencite[p.~3]{a¦}', { kind: 'literal', detail: 'citation key', arg: { index: 1 } }],
    ['\\citeyearNP{a¦}', { kind: 'literal', detail: 'citation key' }],
    ['\\label{fig:x_y¦}', { kind: 'literal', detail: 'label', arg: { kind: 'label' } }],
    ['\\ref{x¦}', { kind: 'literal', detail: 'reference key', arg: { kind: 'ref-key' } }],
    ['\\cref{a,¦b}', { kind: 'literal', detail: 'reference key' }],
    ['\\hyperref[sec:a¦]{text}', { kind: 'literal', detail: 'reference key' }],
    ['\\textcolor{re¦d}{x}', { kind: 'literal', detail: 'color', arg: { kind: 'color', index: 0 } }],
    ['\\begin{tab¦ular}{ll}\\end{tabular}', { kind: 'literal', detail: 'environment name', arg: { command: 'begin', kind: 'env-name' } }],
    ['\\begin{itemize}\\item a\\end{item¦ize}', { kind: 'literal', detail: 'environment name', arg: { command: 'end' } }],
    ['\\SI{3.5¦}{\\metre}', { kind: 'literal', detail: 'units' }],
    ['\\ce{H2¦O}', { kind: 'literal', detail: 'chemistry' }],
    ['\\begin{tikzpicture}\\node at (0,0) {a¦};\\end{tikzpicture}', { kind: 'code', detail: 'tikzpicture' }],
    ['\\begin{tikzpicture}\\node at (0,0) {$x¦$};\\end{tikzpicture}', { kind: 'code', detail: 'tikzpicture' }],
    ['\\setlength{\\parindent}{0p¦t}', { kind: 'code', detail: 'option' }],
  ]);
});

describe('contextAt: preamble, definitions and the document', () => {
  run([
    [`${PREAMBLE}\\pagestyle{emp¦ty}\n\\begin{document}\nx\n\\end{document}\n`, { kind: 'code', preamble: true, inDocument: false }],
    [`${PREAMBLE}\\foo{x¦}\n\\begin{document}\nx\n\\end{document}\n`, { kind: 'code', detail: 'preamble', preamble: true }],
    [`${PREAMBLE}\\title{My ti¦tle}\n\\begin{document}\nx\n\\end{document}\n`, { kind: 'text', preamble: true, arg: { command: 'title', kind: 'text' } }],
    [`${PREAMBLE}\\title{A \\textbf{b¦}}\n\\begin{document}\nx\n\\end{document}\n`, { kind: 'text', preamble: true }],
    [`${PREAMBLE}\\author{A¦ B}\n\\begin{document}\nx\n\\end{document}\n`, { kind: 'text' }],
    [`${PREAMBLE}\\usepackage{pk¦g}\n\\begin{document}\nx\n\\end{document}\n`, { kind: 'literal', detail: 'package', arg: { kind: 'package' } }],
    [`${PREAMBLE}\\usepackage[op¦t]{x}\n\\begin{document}\nx\n\\end{document}\n`, { kind: 'code', detail: 'option' }],
    [`${PREAMBLE}\\hypersetup{pdftitle={X¦}}\n\\begin{document}\nx\n\\end{document}\n`, { kind: 'code', detail: 'option' }],
    [`${PREAMBLE}\\newcommand{\\R}{\\mathbb{R}¦}\n\\begin{document}\nx\n\\end{document}\n`, { kind: 'code', detail: 'definition', arg: { command: 'newcommand', kind: 'definition' } }],
    [`${PREAMBLE}\\newcommand{\\R¦}{x}\n\\begin{document}\nx\n\\end{document}\n`, { kind: 'code', detail: 'definition' }],
    [`${PREAMBLE}\\def\\x{y¦}\n\\begin{document}\nx\n\\end{document}\n`, { kind: 'code', detail: 'definition' }],
    [`${PREAMBLE}\\NewDocumentCommand{\\f}{m}{#1¦}\n\\begin{document}\nx\n\\end{document}\n`, { kind: 'code', detail: 'definition' }],
    [`${PREAMBLE}\\newcommand{\\foo}{$x¦$}\n\\begin{document}\nx\n\\end{document}\n`, { kind: 'code', detail: 'definition' }],
    [`${PREAMBLE}\\begin{document}\nx\n\\end{document}\naft¦er`, { kind: 'code', detail: 'after document', inDocument: false, preamble: false }],
    [`${PREAMBLE}\\begin{document}\n\\begin{itemize}\n\\item a¦\n\\end{itemize}\n\\end{document}\n`, { kind: 'text', env: 'itemize', envStack: ['document', 'itemize'], inDocument: true }],
    ['%!Chapter text with no preamble¦.', { kind: 'text', preamble: false, inDocument: true, env: null, envStack: [] }],
  ]);
});

describe('contextAt: positions and readiness', () => {
  it('is the same either side of a closed argument', () => {
    for (const side of [-1, 1] as const) expect(ctx(inDoc('\\url{a}¦ b'), { side }).kind).toBe('text');
  });

  it('returns null without a LaTeX tree', () => {
    const state = EditorState.create({ doc: 'a & b' });
    expect(contextAt(state, 2)).toBeNull();
  });

  it('returns null outside the document', () => {
    const { state } = at('a');
    expect(contextAt(state, 5)).toBeNull();
    expect(contextAt(state, -1)).toBeNull();
  });
});
