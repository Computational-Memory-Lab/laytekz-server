/**
 * The LaTeX vocabulary the editor and the server share: environment and
 * command names grouped by what they mean for typing, tables, citations,
 * cross-references and counting. Pure data: no imports, no side effects.
 *
 * Byte-identical twins: apps/web/src/latex/vocab.ts and
 * apps/server/src/latex/vocab.ts. The web image builds from apps/web alone
 * and the server's NodeNext build cannot import from the web app, so each
 * keeps a copy. Edit one, copy it over the other:
 * apps/web/src/latex/__tests__/vocab.test.ts, apps/server/test/vocab-twin.test.mjs
 * and scripts/v2/check-contracts.mjs fail while they differ.
 *
 * Names are written without the backslash. A starred environment is listed
 * when it exists; a command's star is not part of its name here (`section`
 * covers `\section*`).
 */

export type TableFamilyName = 'tabular' | 'array' | 'align';

/** Environments that start math mode from text; their body is math. `math` is inline, the rest display. */
export const MATH_ENVIRONMENTS: readonly string[] = [
  'equation', 'equation*', 'displaymath', 'math', 'multline', 'multline*',
  'align', 'align*', 'alignat', 'alignat*', 'flalign', 'flalign*', 'xalignat', 'xalignat*', 'xxalignat',
  'gather', 'gather*', 'eqnarray', 'eqnarray*', 'IEEEeqnarray', 'IEEEeqnarray*',
  'dmath', 'dmath*', 'dseries', 'dseries*', 'dgroup', 'dgroup*', 'darray', 'darray*',
  'subeqnarray', 'subeqnarray*', 'numcases', 'subnumcases', 'empheq', 'tikzcd',
];

/** Environments used inside math; their body is math too. */
export const INNER_MATH_ENVIRONMENTS: readonly string[] = [
  'aligned', 'alignedat', 'gathered', 'lgathered', 'rgathered', 'split', 'multlined',
  'cases', 'cases*', 'dcases', 'dcases*', 'rcases', 'rcases*', 'drcases', 'drcases*',
  'matrix', 'matrix*', 'pmatrix', 'pmatrix*', 'bmatrix', 'bmatrix*', 'Bmatrix', 'Bmatrix*',
  'vmatrix', 'vmatrix*', 'Vmatrix', 'Vmatrix*', 'smallmatrix', 'smallmatrix*',
  'psmallmatrix', 'bsmallmatrix', 'Bsmallmatrix', 'vsmallmatrix', 'Vsmallmatrix',
  'array', 'subarray', 'CD',
  'NiceArray', 'pNiceArray', 'bNiceArray', 'BNiceArray', 'vNiceArray', 'VNiceArray',
  'NiceMatrix', 'pNiceMatrix', 'bNiceMatrix', 'BNiceMatrix', 'vNiceMatrix', 'VNiceMatrix',
  'IEEEeqnarraybox', 'IEEEeqnarraybox*',
];

/**
 * Environments whose body `&` separates cells, by family: `tabular` (text
 * tables), `array` (math arrays, matrices, cases), `align` (equation
 * alignment). gather, multline, equation and tabbing have no cells.
 */
