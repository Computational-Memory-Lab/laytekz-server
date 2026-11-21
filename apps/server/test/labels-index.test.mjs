/**
 * The label index (labels.ts, WP15): every \label with its kind, environment,
 * title, line and offset, for the cross-reference picker and go to
 * definition. Commented-out labels are not labels; duplicates are flagged;
 * theorem names come from \newtheorem; files after \appendix give appendix
 * headings. Pure functions, no store.
 */
import { check, eq } from './assert.mjs';
const { labelsIn, theoremsIn, markDuplicates, appendixFiles, maskTex } = await import('../src/labels.ts');

const byLabel = (list) => Object.fromEntries(list.map((l) => [l.label, l]));

const doc = [
  '\\documentclass{article}',                                   // 1
  '\\newtheorem{hyp}{Hypothesis}',                              // 2
  '\\begin{document}',                                          // 3
  '\\section[Short method]{The method in full}\\label{sec:method}', // 4
  'Text % \\label{sec:commented}',                              // 5
  '\\begin{figure}',                                            // 6
  '  \\centering',                                              // 7
  '  \\caption[Mean RTs]{Mean reaction times by \\emph{group}.\\label{fig:rt}}', // 8
  '  \\begin{subfigure}{0.4\\textwidth}',                        // 9
  '    \\caption{Left}\\label{fig:left}',                        // 10
  '  \\end{subfigure}',                                         // 11
  '\\end{figure}',                                              // 12
  '\\begin{table}',                                             // 13
  '  \\label{tab:early}',                                       // 14
  '  \\caption{Descriptive statistics}',                        // 15
  '\\end{table}',                                               // 16
  '\\begin{align}',                                             // 17
  '  a &= b + c \\label{eq:sum} \\\\',                          // 18
  '  d &= e',                                                   // 19
  '\\end{align}',                                               // 20
  '\\begin{enumerate}',                                         // 21
  '  \\item First \\label{item:first}',                         // 22
  '\\end{enumerate}',                                           // 23
  '\\begin{hyp}[Speed]\\label{hyp:speed} Faster.\\end{hyp}',    // 24
  '\\begin{minipage}{0.5\\linewidth}',                          // 25
  '  \\captionof{figure}{A loose figure}\\label{fig:loose}',    // 26
  '\\end{minipage}',                                            // 27
  '\\begin{longtable}{ll}',                                     // 28
  '  \\caption{Long one}\\label{tab:long} \\\\',                // 29
  '\\end{longtable}',                                           // 30
  'Note.\\footnote{See here.\\label{fn:see}}',                  // 31
  '\\begin{verbatim}',                                          // 32
  '\\label{verb:no}',                                           // 33
  '\\end{verbatim}',                                            // 34
  '\\verb|\\label{verb:inline}| and 50\\% \\label{sec:after-percent}', // 35
  '\\begin{comment}',                                           // 36
  '\\label{comment:no}',                                        // 37
  '\\end{comment}',                                             // 38
  '\\newcommand{\\figlabel}[1]{\\label{fig:#1}}',              // 39
  '\\end{document}',                                            // 40
].join('\r\n');

const list = labelsIn(doc, 'main.tex');
const L = byLabel(list);

eq(list.map((l) => l.label), ['sec:method', 'fig:rt', 'fig:left', 'tab:early', 'eq:sum', 'item:first', 'hyp:speed', 'fig:loose', 'tab:long', 'fn:see', 'sec:after-percent'],
  'labels in file order; commented-out, verbatim, \\verb, comment-environment and macro-parameter labels are left out');

