/**
 * Galley: V2 build outputs (WP30). Glossaries, acronyms, symbols and
 * nomenclature are built on full typesets through latexmk -e rules that call
 * makeindex directly (list-form system, never makeglossaries); drafts and
 * the project switch (buildAux: false) leave the rules out; xindy and bib2gls
 * documents and a switched-off glossary get a warning row.
 *
 * 1. the rule text and the .aux reader, pure;
 * 2. the real compiler script with a latexmk on PATH that records its argv;
 * 3. the real compiler with the real latexmk, when TeX Live has glossaries
 *    (the build machine's full scheme; CI's medium scheme skips it).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { check, eq } from './assert.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const rules = require('../../compiler/glossary-rules.js');
const compilerJs = path.resolve(here, '../../compiler/server.js');

// ---- 1. pure ----
const [flag, perl] = rules.args();
eq(flag, '-e', 'one -e option');
for (const [from, to] of [['glo', 'gls'], ['acn', 'acr'], ['slo', 'sls'], ['nlo', 'nls']]) {
  check(perl.includes(`add_cus_dep("${from}", "${to}", 0,`), `a ${from} → ${to} rule`);
}
check(perl.includes('system("makeindex", "-q", @opt, "-s", $style,'), 'makeindex in list form (no shell)');
check(!/makeglossaries|`|qx|exec\b|open\([^)]*\|/.test(perl), 'never makeglossaries, backticks, qx or a piped open');
check(perl.includes('"nomencl.ist"'), 'nomenclature uses nomencl.ist');
check(perl.includes('[A-Za-z0-9_][A-Za-z0-9_.-]*'), 'the style name read from the .aux is allowlisted (no path, no leading - or .)');
const perlOk = spawnSync('perl', ['-c', '-e', `sub add_cus_dep {} sub pushd {} sub popd {} ${perl}`], { encoding: 'utf8' });
check(perlOk.status === 0, `the rule text compiles as Perl: ${perlOk.stderr}`);

eq(rules.auxTools('\\@istfilename{main.ist}\n\\@glsorder{word}\n'), { makeindex: true, xindy: false, bib2gls: false }, 'makeindex glossary');
eq(rules.auxTools('\\@istfilename{main.xdy}\n'), { makeindex: false, xindy: true, bib2gls: false }, 'xindy glossary');
eq(rules.auxTools('\\glsxtr@resource{src={terms}}{main}\n'), { makeindex: false, xindy: false, bib2gls: true }, 'bib2gls');
eq(rules.auxTools('\\relax\n'), { makeindex: false, xindy: false, bib2gls: false }, 'no glossary');
eq(rules.auxTools(undefined), { makeindex: false, xindy: false, bib2gls: false }, 'no .aux');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-glossary-')));
const w = path.join(tmp, 'w');
fs.mkdirSync(w);
fs.writeFileSync(path.join(w, 'main.aux'), '\\@istfilename{main.xdy}\n');
check(/xindy/.test(rules.warnings({ outAbs: w, base: 'main' })[0]?.message), 'xindy is named');
fs.writeFileSync(path.join(w, 'main.aux'), '\\@istfilename{main.ist}\n');
eq(rules.warnings({ outAbs: w, base: 'main' }), [], 'a makeindex glossary with the switch on: no warning');
check(/turned off/.test(rules.warnings({ outAbs: w, base: 'main', buildAux: false })[0]?.message), 'switched off: says so');
eq(rules.warnings({ outAbs: w, base: 'none' }), [], 'no .aux: no warning');

// ---- 2. argv through the compiler, with a recording latexmk ----
const dataDir = path.join(tmp, 'data');
const bin = path.join(tmp, 'bin');
const argvLog = path.join(tmp, 'argv.jsonl');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'latexmk'), `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
fs.appendFileSync(process.env.LAYTEKZ_TEST_ARGV, JSON.stringify(process.argv.slice(2)) + '\\n');
const root = process.argv[process.argv.length - 1];
const out = path.join(path.dirname(root), '.aldine-out'); const base = path.basename(root, '.tex');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, base + '.pdf'), '%PDF-1.5');
fs.writeFileSync(path.join(out, base + '.log'), '\\\\openout1 = \\x60' + base + '.aux\\x27.\\nOutput written on x.pdf (1 page, 9 bytes).\\n');
fs.writeFileSync(path.join(out, base + '.aux'), fs.existsSync('aux.txt') ? fs.readFileSync('aux.txt', 'utf8') : '\\\\relax\\n');
`, { mode: 0o755 });
const doc = '\\documentclass{article}\\begin{document}x\\end{document}\n';
for (const [name, aux] of [['a', null], ['x', '\\@istfilename{main.xdy}\n']]) {
  const dir = path.join(dataDir, 'projects', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.tex'), doc);
  if (aux) fs.writeFileSync(path.join(dir, 'aux.txt'), aux);
}

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
async function startCompiler(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [compilerJs], { env: { ...process.env, PORT: String(port), ALDINE_PREAMBLE_CACHE: '0', ALDINE_THUMBNAILS: '0', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
    child.on('exit', (code) => reject(new Error(`compiler exited early: ${code}`)));
    setTimeout(() => reject(new Error('compiler did not start')), 20_000);
  });
  const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { child, post };
}
const lastArgv = () => JSON.parse(fs.readFileSync(argvLog, 'utf8').trim().split('\n').pop());
const hasRules = (argv) => argv.some((a) => a.includes('add_cus_dep("glo"'));

const shim = await startCompiler({ PATH: `${bin}${path.delimiter}${process.env.PATH}`, DATA_DIR: dataDir, LAYTEKZ_TEST_ARGV: argvLog });
try {
  const full = await shim.post({ projectDir: 'projects/a', rootFile: 'main.tex' });
  eq(full.status, 200, `a full typeset answers (${JSON.stringify(full.body)})`);
  const argv = lastArgv();
  check(hasRules(argv), 'a full typeset passes the glossary rules');
  eq(argv[argv.indexOf(perl) - 1], '-e', 'as the value of -e');
  check(argv.indexOf(perl) < argv.length - 1 && argv[argv.length - 1] === './main.tex', 'before the root file');
  eq(argv[0], '-norc', 'still no rc file');

  await shim.post({ projectDir: 'projects/a', rootFile: 'main.tex', draft: true });
  check(!hasRules(lastArgv()), 'a draft leaves them out');
  await shim.post({ projectDir: 'projects/a', rootFile: 'main.tex', buildAux: false });
  check(!hasRules(lastArgv()), 'buildAux: false leaves them out');
  await shim.post({ projectDir: 'projects/a', rootFile: 'main.tex', buildAux: 'no' });
  check(hasRules(lastArgv()), 'only a literal false turns them off');

  const x = await shim.post({ projectDir: 'projects/x', rootFile: 'main.tex' });
  check(x.body.errors.some((e) => e.type === 'warning' && /xindy/.test(e.message)), `an xindy glossary gets a warning row (${JSON.stringify(x.body.errors)})`);
  eq(x.body.ok, true, 'and the typeset still succeeds');
  const xd = await shim.post({ projectDir: 'projects/x', rootFile: 'main.tex', draft: true });
  check(!xd.body.errors.some((e) => /xindy/.test(e.message)), 'drafts add no warning rows');
} finally {
  shim.child.kill();
}

// ---- 3. the real latexmk, when TeX Live has glossaries and nomencl ----
const has = (f) => spawnSync('kpsewhich', [f], { encoding: 'utf8' }).stdout.trim() !== '';
const latexmkOk = spawnSync('latexmk', ['-v'], { encoding: 'utf8' }).status === 0;
if (!latexmkOk || !has('glossaries.sty') || !has('nomencl.sty')) {
  console.log('glossary rules: real TeX skipped (no latexmk, glossaries or nomencl)');
} else {
  const real = path.join(dataDir, 'projects', 'real');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'main.tex'), `\\documentclass{article}
\\usepackage[acronym]{glossaries}
\\usepackage{nomencl}
\\makeglossaries
\\makenomenclature
\\newglossaryentry{latex}{name=LaTeX,description={A document preparation system}}
\\newacronym{api}{API}{application programming interface}
\\begin{document}
\\gls{latex} and \\gls{api}. Speed $c$\\nomenclature{$c$}{Speed of light}.
\\printglossaries
\\printnomenclature
\\end{document}
`);
  const tex = await startCompiler({ DATA_DIR: dataDir });
  try {
    const off = await tex.post({ projectDir: 'projects/real', rootFile: 'main.tex', buildAux: false });
    eq(off.body.ok, true, `switched off, the document still typesets (${JSON.stringify(off.body.errors)})`);
    check(!fs.existsSync(path.join(real, '.aldine-out', 'main.gls')), 'switched off: no glossary built (today\'s behaviour)');
    check(off.body.errors.some((e) => /turned off/.test(e.message)), 'and a row says why');
    const on = await tex.post({ projectDir: 'projects/real', rootFile: 'main.tex', clean: true });
    eq(on.body.ok, true, `with the rules the document typesets (${JSON.stringify(on.body.errors)})`);
    for (const f of ['main.gls', 'main.acr', 'main.nls']) check(fs.statSync(path.join(real, '.aldine-out', f)).size > 0, `${f} was built`);
    check(/glossentry\{latex\}/.test(fs.readFileSync(path.join(real, '.aldine-out', 'main.gls'), 'utf8')), 'the glossary holds the entry');
    check(!on.body.errors.some((e) => e.type === 'warning' && /glossary|xindy|bib2gls/i.test(e.message)), 'no glossary warning');
    console.log('glossary rules: real TeX passed');
  } finally {
    tex.child.kill();
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('glossary rules: ALL PASSED');
process.exit(0);
