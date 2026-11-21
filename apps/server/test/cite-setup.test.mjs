/**
 * Citation package detection (citesetup.ts, WP15): the apa7 class options
 * choose the family (biblatex, natbib through apacite's natbibapa, apacite);
 * explicit packages otherwise; classes that load natbib; cleveref,
 * hyperref, amsmath, varioref, nameref; commented lines ignored; a preamble
 * split across \input files and a project .sty. Pure, no store.
 */
import { check, eq } from './assert.mjs';
const { citeSetupOf, splitOptions } = await import('../src/citesetup.ts');

const setup = (files, root = 'main.tex') => citeSetupOf((p) => files[p] ?? null, root);
const main = (preamble) => setup({ 'main.tex': `${preamble}\n\\begin{document}\nHello.\n\\end{document}\n` });
const pick = (s) => [s.family, s.familySource, s.label];

// apa7: its options choose the bibliography package
eq(pick(main('\\documentclass[man,biblatex]{apa7}')), ['biblatex', 'apa7[biblatex]', 'biblatex · APA'], 'apa7[biblatex]');
check(main('\\documentclass[man,biblatex]{apa7}').biblatexStyle === 'apa', 'apa7[biblatex] is style=apa');
check(main('\\documentclass[man,biblatex]{apa7}').apa, 'apa7 is APA');
eq(pick(main('\\documentclass[jou,natbib]{apa7}')), ['natbib', 'apa7[natbib]', 'natbib · APA'], 'apa7[natbib] is apacite with natbibapa: natbib commands');
check(main('\\documentclass[jou,natbib]{apa7}').natbibCommands, 'apa7[natbib] has \\citep');
eq(pick(main('\\documentclass[stu,apacite]{apa7}')), ['apacite', 'apa7[apacite]', 'apacite · APA'], 'apa7[apacite]');
eq(pick(main('\\documentclass[man]{apa7}')), ['bibtex', 'none', 'BibTeX'], 'apa7 without an option loads nothing');
eq(pick(main('\\documentclass[man]{apa7}\n\\usepackage[style=apa,backend=biber]{biblatex}')), ['biblatex', 'biblatex', 'biblatex · APA'], 'plain apa7 with an explicit biblatex');

// packages
eq(pick(main('\\documentclass{article}\n\\usepackage[round]{natbib}')), ['natbib', 'natbib', 'natbib'], 'natbib');
const bl = main('\\documentclass{article}\n\\usepackage[backend=biber, style=apa, natbib=true]{biblatex}');
eq([bl.family, bl.biblatexStyle, bl.natbibCommands, bl.apa], ['biblatex', 'apa', true, true], 'biblatex style=apa with natbib=true');
eq(main('\\documentclass{article}\n\\usepackage[style=authoryear,citestyle=authoryear-comp]{biblatex}').label, 'biblatex · authoryear-comp', 'citestyle wins over style');
eq(main('\\documentclass{article}\n\\usepackage{biblatex}').biblatexStyle, 'numeric', "biblatex's default style");
eq(pick(main('\\documentclass{article}\n\\usepackage[natbibapa]{apacite}')), ['natbib', 'apacite[natbibapa]', 'natbib · APA'], 'apacite with natbibapa');
eq(pick(main('\\documentclass{article}\n\\usepackage{apacite}')), ['apacite', 'apacite', 'apacite · APA'], 'apacite');
eq(pick(main('\\documentclass{article}')), ['bibtex', 'none', 'BibTeX'], 'nothing loaded: plain \\cite');

// classes that load natbib
eq(pick(main('\\documentclass[review]{elsarticle}')), ['natbib', 'class elsarticle', 'natbib'], 'elsarticle loads natbib');
eq(main('\\documentclass[usenatbib]{mnras}').family, 'natbib', 'mnras[usenatbib]');
eq(main('\\documentclass{mnras}').family, 'bibtex', 'mnras without usenatbib');
eq(main('\\documentclass{revtex4-2}').family, 'natbib', 'revtex loads natbib');

// cross-reference packages
const xr = main('\\documentclass{article}\n\\usepackage{mathtools}\n\\usepackage{hyperref}\n\\usepackage[capitalise,noabbrev]{cleveref}\n\\usepackage{varioref}');
eq([xr.cleveref, xr.cleverefCapitalise, xr.hyperref, xr.amsmath, xr.varioref, xr.nameref], [true, true, true, true, true, true], 'cleveref[capitalise], hyperref (and so nameref), mathtools (and so amsmath), varioref');
const bare = main('\\documentclass{article}\n\\usepackage{cleveref}');
eq([bare.cleveref, bare.cleverefCapitalise, bare.hyperref, bare.amsmath, bare.nameref], [true, false, false, false, false], 'cleveref without options, nothing else');
check(main('\\documentclass{amsart}').amsmath, 'an AMS class loads amsmath');
check(main('\\documentclass{article}\n\\PassOptionsToPackage{capitalize}{cleveref}\n\\usepackage{cleveref}').cleverefCapitalise, '\\PassOptionsToPackage counts');

// comments are ignored
eq(pick(main('\\documentclass{article}\n% \\usepackage[style=apa]{biblatex}\n\\usepackage{natbib} % not biblatex')), ['natbib', 'natbib', 'natbib'], 'a commented-out package is not loaded');
eq(main('\\documentclass[man%,biblatex\n]{apa7}').family, 'bibtex', 'a commented-out class option is not an option');

// a preamble split across \input files, a project .sty, and nothing after \begin{document}
const split = setup({
  'paper/main.tex': '\\documentclass[man,biblatex]{apa7}\n\\input{preamble/packages}\n\\begin{document}\n\\input{body}\n\\end{document}',
  'paper/preamble/packages.tex': '\\usepackage{labstyle}\n\\addbibresource{refs.bib}',
  'paper/labstyle.sty': '\\RequirePackage[capitalise]{cleveref}',
  'paper/body.tex': '\\usepackage{natbib}',
}, 'paper/main.tex');
eq([split.family, split.cleveref, split.cleverefCapitalise], ['biblatex', true, true], 'packages from an \\input preamble and a project .sty');
eq(split.files, ['paper/main.tex', 'paper/preamble/packages.tex', 'paper/labstyle.sty'], 'the files read: the root first, nothing after \\begin{document}');
check(!split.packages.includes('natbib'), 'a body file is not preamble');

eq(splitOptions('a, b={x,y} ,, c'), ['a', 'b={x,y}', 'c'], 'options split outside braces');

console.log('cite-setup: ok');
