/**
 * The main document's name ends up on latexmk's command line, and latexmk
 * hands it to /bin/sh inside double quotes, where a backtick runs a command.
 * Both guards, the server's (settings route, typeset) and the compiler's,
 * must refuse anything latexmk or the shell could read as more than a name,
 * accept the ordinary shapes of real projects, and agree with each other.
 */
import { createRequire } from 'node:module';
import { check, eq } from './assert.mjs';

const { invalidRootFile: serverGuard, rootFileRenameMessage } = await import('../src/util.ts');
const { invalidRootFile: compilerGuard, rootFileProblem, parseLog } = createRequire(import.meta.url)('../../compiler/server.js');

const accepted = [
  'main.tex', 'paper/main.tex', 'MAIN.TEX', 'my-paper.tex', 'src/v2-final.tex', 'thesis.ltx',
  'my paper.tex', 'Thesis (final).tex', 'chapter_1.tex', 'v1.2.3.tex', 'notes+draft.tex',
  'résumé.tex', 'résumé.tex', 'Diplomarbeit Müller.tex', '论文.tex', 'статья/главная.tex',
  'α-β.tex', 'deep/er/still/main.tex', 'paper (2)/main (copy).tex',
];
const refused = [
  // options
  '-pdflatex=touch /tmp/x #.tex',
  '--version',
  'paper/-main.tex',
  '-',
  // escapes
  '../main.tex',
  'a/../../b.tex',
  '/etc/main.tex',
  '',
  '   ',
  // the shell, inside double quotes and out
  'a`touch x`.tex',
  'p1`cd .aldine-out;touch PWNED`.tex',
  'sub`id`dir/main.tex',
  'a$(touch x).tex',
  'a${HOME}.tex',
  'a"b.tex',
  "it's.tex",
  'a\\b.tex',
  'paper\\main.tex',
  'a;b.tex',
  'a|b.tex',
  'a&b.tex',
  '&pdflatex.tex',
  'a>b.tex',
  'a<b.tex',
  'a*.tex',
  'a?.tex',
  'a[1].tex',
  'a!b.tex',
  // TeX and latexmk specials
  'a%b.tex',
  'a~b.tex',
  'a#b.tex',
  'a^b.tex',
  'a{b}.tex',
  'a=b.tex',
  'a:b.tex',
  // control, format and odd whitespace characters
  'a\nb.tex',
  'a\rb.tex',
  'a\tb.tex',
  'a\u0000b.tex',
  'a\u007fb.tex',
  'a‮b.tex',
  'a​b.tex',
  'a b.tex',
  // shapes no stored root has
  'a//b.tex',
  'paper/',
  './main.tex',
  'a/./b.tex',
  // git internals and compiler output
  '.git/main.tex',
  '.GIT./main.tex',
  '.aldine-out/main.tex',
  'paper/.aldine-out/main.tex',
];

for (const p of accepted) {
  eq(serverGuard(p), null, `server accepts ${JSON.stringify(p)}`);
  eq(compilerGuard(p), false, `compiler accepts ${JSON.stringify(p)}`);
  eq(rootFileProblem(p), null, `compiler names no problem for ${JSON.stringify(p)}`);
}
for (const p of refused) {
  check(typeof serverGuard(p) === 'string', `server refuses ${JSON.stringify(p)}`);
  eq(compilerGuard(p), true, `compiler refuses ${JSON.stringify(p)}`);
  check(typeof rootFileProblem(p) === 'string' && rootFileProblem(p).length > 0, `compiler names why it refuses ${JSON.stringify(p)}`);
}
check(typeof serverGuard(undefined) === 'string', 'server refuses a missing value');
eq(compilerGuard(42), true, 'compiler refuses a non-string');
eq(compilerGuard('x'.repeat(256) + '.tex'), true, 'compiler refuses a name longer than a file system allows');
check(typeof serverGuard('x'.repeat(256) + '.tex') === 'string', 'server refuses a name longer than a file system allows');
check(typeof parseLog === 'function', 'the compiler module still exports its parsers');

// The refusal names the character, and the rename message says what to do.
check(serverGuard('a`b`.tex').includes('backtick'), `the refusal names the backtick (got ${serverGuard('a`b`.tex')})`);
check(serverGuard('a$b.tex').includes('“$”'), `the refusal names "$" (got ${serverGuard('a$b.tex')})`);
check(serverGuard('a\u0007.tex').includes('U+0007'), 'an invisible character is named by its code point');
const msg = rootFileRenameMessage('a`touch x`.tex', serverGuard('a`touch x`.tex'));
check(msg.startsWith('Can’t typeset “a`touch x`.tex”.') && /rename the file/.test(msg) && /typeset again\.$/.test(msg), `the typeset refusal says what to rename (got ${msg})`);
const spoof = rootFileRenameMessage('a‮x.tex', serverGuard('a‮x.tex'));
check(!spoof.includes('‮') && spoof.includes('�'), 'a direction override in the name does not reach the sentence');

console.log('rootfile-guard: ok');