export const TABLE_ENVIRONMENTS: Readonly<Record<string, TableFamilyName>> = {
  tabular: 'tabular', 'tabular*': 'tabular', tabularx: 'tabular', tabulary: 'tabular', xltabular: 'tabular',
  longtable: 'tabular', 'longtable*': 'tabular', supertabular: 'tabular', 'supertabular*': 'tabular',
  mpsupertabular: 'tabular', 'mpsupertabular*': 'tabular', xtabular: 'tabular', 'xtabular*': 'tabular',
  mpxtabular: 'tabular', 'mpxtabular*': 'tabular', tabu: 'tabular', longtabu: 'tabular',
  tblr: 'tabular', longtblr: 'tabular', talltblr: 'tabular',
  NiceTabular: 'tabular', 'NiceTabular*': 'tabular', NiceTabularX: 'tabular',

  array: 'array',
  matrix: 'array', 'matrix*': 'array', pmatrix: 'array', 'pmatrix*': 'array', bmatrix: 'array', 'bmatrix*': 'array',
  Bmatrix: 'array', 'Bmatrix*': 'array', vmatrix: 'array', 'vmatrix*': 'array', Vmatrix: 'array', 'Vmatrix*': 'array',
  smallmatrix: 'array', 'smallmatrix*': 'array', psmallmatrix: 'array', bsmallmatrix: 'array',
  Bsmallmatrix: 'array', vsmallmatrix: 'array', Vsmallmatrix: 'array',
  cases: 'array', 'cases*': 'array', dcases: 'array', 'dcases*': 'array', rcases: 'array', 'rcases*': 'array',
  drcases: 'array', 'drcases*': 'array', numcases: 'array', subnumcases: 'array',
  NiceArray: 'array', pNiceArray: 'array', bNiceArray: 'array', BNiceArray: 'array', vNiceArray: 'array', VNiceArray: 'array',
  NiceMatrix: 'array', pNiceMatrix: 'array', bNiceMatrix: 'array', BNiceMatrix: 'array', vNiceMatrix: 'array', VNiceMatrix: 'array',

  align: 'align', 'align*': 'align', alignat: 'align', 'alignat*': 'align', flalign: 'align', 'flalign*': 'align',
  xalignat: 'align', 'xalignat*': 'align', xxalignat: 'align', eqnarray: 'align', 'eqnarray*': 'align',
  aligned: 'align', alignedat: 'align', split: 'align',
  IEEEeqnarray: 'align', 'IEEEeqnarray*': 'align', IEEEeqnarraybox: 'align', 'IEEEeqnarraybox*': 'align',
  subeqnarray: 'align', 'subeqnarray*': 'align',
};

/**
 * The arguments after `\begin{name}` of a table environment, in order: `{`
 * mandatory, `[` optional. The body starts after them. Absent: none.
 * (`tabu`'s `to <width>` prefix is not described; its body starts after
 * whatever the parser took as arguments.)
 */
export const TABLE_ENVIRONMENT_ARGS: Readonly<Record<string, string>> = {
  tabular: '[{', 'tabular*': '{[{', tabularx: '{[{', tabulary: '{[{', xltabular: '[{{',
  longtable: '[{', 'longtable*': '[{', supertabular: '{', 'supertabular*': '{{',
  mpsupertabular: '{', 'mpsupertabular*': '{{', xtabular: '[{', 'xtabular*': '{[{',
  mpxtabular: '[{', 'mpxtabular*': '{[{', tabu: '{', longtabu: '{',
  tblr: '[{', longtblr: '[{', talltblr: '[{',
  NiceTabular: '[{[', 'NiceTabular*': '{[{[', NiceTabularX: '{[{[',
  array: '[{', NiceArray: '{[', pNiceArray: '{[', bNiceArray: '{[', BNiceArray: '{[', vNiceArray: '{[', VNiceArray: '{[',
  'matrix*': '[', 'pmatrix*': '[', 'bmatrix*': '[', 'Bmatrix*': '[', 'vmatrix*': '[', 'Vmatrix*': '[', 'smallmatrix*': '[',
  NiceMatrix: '[', pNiceMatrix: '[', bNiceMatrix: '[', BNiceMatrix: '[', vNiceMatrix: '[', VNiceMatrix: '[',
  alignat: '{', 'alignat*': '{', xalignat: '{', 'xalignat*': '{', xxalignat: '{', alignedat: '[{', aligned: '[',
  IEEEeqnarray: '[{', 'IEEEeqnarray*': '[{', IEEEeqnarraybox: '[[{', 'IEEEeqnarraybox*': '[[{',
};

/** Environments whose body is typeset exactly as written (or is another language). */
export const VERBATIM_ENVIRONMENTS: readonly string[] = [
  'verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'BVerbatim', 'BVerbatim*', 'LVerbatim', 'LVerbatim*',
  'SaveVerbatim', 'VerbatimOut', 'boxedverbatim', 'spverbatim', 'alltt', 'comment',
  'lstlisting', 'minted', 'tcblisting', 'codeexample',
  'filecontents', 'filecontents*', 'luacode', 'luacode*', 'pycode', 'sageblock', 'sagesilent',
];

/** Environments whose body is drawing code rather than prose. */
export const CODE_ENVIRONMENTS: readonly string[] = [
  'tikzpicture', 'pgfpicture', 'pspicture', 'circuitikz', 'forest',
];

