'use strict';
/**
 * Galley: V2 build outputs (WP30). Stale or missing bibliographies.
 *
 * latexmk's default ($bibtex_use = 1) runs BibTeX/Biber only when every .bib
 * the document names exists. When one is missing it skips the tool silently
 * and keeps the previous .bbl, so the PDF goes on showing a bibliography from
 * an earlier typeset and nobody is told. And because TeX reads the output
 * folder first (-output-directory), a stale .aldine-out/main.bbl also hides a
 * main.bbl the user put in the project (an arXiv source without its .bib).
 * This module reads which .bib files the last run asked for (\bibdata in the
 * .aux for BibTeX, <bcf:datasource> in the .bcf for Biber) and says so.
 */
const fs = require('fs');
const path = require('path');

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * The .bib files the document names, as written (".bib" added to a BibTeX
 * name without it), in order, without repeats: BibTeX's \bibdata{a,b} from
 * the .aux and Biber's file datasources from the .bcf. Remote (url) and
 * globbed datasources are left out: they are not project files.
 */
function bibNames(auxText, bcfText) {
  const out = [];
  const add = (n) => { const name = n.trim(); if (name && !out.includes(name)) out.push(name); };
  for (const m of String(auxText || '').matchAll(/^\\bibdata\{([^}\n]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (p) add(/\.bib$/i.test(p) ? p : `${p}.bib`);
    }
  }
  for (const m of String(bcfText || '').matchAll(/<bcf:datasource\b([^>]*)>([^<]*)<\/bcf:datasource>/g)) {
    const attrs = m[1];
    if (!/\btype="file"/.test(attrs)) continue;
    const name = unxml(m[2]);
    if (/\bglob="true"/.test(attrs) && /[*?[\]{}]/.test(name)) continue;
    add(name);
  }
  return out;
}

/**
 * The named .bib files that do not exist. `exists(name)` answers for a name
 * as written, relative to the root file's folder (where BibTeX and Biber
 * look, latexmk -cd), or returns null for a name it will not judge (outside
 * the project): those are never reported.
 */
function missingBibFiles(auxText, bcfText, exists) {
  return bibNames(auxText, bcfText).filter((n) => exists(n) === false);
}

const listOf = (names) => names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
const row = (message) => ({ type: 'warning', line: null, message });

/**
 * Warning rows after a full run. `outAbs`: the root's output folder; `base`:
 * the root's name without .tex; `cwd`: the root's folder; `projectAbs`: the
 * project folder; `freshSince`: the run's sentinel mtime; `errors`: the rows
 * the run already has (a .bib a BibTeX/Biber error already names is not
 * reported twice).
 */
function warnings({ outAbs, base, cwd, projectAbs, freshSince, errors = [] }) {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };
  const auxPath = path.join(outAbs, `${base}.aux`);
  const aux = read(auxPath);
  if (aux === null) return [];
  // A .bcf left over from before the document dropped biblatex is not this
  // document's: biblatex rewrites it on every pass that writes the .aux.
  const bcfPath = path.join(outAbs, `${base}.bcf`);
  const bcfTime = mtime(bcfPath);
  const bcf = bcfTime !== null && bcfTime >= (mtime(auxPath) ?? 0) - 5000 ? read(bcfPath) : null;
  const inside = (abs) => abs === projectAbs || abs.startsWith(projectAbs + path.sep);
  const exists = (name) => {
    const abs = path.resolve(cwd, name);
    if (path.isAbsolute(name) || !inside(abs)) return null;
    return fs.existsSync(abs);
  };
  const said = (n) => errors.some((e) => e && typeof e.message === 'string' && e.message.includes(n));
  const missing = missingBibFiles(aux, bcf, exists).filter((n) => !said(n));
  const bbl = path.join(outAbs, `${base}.bbl`);
  const bblTime = mtime(bbl);
  const bblFresh = bblTime !== null && bblTime >= freshSince;
  const ownBbl = fs.existsSync(path.join(cwd, `${base}.bbl`));
  if (missing.length) {
    const subject = `${listOf(missing)} ${missing.length === 1 ? 'is' : 'are'} not in the project`;
    if (bblFresh) return [];
    if (ownBbl && bblTime === null) return []; // the project's own .bbl is the bibliography
    if (ownBbl) return [row(`${subject}, so the bibliography was not rebuilt, and an earlier typeset’s ${base}.bbl is used instead of the project’s own ${base}.bbl. Typeset from scratch to use the project’s.`)];
    if (bblTime !== null) return [row(`${subject}, so the bibliography was not rebuilt: it shows what an earlier typeset produced.`)];
    return [row(`${subject}, so no bibliography was built.`)];
  }
  const cites = /^\\citation\{/m.test(aux) || /<bcf:citekey\b/.test(bcf || '');
  const wantsBbl = bibNames(aux, bcf).length > 0;
  const toolErrors = errors.some((e) => e && /^(BibTeX|Biber):/.test(String(e.message)));
  if (cites && wantsBbl && bblTime === null && !ownBbl && !toolErrors) return [row('No bibliography was built for this document’s citations. Typeset again; if it stays empty, check the .blg file among the generated files.')];
  return [];
}

module.exports = { bibNames, missingBibFiles, warnings };
