/**
 * The reference-aware rename's planner (fileRefs.ts, V2 feature 10): which
 * references a rename must rewrite, how the new argument is written, what is
 * left alone, and the same-name siblings of the main document. Pure.
 */
import { check, eq } from './assert.mjs';

const { planReferences, siblingRenames, planTitle, documentSources } = await import('../src/fileRefs.ts');

const PAPER = [
  '\\documentclass{article}',
  '\\usepackage{amsmath,style}',
  '\\graphicspath{{figs/}}',
  '\\addbibresource{paper.bib}',
  '\\begin{document}',
  '\\input{chapters/intro}',
  '\\includegraphics[width=3cm]{a}',
  '% \\input{chapters/intro}',
  '\\bibliography{refs,paper}',
  '\\input{\\chapdir/intro}',
  '\\end{document}',
  '',
].join('\n');
const INTRO = '% !TEX root = ../paper.tex\nIntro text.\n';
const files = ['paper.tex', 'paper.bib', 'refs.bib', 'style.sty', 'figs/a.png', 'chapters/intro.tex', 'paper.log', '.latexmkrc'];
const sources = [
  { path: 'paper.tex', text: PAPER },
  { path: 'chapters/intro.tex', text: INTRO },
  { path: '.latexmkrc', text: "@default_files = ('paper.tex');\n" },
];
const plan = (moves) => planReferences(sources, files, 'paper.tex', moves);
const pick = (p) => p.edits.map((e) => `${e.file}:${e.line} ${e.kind} ${e.oldArg} -> ${e.newArg}`).sort();

// ---- the main document and its sibling .bib renamed together
{
  const sib = siblingRenames(files, 'paper.tex', 'paper.tex', 'thesis.tex');
  eq(sib.map((s) => [s.from, s.to, s.checked]), [['paper.bib', 'thesis.bib', true], ['paper.log', 'thesis.log', false]], 'siblings: the .bib checked, the .log offered unchecked');
  eq(siblingRenames(files, 'paper.tex', 'style.sty', 'x.sty'), [], 'no siblings unless the main document is renamed');
  const taken = siblingRenames([...files, 'thesis.bib'], 'paper.tex', 'paper.tex', 'thesis.tex');
  check(taken.find((s) => s.from === 'paper.bib').disabled === true, 'a sibling whose new name is taken is disabled');

  const p = plan([{ from: 'paper.tex', to: 'thesis.tex' }, { from: 'paper.bib', to: 'thesis.bib' }]);
  eq(pick(p), [
    '.latexmkrc:1 latexmkrc paper.tex -> thesis.tex',
    'chapters/intro.tex:1 directive ../paper.tex -> ../thesis.tex',
    'paper.tex:4 code paper.bib -> thesis.bib',
    'paper.tex:9 code paper -> thesis',
  ], 'the bib references, the TeX root directive and latexmkrc follow; nothing else changes');
  const bib = p.edits.find((e) => e.line === 9);
  eq(bib.after, '\\bibliography{refs,thesis}', 'only the list entry changes');
  eq(bib.follows, 'paper.bib', 'a reference to the sibling follows the sibling');
  eq(p.unresolved, [], 'the macro path does not concern paper');
  const again = plan([{ from: 'paper.tex', to: 'thesis.tex' }, { from: 'paper.bib', to: 'thesis.bib' }]);
  eq(again.edits.map((e) => e.id), p.edits.map((e) => e.id), 'edit ids are stable');
}

// ---- an included file renamed: code reference edited, commented one marked, macro one unresolved
{
  const p = plan([{ from: 'chapters/intro.tex', to: 'chapters/introduction.tex' }]);
  eq(pick(p), [
    'paper.tex:6 code chapters/intro -> chapters/introduction',
    'paper.tex:8 comment chapters/intro -> chapters/introduction',
  ], 'the extension stays omitted; the comment is reported as a comment');
  eq(p.unresolved.map((u) => u.line), [10], 'the path built from a macro needs attention');
}