/** Theorem-like environments: their optional argument is a title (text). Documents add their own with \newtheorem. */
export const THEOREM_ENVIRONMENTS: readonly string[] = [
  'theorem', 'lemma', 'proposition', 'corollary', 'definition', 'conjecture', 'example', 'examples',
  'remark', 'remarks', 'note', 'notation', 'claim', 'fact', 'observation', 'assumption', 'hypothesis',
  'axiom', 'proof', 'exercise', 'problem', 'solution', 'question', 'answer', 'property', 'criterion',
  'principle', 'condition',
  'thm', 'lem', 'prop', 'cor', 'defn', 'dfn', 'rem', 'rmk', 'ex', 'exa', 'conj', 'obs', 'assump',
];

/** Floating environments (captions and labels of figures and tables). */
export const FLOAT_ENVIRONMENTS: readonly string[] = [
  'figure', 'figure*', 'table', 'table*', 'wrapfigure', 'wraptable', 'sidewaysfigure', 'sidewaystable',
  'subfigure', 'subtable', 'SCfigure', 'SCtable', 'marginfigure', 'margintable', 'algorithm', 'listing',
];

/** List environments (\item). */
export const LIST_ENVIRONMENTS: readonly string[] = [
  'itemize', 'itemize*', 'enumerate', 'enumerate*', 'description', 'description*', 'list', 'trivlist',
  'compactitem', 'compactenum', 'compactdesc', 'inparaenum', 'asparaenum', 'asparaitem',
];

/** Other environments known to hold prose, never cells (tables, floats and lists aside). */
export const TEXT_ENVIRONMENTS: readonly string[] = [
  'document', 'abstract', 'center', 'flushleft', 'flushright', 'quote', 'quotation', 'verse',
  'minipage', 'titlepage', 'appendix', 'appendices', 'multicols', 'multicols*',
  'frame', 'block', 'alertblock', 'exampleblock', 'columns', 'column',
  'threeparttable', 'tablenotes', 'landscape', 'spacing', 'singlespace', 'doublespace', 'onehalfspace',
  'adjustbox', 'tcolorbox', 'mdframed', 'framed', 'shaded', 'thebibliography', 'subequations',
  'tabbing', 'letter',
];

/**
 * Argument roles, one letter each:
 *   U URL · P file path · K citation key · R cross-reference key · L label ·
 *   G package or class · E environment name · C colour · N name being
 *   defined · D definition body · O option or setting (code) · X value a
 *   package reads (units, chemistry, glossary keys) · V typeset exactly as
 *   written · T text · M math.
 * A role string lists the mandatory `{…}` arguments' roles in order in
 * upper case and the optional `[…]` arguments' roles in order in lower case;
 * the two sequences are independent, and the last letter of each repeats for
 * further arguments. Without an entry a mandatory argument is text (math
 * inside math) and an optional one is an option.
 */
export const ENVIRONMENT_ARGS: Readonly<Record<string, string>> = {
  frame: 'oTT', block: 'T', alertblock: 'T', exampleblock: 'T', column: 'oO', columns: 'o',
  multicols: 'Ot', 'multicols*': 'Ot', filecontents: 'oP', 'filecontents*': 'oP',
  thebibliography: 'O', minted: 'oX', subfigure: 'oO', subtable: 'oO', minipage: 'oooO',
};

/** Sectioning commands and their depth (part highest). */
export const SECTIONING_LEVELS: Readonly<Record<string, number>> = {
  part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5,
  addpart: -1, addchap: 0, addsec: 1, minisec: 4,
};

/** Commands whose braced arguments are citation keys (natbib, biblatex, apacite, cite). */
export const CITE_COMMANDS: readonly string[] = [
  'cite', 'Cite', 'citep', 'Citep', 'citet', 'Citet', 'citealp', 'Citealp', 'citealt', 'Citealt',
  'citeauthor', 'Citeauthor', 'citeyear', 'citeyearpar', 'citenum', 'citen', 'citeonline',
  'citetitle', 'Citetitle', 'citedate', 'citeurl', 'citepalias', 'citetalias', 'nocite',
  'parencite', 'Parencite', 'parencites', 'Parencites', 'textcite', 'Textcite', 'textcites', 'Textcites',
  'autocite', 'Autocite', 'autocites', 'Autocites', 'footcite', 'footcites', 'footcitetext', 'footfullcite',
  'fullcite', 'smartcite', 'Smartcite', 'smartcites', 'Smartcites', 'supercite', 'supercites', 'cites', 'Cites',
  'citeA', 'citeNP', 'citeauthorNP', 'shortcite', 'shortciteA', 'shortciteNP', 'fullciteA', 'fullciteauthor',
  'nptextcite', 'mcite', 'Mcite', 'notecite', 'pnotecite', 'fnotecite', 'volcite', 'Volcite', 'pvolcite', 'fvolcite',
];

