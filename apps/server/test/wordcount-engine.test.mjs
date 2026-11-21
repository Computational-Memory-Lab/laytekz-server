/**
 * The V2 word-count engine (WP24): an APA-style manuscript laid out like the
 * write-paper projects (values file and abstract \input in the preamble, a
 * method file, a table file \input inside a table, statements, a
 * supplement after the references), counted cell by cell, plus the edge
 * cases one assertion each.
 */
import { check, eq } from './assert.mjs';

const E = await import('../src/wordcount/engine.ts');
const { countDocument, countText, resolveRule, applyRule, globMatch, citeEstimate, DEFAULT_RULE, PRESETS, sectionKey, printedWords } = E;

const files = {
  'manuscript.tex': [
    '\\documentclass[man]{apa7}',
    '\\usepackage{csquotes}',
    '\\input{generated/values}',
    '\\title{Attention Shapes Memory in Older Adults}',
    '\\shorttitle{Attention and Memory}',
    '\\authorsnames{Ada Lovelace, Alan Turing}',
    '\\authorsaffiliations{University of Somewhere}',
    '\\authornote{Correspondence: ada@example.org}',
    '\\leftheader{Lovelace}',
    '\\input{sections/abstract}',
    '\\keywords{attention, memory, aging}',
    '\\begin{document}',
    '\\maketitle',
    '\\section{Introduction}',
    'Memory depends on attention \\citep{smith2020, jones2019}. Prior work is well-known and',
    "doesn't agree on 12.3 percent of cases, e.g. in aging.",
    '\\input{sections/method}',
    '\\section{Discussion}',
    'Attention matters. % a note to self about wording',
    '%TC:ignore',
    'This paragraph is a draft and is ignored.',
    '%TC:endignore',
    '\\section{Acknowledgments}',
    'We thank the participants.',
    '\\section{Declarations}',
    '\\subsection{Funding}',
    'None declared.',
    '\\subsection{Conflicts of interest}',
    'The authors declare no conflicts.',
    '\\printbibliography',
    '\\section{Supplementary Materials}',
    '\\input{sections/supp}',
    '\\end{document}',
    'Words after the end are not counted.',
  ].join('\n'),
  'generated/values.tex': '\\newcommand{\\valN}{122}\n\\newcommand{\\valStat}{$t(121) = 3.2$}\n\\newcommand{\\valP}{.001}\n',
  'sections/abstract.tex': '\\abstract{We tested whether attention shapes memory. Results showed a reliable effect of \\valN{} participants.}\n',
  'sections/method.tex': [
    '\\section{Method}',
    '\\subsection{Participants}',
    'We recruited \\valN{} adults (see Table~\\ref{tab:demo}).',
    'The effect was reliable, \\valStat{}, as expected.\\footnote{Preregistered at the Open Science Framework.}',
    '\\begin{table}',
    '\\caption{Demographics of the sample}',
    '\\label{tab:demo}',
    '\\input{generated/tables/demo}',
    '\\end{table}',
    '\\begin{equation}',
    'y = \\beta x + \\epsilon',
    '\\end{equation}',
    '\\begin{figure}',
    '\\includegraphics[width=\\linewidth]{figures/main_effect.png}',
    '\\caption{Recall by group.}',
    '\\figurenote{Error bars show standard errors.}',
    '\\end{figure}',
  ].join('\n'),
  'generated/tables/demo.tex': [
    '\\begin{tabular}{lcc}', '\\toprule', 'Group & Age & Score \\\\', 'Young & 21.5 & 0.82 \\\\', 'Old & 70.1 & 0.75 \\\\', '\\bottomrule', '\\end{tabular}',
    '\\tablenote{Scores are proportions correct.}',
  ].join('\n'),
  'sections/supp.tex': '\\subsection{Additional analyses}\nWe repeated the analysis without outliers.\n\\begin{figure}\n\\caption{Supplementary recall plot.}\n\\end{figure}\n',
};
const read = (p) => files[p] ?? null;
const bibAuthors = { smith2020: 'Smith, Jane', jones2019: 'Jones, A. and Brown, B.' };
const citeWords = (k) => citeEstimate(bibAuthors[k]);

