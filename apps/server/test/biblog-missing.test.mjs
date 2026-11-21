/**
 * Galley: V2 build outputs (WP30). A .bib the document names but the project
 * lacks: latexmk skips BibTeX/Biber and keeps the previous .bbl, so the PDF
 * shows an earlier typeset's bibliography without a word. The compiler's
 * bib-missing.js reads \bibdata (.aux) and the Biber datasources (.bcf) and
 * adds a warning row; and the plain-run wiring through the compiler script.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { check, eq } from './assert.mjs';

const require = createRequire(import.meta.url);
const { bibNames, missingBibFiles, warnings } = require('../../compiler/bib-missing.js');

// ---- names ----
eq(bibNames('\\bibdata{refs,more.bib, ../shared/x}\n', null), ['refs.bib', 'more.bib', '../shared/x.bib'], 'BibTeX names get .bib when written without it');
eq(bibNames('\\relax\n\\bibdata{refs}\n\\bibdata{refs}\n', null), ['refs.bib'], 'no repeats');
const bcf = `<bcf:bibdata section="0">
  <bcf:datasource type="file" datatype="bibtex" glob="false">references.bib</bcf:datasource>
  <bcf:datasource type="file" datatype="bibtex" glob="false">a&amp;b.bib</bcf:datasource>
  <bcf:datasource type="url" datatype="bibtex">https://example.org/x.bib</bcf:datasource>
  <bcf:datasource type="file" datatype="bibtex" glob="true">chapters/*.bib</bcf:datasource>
</bcf:bibdata>`;
eq(bibNames('', bcf), ['references.bib', 'a&b.bib'], 'Biber file datasources, unescaped; urls and globs left out');
eq(bibNames('\\bibdata{refs}', bcf), ['refs.bib', 'references.bib', 'a&b.bib'], 'both, in order');
eq(bibNames(undefined, undefined), [], 'nothing read');

const have = new Set(['refs.bib']);
eq(missingBibFiles('\\bibdata{refs,gone}', null, (n) => have.has(n)), ['gone.bib'], 'the missing one');
eq(missingBibFiles('\\bibdata{../outside}', null, () => null), [], 'a name outside the project is never judged');

// ---- warning rows, on disk ----
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-biblog-')));
const project = path.join(tmp, 'p');
const out = path.join(project, '.aldine-out');
fs.mkdirSync(out, { recursive: true });
const sentinel = path.join(out, '.aldine-run');
const at = (f, content, ageMs = 0) => {
  fs.writeFileSync(f, content);
  if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(f, t, t); }
};
const reset = () => { for (const f of fs.readdirSync(out)) fs.rmSync(path.join(out, f), { force: true }); for (const f of ['refs.bib', 'main.bbl']) fs.rmSync(path.join(project, f), { force: true }); };
const run = (errors = []) => {
  at(sentinel, '');
  const freshSince = fs.statSync(sentinel).mtimeMs;
  return warnings({ outAbs: out, base: 'main', cwd: project, projectAbs: project, freshSince, errors });
};

// stale: .bib missing, last typeset's .bbl still there
reset();
at(path.join(out, 'main.aux'), '\\citation{knuth}\n\\bibdata{refs}\n');
at(path.join(out, 'main.bbl'), '\\begin{thebibliography}{1}\\end{thebibliography}\n', 60_000);
let rows = run();
eq(rows.length, 1, 'one row');
eq(rows[0].type, 'warning', 'a warning, not an error');
check(/refs\.bib is not in the project, so the bibliography was not rebuilt: it shows what an earlier typeset produced/.test(rows[0].message), rows[0].message);

// none at all
reset();
at(path.join(out, 'main.aux'), '\\citation{knuth}\n\\bibdata{refs,more}\n');
rows = run();
check(/refs\.bib and more\.bib are not in the project, so no bibliography was built/.test(rows[0]?.message), JSON.stringify(rows));

// the project's own main.bbl and no output copy: that .bbl is the bibliography (arXiv sources)
reset();
at(path.join(out, 'main.aux'), '\\citation{knuth}\n\\bibdata{refs}\n');
at(path.join(project, 'main.bbl'), 'own');
eq(run(), [], 'own .bbl used: no row');
// … but a stale output copy hides it
at(path.join(out, 'main.bbl'), 'old', 60_000);
check(/used instead of the project.s own main\.bbl/.test(run()[0]?.message), 'a stale copy hiding the project\'s .bbl is named');

// present .bib: no row; fresh .bbl: no row
reset();
at(path.join(out, 'main.aux'), '\\citation{knuth}\n\\bibdata{refs}\n');
at(path.join(project, 'refs.bib'), '@book{knuth, title={T}}');
at(path.join(out, 'main.bbl'), 'x', 60_000);
eq(run(), [], 'the .bib is there');

// biblatex: a fresh .bcf names the datasource
reset();
at(path.join(out, 'main.aux'), '\\abx@aux@cite{0}{knuth}\n');
at(path.join(out, 'main.bcf'), bcf.replace('a&amp;b.bib', 'refs.bib'));
check(/references\.bib and refs\.bib are not in the project/.test(run()[0]?.message), 'biblatex datasources missing');
// a .bcf older than the .aux by far is a leftover from before biblatex was dropped
fs.utimesSync(path.join(out, 'main.bcf'), new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
at(path.join(out, 'main.aux'), '\\relax\n');
eq(run(), [], 'a leftover .bcf is ignored');

// an error row that already names the file: not repeated
reset();
at(path.join(out, 'main.aux'), '\\citation{knuth}\n\\bibdata{refs}\n');
eq(run([{ type: 'error', line: null, message: 'BibTeX: I couldn\'t open database file refs.bib' }]), [], 'already reported');

// cites, wants a .bbl, none made, no tool error
reset();
at(path.join(out, 'main.aux'), '\\citation{knuth}\n\\bibdata{refs}\n');
at(path.join(project, 'refs.bib'), '@book{knuth, title={T}}');
check(/No bibliography was built/.test(run()[0]?.message), 'no .bbl at all');
eq(run([{ type: 'error', line: 3, message: 'BibTeX: something' }]), [], 'unless the tool already reported an error');
// thebibliography by hand: no \bibdata, nothing to say
reset();
at(path.join(out, 'main.aux'), '\\citation{knuth}\n\\bibcite{knuth}{1}\n');
eq(run(), [], 'a hand-written bibliography');
// no .aux: nothing
reset();
eq(run(), [], 'no .aux');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('biblog missing: ALL PASSED');
process.exit(0);