/** Commands whose braced arguments are cross-reference keys. */
export const REF_COMMANDS: readonly string[] = [
  'ref', 'Ref', 'eqref', 'pageref', 'autoref', 'Autoref', 'autopageref', 'nameref', 'Nameref',
  'cref', 'Cref', 'cpageref', 'Cpageref', 'crefrange', 'Crefrange', 'cpagerefrange', 'Cpagerefrange',
  'labelcref', 'labelcpageref', 'namecref', 'nameCref', 'namecrefs', 'nameCrefs', 'lcnamecref', 'lcnamecrefs',
  'vref', 'Vref', 'vpageref', 'vrefrange', 'vpagerefrange', 'fref', 'Fref', 'pref', 'tref', 'titleref',
  'subref', 'zref', 'zcref', 'zpageref', 'fullref', 'thref',
];

/** Commands that define a label. */
export const LABEL_COMMANDS: readonly string[] = ['label', 'zlabel', 'thlabel'];

/** Commands whose argument is text even inside math. */
export const TEXT_IN_MATH_COMMANDS: readonly string[] = [
  'text', 'textrm', 'textit', 'textbf', 'textsf', 'texttt', 'textup', 'textnormal', 'textsc', 'textsl', 'textmd',
  'emph', 'mbox', 'hbox', 'fbox', 'makebox', 'framebox', 'parbox', 'intertext', 'shortintertext', 'tag',
];

/** Commands whose argument is set in a monospace font (and is never math). */
export const MONO_COMMANDS: readonly string[] = [
  'texttt', 'code', 'path', 'url', 'nolinkurl', 'verb', 'Verb', 'lstinline', 'mintinline',
];

/** Commands whose argument is read character by character, so `%` and `#` in it are literal. */
export const VERBATIM_READ_COMMANDS: readonly string[] = [
  'url', 'href', 'path', 'nolinkurl', 'verb', 'Verb', 'lstinline', 'mintinline',
];

/** Preamble commands whose arguments are text (titles, authors, keywords; apa7's fields included). */
export const PREAMBLE_TEXT_COMMANDS: readonly string[] = [
  'title', 'subtitle', 'author', 'date', 'thanks', 'affil', 'affiliation', 'institute', 'keywords',
  'shorttitle', 'leftheader', 'abstract', 'authornote', 'note', 'course', 'professor', 'duedate', 'journal',
  'titlerunning', 'authorrunning', 'subject', 'dedication', 'address', 'publishers', 'subjclass', 'titlehead',
];

/** Function names TeX sets upright as operators (`\sin`, `\lim`, …). */
export const MATH_OPERATOR_NAMES: readonly string[] = [
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'coth', 'arcsin', 'arccos', 'arctan',
  'log', 'ln', 'lg', 'exp', 'lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker',
  'arg', 'deg', 'gcd', 'hom', 'Pr',
];

/** Greek letters as math commands. */
export const GREEK_LETTERS: readonly string[] = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota',
  'kappa', 'varkappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma',
  'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega', 'digamma',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
  'varGamma', 'varDelta', 'varTheta', 'varLambda', 'varXi', 'varPi', 'varSigma', 'varUpsilon', 'varPhi', 'varPsi', 'varOmega',
];

/**
 * Commands that typeset only in math (Greek letters and operator names
 * aside): relations, arrows, operators, constructs, accents, math fonts,
 * symbols, delimiters. Left out because they also work in text: \ldots,
 * \dots, \S, \P, \dag, \ddag, \underline, \checkmark, \ensuremath.
 */