const doc = countDocument('manuscript.tex', read, DEFAULT_RULE, { citeWords });
const w = (cell) => doc.tally.words[cell] ?? 0;

// ---- the matrix, cell by cell ----
eq(w('front:text'), 22, 'front matter: title 6, short title 3, authors 4, affiliation 3, author note 3, keywords 3');
eq(w('abstract:text'), 14, 'abstract from the preamble \\abstract{} in its own file, \\valN expanded to one word');
eq(w('main:headings'), 4, 'main-text headings: Introduction, Method, Participants, Discussion');
eq(w('main:text'), 34, 'main text');
eq(w('main:citations'), 6, 'citations: one author 2 + two authors 4');
eq(w('main:footnotes'), 6, 'footnote');
eq(w('main:captions'), 12, 'captions: table caption 4, figure caption 3, figure note 5');
eq(w('main:tables'), 13, 'tables: 9 cells from the \\input table file inside table, plus the table note 4');
eq(w('statements:headings'), 6, 'statement headings, subsections included');
eq(w('statements:text'), 11, 'statements text');
eq(w('supplementary:headings'), 4, 'supplementary headings');
eq(w('supplementary:text'), 6, 'supplementary text');
eq(w('supplementary:captions'), 3, 'the supplementary caption is supplementary, not main captions');
eq(doc.tally.comments, 6, 'comment words tallied apart');
eq(doc.tally.ignored, 8, '%TC:ignore block tallied apart');
eq(doc.formulas, { inline: 1, display: 1 }, 'the macro formula and the equation environment');
eq(doc.total, 50, 'main text by default: text 34 + headings 4 + citations 6 + footnotes 6');
eq(Object.keys(doc.files), ['manuscript.tex', 'generated/values.tex', 'sections/abstract.tex', 'sections/method.tex', 'generated/tables/demo.tex', 'sections/supp.tex'], 'files in document order, depth first');
eq(doc.files['manuscript.tex'], 29, 'root file counted words');
eq(doc.files['sections/method.tex'], 21, 'method file counted words');
eq(doc.files['generated/values.tex'], 0, 'values file gives 0');
eq(doc.total, Object.values(doc.files).reduce((a, b) => a + b, 0), 'total === sum of files');
check(doc.why.some((y) => y.part === 'supplementary' && /Supplementary Materials/.test(y.reason) && y.file === 'manuscript.tex'), 'why: the supplementary heading, with its file');
check(doc.why.some((y) => y.part === 'statements' && /Acknowledgments/.test(y.reason)), 'why: the statements heading');
eq(doc.sections.map((s) => s.title), [null, 'Introduction', 'Method', 'Discussion', 'Acknowledgments', 'Declarations', 'Supplementary Materials'], 'top-level sections, across files');
eq(doc.sections.find((s) => s.title === 'Method').counted, 21, 'section counted words span the included file');
eq(doc.sections.find((s) => s.title === 'Declarations').part, 'statements', 'section part');
eq(doc.citedKeys.sort(), ['jones2019', 'smith2020'], 'cited keys');

// ---- presets ----
const ev = resolveRule({ preset: 'everything' });
eq(applyRule(doc.tally, ev), 22 + 14 + 4 + 34 + 6 + 6 + 12 + 13 + 6 + 11 + 4 + 6 + 3, 'everything: every part but references and excluded, every kind');
eq(applyRule(doc.tally, resolveRule({ preset: 'main-captions' })), 50 + 12, 'main text and captions');
eq(applyRule(doc.tally, resolveRule({ preset: 'main-abstract' })), 50 + 14, 'main text and abstract');
eq(applyRule(doc.tally, resolveRule({ preset: 'main-statements-appendix' })), 50 + 17, 'main, statements, appendix');
eq(applyRule(doc.tally, resolveRule({ preset: 'custom', parts: ['main', 'supplementary'], kinds: ['text'] })), 34 + 6, 'custom rule');
eq(applyRule(doc.tally, resolveRule({ formulas: 'one-word' })), 52, 'formulas as one word each');
eq(resolveRule({ preset: 'main', parts: ['front'] }).parts, ['main'], 'a preset decides the parts');
eq(resolveRule(null), DEFAULT_RULE, 'no stored rule: the default');
check(Object.keys(PRESETS).length === 5, 'five presets');

