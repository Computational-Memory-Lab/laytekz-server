'use strict';
/**
 * Galley: V2 build outputs (WP30). latexmk has no built-in rule for the
 * glossaries package (.glo → .gls, .acn → .acr, the symbols glossary
 * .slo → .sls) or for nomencl (.nlo → .nls); the rule normally comes from a
 * latexmkrc, which the compiler never reads (-norc, see mkArgs). This module
 * writes the rules as latexmk -e code instead: constant Perl written by the
 * server, never by a document, so the -norc reasoning still holds.
 *
 * The rules call makeindex directly, with Perl's list form of system (no
 * shell), never makeglossaries: makeglossaries hands values read from the
 * .aux to its own subprocesses. The only things read from the .aux here are
 * the style file's name (strict allowlist, no path, no leading "-" or ".") and
 * whether the glossary is ordered letter by letter (adds -l).
 *
 * xindy and bib2gls documents are not built; warnings() names the tool.
 */
const fs = require('fs');
const path = require('path');

// The Perl, one statement per line for readability; joined into one -e value.
// $_[0] is the base name with the output folder (".aldine-out/main"), relative
// to the root file's folder, which is latexmk's working directory (-cd).
// makeindex runs inside the output folder with bare names (latexmk's own
// pushd/popd, as its built-in makeindex rule does with $makeindex_fudge):
// under openout_any=p makeindex refuses to write ".aldine-out/main.gls".
// An xindy glossary gets an empty output file: a rule that leaves its target
// missing makes latexmk fail the whole typeset, and today such a document
// typesets with an empty glossary (warnings() says why).
const PERL = [
  'sub laytekz_aux { my ($b) = @_; my %a = (ist => "", letter => 0, numbers => 0);',
  '  if (open(my $fh, "<", "$b.aux")) { while (my $l = <$fh>) {',
  '    if ($l =~ /^\\\\\\@istfilename\\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\\}/) { $a{ist} = $1; }',
  '    if ($l =~ /^\\\\\\@glsorder\\{letter\\}/) { $a{letter} = 1; }',
  '    if ($l =~ /^\\\\\\@newglossary\\{numbers\\}/) { $a{numbers} = 1; } } close($fh); }',
  '  return %a; }',
  'sub laytekz_makeindex { my ($b, $in, $out, $lg, $style) = @_; my %a = laytekz_aux($b);',
  '  my ($dir, $n) = ($b =~ m{^(.*)/([^/]*)$}) ? ($1, $2) : (".", $b);',
  '  if (!defined $style && $a{ist} =~ /\\.xdy$/) {',
  '    pushd($dir); if (open(my $o, ">", "$n.$out")) { close($o); } popd(); return 0; }',
  '  if (!defined $style) {',
  '    $style = ($a{ist} =~ /\\.ist$/) ? $a{ist} : "$n.ist"; }',
  '  my @opt = $a{letter} ? ("-l") : ();',
  '  pushd($dir);',
  '  my $r = system("makeindex", "-q", @opt, "-s", $style, "-t", "$n.$lg", "-o", "$n.$out", "$n.$in");',
  '  popd(); return $r; }',
  'sub laytekz_glo { return laytekz_makeindex($_[0], "glo", "gls", "glg"); }',
  'sub laytekz_acn { return laytekz_makeindex($_[0], "acn", "acr", "alg"); }',
  'sub laytekz_slo { return laytekz_makeindex($_[0], "slo", "sls", "slg"); }',
  'sub laytekz_nlo { my %a = laytekz_aux($_[0]);',
  '  return $a{numbers} ? laytekz_makeindex($_[0], "nlo", "nls", "nlg") : laytekz_makeindex($_[0], "nlo", "nls", "nlg", "nomencl.ist"); }',
  'add_cus_dep("glo", "gls", 0, "laytekz_glo");',
  'add_cus_dep("acn", "acr", 0, "laytekz_acn");',
  'add_cus_dep("slo", "sls", 0, "laytekz_slo");',
  'add_cus_dep("nlo", "nls", 0, "laytekz_nlo");',
].join('\n');

/** The latexmk arguments that add the rules (full runs only; drafts skip every tool). */
function args() {
  return ['-e', PERL];
}

/** Which glossary tools the last run's .aux asks for. Pure, for tests. */
function auxTools(auxText) {
  const text = typeof auxText === 'string' ? auxText : '';
  const ist = /^\\@istfilename\{([^}\n]*)\}/m.exec(text);
  return {
    makeindex: !!ist && /\.ist$/.test(ist[1]),
    xindy: !!ist && /\.xdy$/.test(ist[1]),
    bib2gls: /^\\glsxtr@resource\{/m.test(text),
  };
}

const row = (message) => ({ type: 'warning', line: null, message });

/**
 * Warning rows for glossaries this run did not build: a tool Laytekz does not
 * run, or the project's switch turned off. `outAbs` is the root's output
 * folder, `base` the root's name without .tex.
 */
function warnings({ outAbs, base, buildAux = true }) {
  let aux = '';
  try { aux = fs.readFileSync(path.join(outAbs, `${base}.aux`), 'utf8'); } catch { return []; }
  const t = auxTools(aux);
  const out = [];
  if (t.xindy) out.push(row('The glossary uses xindy, which Laytekz does not run, so it is empty. Load glossaries without the xindy option to have it built with makeindex.'));
  if (t.bib2gls) out.push(row('The glossary uses bib2gls, which Laytekz does not run, so it is empty. Use \\makeglossaries without the record option to have it built.'));
  if (t.makeindex && !buildAux) out.push(row('The glossary was not built: building glossaries, acronyms and nomenclature is turned off in this project’s settings.'));
  return out;
}

module.exports = { args, auxTools, warnings, PERL };