export const MATH_ONLY_COMMANDS: readonly string[] = [
  'le', 'leq', 'ge', 'geq', 'neq', 'ne', 'approx', 'sim', 'simeq', 'cong', 'equiv', 'propto', 'in', 'notin', 'ni',
  'subset', 'subseteq', 'subsetneq', 'supset', 'supseteq', 'supsetneq', 'll', 'gg', 'prec', 'preceq', 'succ', 'succeq',
  'mid', 'nmid', 'parallel', 'perp', 'vdash', 'models', 'asymp', 'doteq', 'lesssim', 'gtrsim', 'leqslant', 'geqslant',
  'to', 'gets', 'mapsto', 'rightarrow', 'leftarrow', 'Rightarrow', 'Leftarrow', 'leftrightarrow', 'Leftrightarrow',
  'longrightarrow', 'longleftarrow', 'Longrightarrow', 'Longleftarrow', 'longmapsto', 'implies', 'impliedby', 'iff',
  'uparrow', 'downarrow', 'Uparrow', 'Downarrow', 'nearrow', 'searrow', 'hookrightarrow', 'hookleftarrow',
  'times', 'cdot', 'div', 'pm', 'mp', 'cap', 'cup', 'wedge', 'vee', 'land', 'lor', 'oplus', 'ominus', 'otimes',
  'oslash', 'odot', 'circ', 'ast', 'star', 'setminus', 'bullet', 'diamond', 'sqcap', 'sqcup', 'uplus', 'amalg', 'wr',
  'sum', 'prod', 'coprod', 'int', 'iint', 'iiint', 'oint', 'bigcup', 'bigcap', 'bigoplus', 'bigotimes', 'bigvee',
  'bigwedge', 'bigsqcup',
  'frac', 'dfrac', 'tfrac', 'cfrac', 'sqrt', 'binom', 'dbinom', 'tbinom', 'overline', 'underbrace', 'overbrace',
  'overset', 'underset', 'stackrel', 'xrightarrow', 'xleftarrow', 'substack',
  'hat', 'widehat', 'tilde', 'widetilde', 'bar', 'vec', 'dot', 'ddot', 'dddot', 'acute', 'grave', 'check', 'breve',
  'mathring', 'overrightarrow', 'overleftarrow',
  'mathbb', 'mathcal', 'mathfrak', 'mathscr', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'boldsymbol', 'bm',
  'operatorname',
  'partial', 'nabla', 'infty', 'forall', 'exists', 'nexists', 'emptyset', 'varnothing', 'cdots', 'vdots', 'ddots',
  'prime', 'angle', 'triangle', 'Re', 'Im', 'aleph', 'beth', 'hbar', 'ell', 'wp', 'top', 'bot', 'neg', 'lnot', 'mho',
  'langle', 'rangle', 'lfloor', 'rfloor', 'lceil', 'rceil', 'lvert', 'rvert', 'lVert', 'rVert', 'backslash',
  'left', 'right', 'middle', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr',
];

const KEYS_ONLY = (names: readonly string[], role: string): [string, string][] => names.map((n) => [n, role]);