// ---- section override and detection switch ----
const over = countDocument('manuscript.tex', read, resolveRule({ sections: { Discussion: 'excluded' } }), { citeWords });
eq(over.total, 47, 'a section counted as "Not counted" drops its 3 words');
eq(over.tally.words['excluded:headings'], 1, 'its heading goes to excluded');
eq(over.tally.words['statements:text'], 11, 'the override ends at the next heading of its level');
const nodetect = countDocument('manuscript.tex', read, resolveRule({ detect: false }), { citeWords });
eq(nodetect.total, 50 + 17 + 4 + 6, 'detection off: statements and supplement count as main text');
eq(sectionKey('  Results:  '), 'results', 'section keys are plain lower-case titles');

// ---- edge cases ----
const one = (src, rule = DEFAULT_RULE, o) => countText(src, rule, o);
eq(one('Alpha %WC:supplementary\nbeta gamma\n%WC:main\ndelta').total, 2, '%WC: markers');
eq(one('Alpha %WC:supplementary\nbeta gamma\n%WC:main\ndelta').tally.words['supplementary:text'], 2, 'marked words are supplementary');
eq(one('Main words.\n\\appendix\n\\section{Extra}\nMore text.\n\\section{Second}\nStill appendix.').total, 2, '\\appendix lasts to the end');
eq(one('\\section{Funding}\nNone.\n\\section{Results}\nCounted here.').total, 3, 'a statements scope ends at a same-level heading');
eq(one('Text \\[ x^2 \\] and \\( y \\) and $$z$$ end.').formulas, { inline: 1, display: 2 }, '\\[ \\], \\( \\) and $$ are formulas');
eq(one('Text \\[ x^2 \\] and \\( y \\) and $$z$$ end.').total, 4, 'formula contents add no words');
eq(one('12.3 and 1,000 and e.g. well-known').total, 6, '12.3, 1,000, e.g. and well-known are one word each');
eq(one("caf\\'e d\\\"ej\\`a don't").total, 3, 'accent commands stay inside the word');
eq(one('日本語 text').total, 4, 'each Han or kana character is a word');
eq(one('Rock \\& roll -- yes~no').total, 5, '\\& counts; -- and ~ separate words');
eq(one('See \\ref{a}, \\cref{b} and \\Cref{c}.').total, 7, '\\ref 1, \\cref and \\Cref 2');
eq(one('\\label{x}\\includegraphics{a/b.png}\\url{http://x.y/z} \\href{http://x.y}{the site}').total, 2, 'labels, paths and URLs count 0; \\href counts its text');
const unclosed = one('\\caption{Open words\n\nAfter the blank line.');
eq(unclosed.tally.words['main:captions'], 2, 'an unclosed caption closes at a blank line');
eq(unclosed.tally.words['main:text'], 4, 'and the text after it is text');
eq(one('Before \\iffalse hidden \\if x nested \\fi words \\fi after').total, 2, '\\iffalse blocks');
eq(one('\\begin{verbatim}\ncode words here\n\\end{verbatim}\nProse.').total, 1, 'verbatim never counts');
eq(one('A \\cite{a,b,c} B', DEFAULT_RULE).tally.words['main:citations'], 6, 'unknown keys estimate 2 each');
eq(citeEstimate('A and B and C'), 4, 'three authors: "Smith et al., 2020" = 4');
eq(citeEstimate('A and B'), 4, 'two authors: "Smith & Jones, 2020" = 4');
eq(citeEstimate('Smith, J.'), 2, 'one author: 2');
eq(citeEstimate(undefined), 2, 'unknown: 2');
const numeric = countDocument('m.tex', (p) => (p === 'm.tex' ? '\\documentclass{article}\n\\begin{document}\nSee \\cite{a,b,c}.\n\\bibliographystyle{plain}\n\\end{document}' : null));
eq(numeric.tally.words['main:citations'], 1, 'numeric style: one word per command, even before \\bibliographystyle');
eq(printedWords(one('One \\footnote{two three} four').tally), 4, 'printed words cover every kind');