// ---- a folder renamed: \graphicspath follows, \includegraphics{a} still resolves
{
  const p = plan([{ from: 'figs', to: 'images', folder: true }]);
  eq(pick(p), ['paper.tex:3 code figs/ -> images/'], 'the graphicspath entry is the only edit');
}

// ---- an extension change that still resolves needs no edit
{
  const p = plan([{ from: 'figs/a.png', to: 'figs/a.jpg' }]);
  eq(p.edits, [], '\\includegraphics{a} finds a.jpg as well');
}

// ---- a local package renamed; a TeX Live one of the list is untouched
{
  const p = plan([{ from: 'style.sty', to: 'mystyle.sty' }]);
  eq(pick(p), ['paper.tex:2 code style -> mystyle'], '\\usepackage{amsmath,style} → amsmath,mystyle');
  eq(p.edits[0].after, '\\usepackage{amsmath,mystyle}', 'list entry only');
}

// ---- the main document moving folders re-relativises root-relative paths
{
  const p = plan([{ from: 'paper.tex', to: 'src/paper.tex' }]);
  const got = pick(p);
  check(got.includes('paper.tex:6 code chapters/intro -> ../chapters/intro'), `\\input follows the root's new folder (${got})`);
  check(got.includes('paper.tex:4 code paper.bib -> ../paper.bib'), 'the bib resource too');
  check(got.includes('paper.tex:3 code figs/ -> ../figs/'), 'and the graphicspath');
  check(got.includes('chapters/intro.tex:1 directive ../paper.tex -> ../src/paper.tex'), 'the TeX root directive names the new place');
}

// ---- an unbraced \input is never edited
{
  const p = planReferences([{ path: 'm.tex', text: '\\input intro\n\\input{intro}\n' }], ['m.tex', 'intro.tex'], 'm.tex', [{ from: 'intro.tex', to: 'opening.tex' }]);
  eq(pick(p), ['m.tex:2 code intro -> opening'], 'braced form edited');
  eq(p.unresolved.map((u) => u.text), ['\\input intro'], 'unbraced form needs attention');
}

// ---- verbatim blocks count as comments; \\input is a line break, not a command
{
  const text = '\\begin{verbatim}\n\\input{intro}\n\\end{verbatim}\n\\input{intro}\n';
  const p = planReferences([{ path: 'm.tex', text }], ['m.tex', 'intro.tex'], 'm.tex', [{ from: 'intro.tex', to: 'b.tex' }]);
  eq(p.edits.map((e) => e.kind), ['comment', 'code'], 'verbatim reference unchecked, real one checked');
}

// ---- the subfiles option names the main document relative to the subfile
{
  const p = planReferences([{ path: 'ch/a.tex', text: '\\documentclass[../main.tex]{subfiles}\n' }], ['main.tex', 'ch/a.tex'], 'main.tex', [{ from: 'main.tex', to: 'thesis.tex' }]);
  eq(pick(p), ['ch/a.tex:1 directive ../main.tex -> ../thesis.tex'], 'subfiles option follows');
}

// ---- \title carrying the old project name
{
  const src = [{ path: 'main.tex', text: '\\title{A \\& B}\n% \\title{A \\& B}\n\\hypersetup{pdftitle={A \\& B}}\n\\input{x}\n' }, { path: 'x.tex', text: '\\title{A \\& B}\n' }, { path: 'y.tex', text: '\\title{A \\& B}\n' }];
  const docs = documentSources(src, 'main.tex');
  eq(docs.map((d) => d.path), ['main.tex', 'x.tex'], 'the document is the root and what it inputs');
  const t = planTitle(docs, 'A & B', 'C_D');
  eq(t.map((e) => `${e.file}:${e.line} ${e.after}`), ['main.tex:1 \\title{C\\_D}', 'main.tex:3 \\hypersetup{pdftitle={C\\_D}}', 'x.tex:1 \\title{C\\_D}'], 'escaped title and pdftitle, not the comment');
  eq(planTitle(docs, 'Other', 'New'), [], 'a title that does not match is not offered');
}

console.log('file-refs: ok');