eq([L['sec:method'].kind, L['sec:method'].env, L['sec:method'].title, L['sec:method'].line], ['section', 'section', 'Short method', 4], 'a heading label: kind, command, short title, line');
eq([L['fig:rt'].kind, L['fig:rt'].env, L['fig:rt'].title], ['figure', 'figure', 'Mean RTs'], 'a label inside its caption names the figure, short caption first');
eq([L['fig:left'].kind, L['fig:left'].env, L['fig:left'].title], ['subfigure', 'subfigure', 'Left'], 'a subfigure has its own kind and caption');
eq([L['tab:early'].kind, L['tab:early'].title], ['table', 'Descriptive statistics'], 'a label before the caption still gets the caption');
eq([L['eq:sum'].kind, L['eq:sum'].env, L['eq:sum'].title], ['equation', 'align', 'a &= b + c'], 'an align row: equation kind, the row as its title');
eq([L['item:first'].kind, L['item:first'].env], ['item', 'enumerate'], 'an enumerate item');
eq([L['hyp:speed'].kind, L['hyp:speed'].env, L['hyp:speed'].envTitle, L['hyp:speed'].title], ['theorem', 'hyp', 'Hypothesis', 'Speed'], 'a \\newtheorem environment: printed name and note');
eq([L['fig:loose'].kind, L['fig:loose'].title], ['figure', 'A loose figure'], '\\captionof{figure} makes a figure label');
eq([L['tab:long'].kind, L['tab:long'].env, L['tab:long'].title], ['table', 'longtable', 'Long one'], 'a longtable');
eq(L['fn:see'].kind, 'footnote', 'a label in a footnote');
eq(L['sec:after-percent'].kind, 'section', 'an escaped percent is no comment');

// offsets are into the LF text, as CodeMirror holds it
const lf = doc.replace(/\r\n/g, '\n');
for (const l of list) check(lf.startsWith('\\label', l.from), `${l.label}: from points at its \\label`);
eq(L['fig:left'].line, 10, 'line numbers count LF lines');

// duplicates across files
const two = markDuplicates([...labelsIn('\\label{a}\\label{b}', 'one.tex'), ...labelsIn('\\label{a}', 'two.tex')]);
eq(two.map((l) => [l.label, l.file, !!l.duplicate]), [['a', 'one.tex', true], ['b', 'one.tex', false], ['a', 'two.tex', true]], 'a label defined twice is flagged in both places');
check(!('duplicate' in two[1]), 'a unique label carries no duplicate field');
eq(two[0].kind, 'other', 'a label before any heading or environment is other');
check(two[0].env === null && !('title' in two[0]), 'and has no environment or title');

// theorem names from another file; common names without \newtheorem
const theorems = theoremsIn('\\newtheorem{conj}[theorem]{Conjecture}');
eq(labelsIn('\\begin{conj}\\label{c:1}\\end{conj}', 'b.tex', { theorems })[0].envTitle, 'Conjecture', 'a theorem defined in another file');
eq(labelsIn('\\begin{lemma}\\label{l:1}\\end{lemma}', 'b.tex')[0].envTitle, 'Lemma', 'a common theorem name needs no \\newtheorem');

// \appendix: in the file, and in files included after it
const app = labelsIn('\\section{Intro}\\label{sec:i}\n\\appendix\n\\section{Materials}\\label{app:m}\n\\subsection{Stimuli}\\label{app:s}', 'main.tex');
eq(app.map((l) => [l.kind, l.env, l.title]), [['section', 'section', 'Intro'], ['appendix', 'section', 'Materials'], ['appendix', 'subsection', 'Stimuli']], 'headings after \\appendix are appendix labels');
const files = { 'main.tex': '\\input{intro}\n% \\appendix\n\\appendix\n\\input{appendix/a}\n', 'intro.tex': 'x', 'appendix/a.tex': '\\input{appendix/b}', 'appendix/b.tex': 'y' };
eq([...appendixFiles('main.tex', (p) => files[p] ?? null)].sort(), ['appendix/a.tex', 'appendix/b.tex'], 'files included after \\appendix, and what they include');
eq(labelsIn('\\section{Data}\\label{app:d}', 'appendix/a.tex', { appendix: true })[0].kind, 'appendix', 'a file that starts after \\appendix');

// masking keeps offsets
const masked = maskTex('a % b\nc \\% d % e\n');
eq(masked.length, 'a % b\nc \\% d % e\n'.length, 'masking keeps the length');
check(masked.includes('\\%') && !masked.includes('b') && !masked.includes('e'), 'comments blanked, an escaped percent kept');

// cleveref's \label[type]{name}; \labelformat is no label
eq(labelsIn('\\labelformat{equation}{(#1)}\\section{S}\\label[appsec]{s:x}', 'c.tex').map((l) => l.label), ['s:x'], '\\label[type]{name} counts, \\labelformat does not');

console.log('labels-index: ok');