// ---- includes ----
const inc = (fs, root = 'main.tex') => countDocument(root, (p) => fs[p] ?? null);
const twice = inc({ 'main.tex': '\\input{a}\n\\input{a}\n\\input{main}', 'a.tex': 'Two words' });
eq(twice.total, 4, 'a file \\input twice counts twice');
eq(twice.occurrences.filter((o) => o.file === 'a.tex').map((o) => o.occ), [0, 1], 'two occurrences');
check(twice.unresolved.some((u) => u.reason === 'cycle'), 'an include cycle is cut and reported');
const only = inc({ 'main.tex': '\\includeonly{ch1}\n\\include{ch1}\n\\include{ch2}', 'ch1.tex': 'One two', 'ch2.tex': 'Three four five' });
eq(only.total, 2, '\\includeonly is honoured');
const imp = inc({ 'paper/main.tex': '\\import{parts/}{intro}\n\\subfile{sub}\n\\input bare\n\\input{\\dir/x}\n\\input{ghost}',
  'paper/parts/intro.tex': 'Intro has four words\n\\subimport{deeper/}{d}', 'paper/parts/deeper/d.tex': 'Deep',
  'paper/sub.tex': '\\documentclass[main]{subfiles}\n\\begin{document}\nSub body\n\\end{document}', 'paper/bare.tex': 'Bare one' }, 'paper/main.tex');
eq(imp.total, 4 + 1 + 2 + 2, '\\import, \\subimport, \\subfile and bare \\input are followed');
eq(imp.unresolved.map((u) => u.reason).sort(), ['macro', 'missing'], 'a macro path and a missing file are reported');
const tableCtx = inc({ 'main.tex': '\\begin{table}\n\\input{t}\n\\end{table}\nAfter.', 't.tex': 'A & B \\\\' });
eq(tableCtx.tally.words['main:tables'], 2, 'the table context carries into the \\input file');
eq(tableCtx.total, 1, 'and table text is not main text by default');
eq(tableCtx.occurrences[1].entry.envs, ['table'], 'the entry state carries the environment stack');

// ---- globs ----
check(globMatch('Supp*', 'Supplementary Materials'), '* matches a run');
check(globMatch('?at', 'Cat'), '? matches one character, case-insensitive');
check(!globMatch('a.c', 'abc'), 'regular expression characters are literal');
check(globMatch('a.c', 'A.C'), 'a literal point');
check(!globMatch('Funding', 'Funding sources'), 'whole-title match');

// ---- re-scan from the server's entry state (the client splice) ----
const methodOcc = doc.occurrences.find((o) => o.file === 'sections/method.tex');
const again = countText(files['sections/method.tex'], DEFAULT_RULE, { file: 'sections/method.tex', entry: methodOcc.entry, macros: doc.macros });
eq(again.total, 21, 're-scanning a file from its entry state gives the same count');

// ---- speed: a 415 KB document ----
const para = 'The participants completed \\textbf{several} tasks \\citep{smith2020} while we recorded $x_i$ responses, as in Table~\\ref{t}.\n\n';
const big = '\\documentclass{article}\n\\begin{document}\n' + Array.from({ length: 40 }, (_, i) => `\\section{Part ${i}}\n${para.repeat(Math.ceil(415000 / 40 / para.length))}`).join('') + '\\end{document}\n';
check(big.length >= 415000, 'the big document is at least 415 KB');
countDocument('big.tex', (p) => (p === 'big.tex' ? big : null)); // warm up
const t0 = performance.now();
const bigCount = countDocument('big.tex', (p) => (p === 'big.tex' ? big : null));
const ms = performance.now() - t0;
console.log(`wordcount-engine: ${(big.length / 1024).toFixed(0)} KB, ${bigCount.total} words in ${ms.toFixed(1)} ms`);
check(ms < 150, `a 415 KB document counts quickly (${ms.toFixed(1)} ms)`);

console.log('wordcount-engine: all checks passed');