/** Argument roles of commands (the letters are explained above ENVIRONMENT_ARGS). */
export const COMMAND_ARGS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(KEYS_ONLY(CITE_COMMANDS, 'ttK')),
  ...Object.fromEntries(KEYS_ONLY(REF_COMMANDS, 'R')),
  ...Object.fromEntries(KEYS_ONLY(LABEL_COMMANDS, 'L')),
  ...Object.fromEntries(KEYS_ONLY(Object.keys(SECTIONING_LEVELS), 'tT')),
  ...Object.fromEntries(KEYS_ONLY(PREAMBLE_TEXT_COMMANDS, 'tT')),
  defcitealias: 'KT', bibitem: 'tK', hyperref: 'rT', crefname: 'OTT', Crefname: 'OTT',

  // text
  caption: 'tT', subcaption: 'tT', captionof: 'OtT', footnote: 'oT', footnotetext: 'oT', footnotemark: 'o',
  marginpar: 'tT', marginnote: 'oT', item: 't', textbf: 'T', textit: 'T', textsl: 'T', textsc: 'T', textup: 'T',
  textmd: 'T', textnormal: 'T', textrm: 'T', textsf: 'T', texttt: 'T', code: 'T', emph: 'T', underline: 'T',
  uline: 'T', sout: 'T', textsuperscript: 'T', textsubscript: 'T', text: 'T', intertext: 'T', shortintertext: 'T',
  tag: 'T', mbox: 'T', hbox: 'T', fbox: 'T', makebox: 'ooT', framebox: 'ooT', parbox: 'oooOT', raisebox: 'ooOT',
  resizebox: 'OOT', scalebox: 'OoT', rotatebox: 'oOT', reflectbox: 'T', makecell: 'oT', thead: 'oT',
  multicolumn: 'OOT', multirow: 'ooOOT', hl: 'T', newacronym: 'oOTT', settowidth: 'OT', settoheight: 'OT',

  // links, files, packages
  url: 'U', nolinkurl: 'U', href: 'oUT', email: 'U', doi: 'U', path: 'P', hyperlink: 'OT', hypertarget: 'OT',
  includegraphics: 'oP', includesvg: 'oP', includepdf: 'oP', includestandalone: 'oP', input: 'P', include: 'P',
  subfile: 'P', import: 'PP', subimport: 'PP', inputfrom: 'PP', includefrom: 'PP', subincludefrom: 'PP',
  includeonly: 'P', excludeonly: 'P', lstinputlisting: 'oP', inputminted: 'oXP', verbatiminput: 'P',
  VerbatimInput: 'oP', bibliography: 'P', addbibresource: 'oP', graphicspath: 'P',
  usepackage: 'oG', RequirePackage: 'oG', documentclass: 'oG', LoadClass: 'oG', usetikzlibrary: 'G',
  usepgfplotslibrary: 'G', tcbuselibrary: 'G', PassOptionsToPackage: 'OG', PassOptionsToClass: 'OG',
  usetheme: 'oG', usecolortheme: 'oG', usefonttheme: 'oG', useinnertheme: 'oG', useoutertheme: 'oG',
  bibliographystyle: 'G',

  // colours
  color: 'oC', textcolor: 'oCT', colorbox: 'oCT', fcolorbox: 'oCCT', pagecolor: 'oC', definecolor: 'oCOO',
  colorlet: 'oCC', arrayrulecolor: 'oC', rowcolor: 'oC', cellcolor: 'oC', columncolor: 'oC', rowcolors: 'oOCC',

  // definitions
  newcommand: 'NooD', renewcommand: 'NooD', providecommand: 'NooD', DeclareRobustCommand: 'NooD',
  def: 'D', gdef: 'D', edef: 'D', xdef: 'D',
  NewDocumentCommand: 'NOD', RenewDocumentCommand: 'NOD', ProvideDocumentCommand: 'NOD',
  DeclareDocumentCommand: 'NOD', NewExpandableDocumentCommand: 'NOD',
  newenvironment: 'EooDD', renewenvironment: 'EooDD', NewDocumentEnvironment: 'EODD', RenewDocumentEnvironment: 'EODD',
  DeclareMathOperator: 'ND', newtheorem: 'ETo', declaretheorem: 'oE', newcolumntype: 'NoD', newcounter: 'Oo',
  newlength: 'N', newsavebox: 'N', newfontfamily: 'NoO', newglossaryentry: 'OO', DeclareFieldFormat: 'oOD',

  // options and settings
  hypersetup: 'O', geometry: 'O', newgeometry: 'O', lstset: 'O', sisetup: 'O', tikzset: 'O', pgfplotsset: 'O',
  pgfkeys: 'O', captionsetup: 'oO', setlist: 'oO', fvset: 'O', setminted: 'oO', setmintedinline: 'oO',
  usemintedstyle: 'oO', setlength: 'OO', addtolength: 'OO', setcounter: 'OO', addtocounter: 'OO',
  stepcounter: 'O', refstepcounter: 'O', pagestyle: 'O', thispagestyle: 'O', pagenumbering: 'O', numberwithin: 'oOO',
  setstretch: 'O', linespread: 'O', setmainfont: 'oO', setsansfont: 'oO', setmonofont: 'oO', setmathfont: 'oO',
  fontsize: 'OO', titleformat: 'OoOOOOo', titlespacing: 'OOOO', vspace: 'O', hspace: 'O', rule: 'oOO', cline: 'O',
  cmidrule: 'oO', setbeamertemplate: 'OoO', setbeamercolor: 'OO', setbeamerfont: 'OO', DeclareGraphicsExtensions: 'O',
  ExecuteBibliographyOptions: 'oO', DeclareLanguageMapping: 'OO', babelprovide: 'oO', selectlanguage: 'O',
  hyphenation: 'O', urlstyle: 'O', setcitestyle: 'O', citestyle: 'O', theoremstyle: 'O', newtheoremstyle: 'O',

  // values a package reads
  ce: 'X', pu: 'X', SI: 'oX', si: 'oX', qty: 'oX', unit: 'oX', num: 'oX', ang: 'oX', SIrange: 'oX', numrange: 'oX',
  qtyrange: 'oX', SIlist: 'oX', numlist: 'oX', qtylist: 'oX', tablenum: 'oX',
  gls: 'oX', Gls: 'oX', glspl: 'oX', Glspl: 'oX', acrshort: 'oX', acrlong: 'oX', acrfull: 'oX', ac: 'oX', acs: 'oX', acl: 'oX', acp: 'oX',

  // typeset as written
  verb: 'V', Verb: 'oV', lstinline: 'oV', mintinline: 'oXV', detokenize: 'V',
};
