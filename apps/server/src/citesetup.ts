/**
 * Laytekz V2 (WP15): which citation and cross-reference commands a document
 * uses, read from its preamble, for the citation picker (F17), the
 * cross-reference picker and `insertCitation`. Pure: files come through
 * `read`, so the tests need no store.
 *
 * The preamble is the root file up to \begin{document} plus every file it
 * \input's or \include's there, and the project's own .sty and .cls files it
 * loads. Comments are blanked first (labels.maskTex). The apa7 class's own
 * options choose the citation package: `biblatex` loads biblatex with
 * style=apa, `natbib` loads apacite with natbibapa (natbib commands),
 * `apacite` loads apacite; with none of them apa7 loads nothing.
 */
import { maskTex } from './labels.js';

export type CiteFamily = 'biblatex' | 'natbib' | 'apacite' | 'bibtex';

export interface CiteSetup {
  rootFile: string;
  documentClass: string | null;
  classOptions: string[];
  /** The family whose commands the pickers write. `bibtex` is plain \cite. */
  family: CiteFamily;
  /** What decided `family`: `apa7[biblatex]`, `biblatex`, `apacite[natbibapa]`,
   *  `natbib`, `apacite`, `class elsarticle`, or `none`. */
  familySource: string;
  /** biblatex's citestyle= (else style=, else numeric), lower case; null without biblatex. */
  biblatexStyle: string | null;
  /** natbib's \citep and \citet work: natbib itself, biblatex's natbib option,
   *  or apacite's natbibapa. */
  natbibCommands: boolean;
  /** APA rules apply: the apa7 class, a biblatex apa style, or apacite. */
  apa: boolean;
  /** For the picker header: "biblatex · APA", "natbib · APA", "apacite · APA", "natbib", "BibTeX". */
  label: string;
  /** Packages the preamble loads (\usepackage and \RequirePackage), in order. */
  packages: string[];
  cleveref: boolean;
  /** cleveref's capitalise (or capitalize) option. */
  cleverefCapitalise: boolean;
  hyperref: boolean;
  /** amsmath, mathtools or empheq, or an AMS class: \eqref exists. */
  amsmath: boolean;
  varioref: boolean;
  /** nameref, or hyperref (which loads it): \nameref exists. */
  nameref: boolean;
  /** The .bib files the document loads (project paths), filled by indexes.citeSetup. */
  bibFiles: string[];
  /** The files read for this answer, root first. */
  files: string[];
}

/** Classes that load natbib themselves (a function of the class options). */
const CLASS_NATBIB: Record<string, (opts: string[]) => boolean> = {
  elsarticle: () => true,
  mnras: (o) => o.includes('usenatbib'),
};
const CLASS_NATBIB_PREFIX = ['aastex', 'revtex4'];
const AMS_CLASSES = new Set(['amsart', 'amsbook', 'amsproc']);

/** Comma-separated options, split outside braces, trimmed, empty ones dropped. */
export function splitOptions(s: string | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const c of s) {
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((o) => o.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** The value of `key=value` among `opts` (braces dropped), `''` for a bare
 *  `key`, undefined when absent. The last one wins, as in keyval. */
function optValue(opts: string[], key: string): string | undefined {
  let v: string | undefined;
  for (const o of opts) {
    const i = o.indexOf('=');
    const k = (i === -1 ? o : o.slice(0, i)).trim();
    if (k === key) v = i === -1 ? '' : o.slice(i + 1).trim().replace(/^\{([\s\S]*)\}$/, '$1').trim();
  }
  return v;
}

const truthy = (v: string | undefined) => v !== undefined && v.toLowerCase() !== 'false';

export function citeSetupOf(read: (path: string) => string | null, rootFile: string): CiteSetup {
  const rootDir = rootFile.includes('/') ? rootFile.slice(0, rootFile.lastIndexOf('/') + 1) : '';
  const resolve = (name: string, ext: string) => {
    const n = name.trim();
    if (!n || n.includes('\\') || n.includes('#')) return null;
    const p = (rootDir + (/\.[a-z0-9]+$/i.test(n) ? n : `${n}${ext}`)).replace(/^\.\//, '');
    return p.startsWith('../') || p.startsWith('/') ? null : p;
  };

  let documentClass: string | null = null;
  let classOptions: string[] = [];
  const packages: string[] = [];
  const pkgOptions = new Map<string, string[]>();
  const files: string[] = [];
  const queue = [rootFile];
  const seen = new Set(queue);
  const enqueue = (p: string | null) => { if (p && !seen.has(p) && seen.size < 200) { seen.add(p); queue.push(p); } };

  const TOKEN = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}|\\(?:usepackage|RequirePackage|RequirePackageWithOptions)\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}|\\PassOptionsToPackage\s*\{([^{}]*)\}\s*\{([^{}]*)\}|\\(?:input|include)\s*\{([^{}]*)\}|\\begin\s*\{document\}/g;
  while (queue.length) {
    const file = queue.shift()!;
    const text = read(file);
    if (text == null) continue;
    files.push(file);
    for (const m of maskTex(text).matchAll(TOKEN)) {
      if (m[0].startsWith('\\begin')) break; // nothing after \begin{document} can load a package
      if (m[2] !== undefined) {
        if (documentClass === null) {
          documentClass = m[2].trim();
          classOptions = splitOptions(m[1]);
          enqueue(resolve(documentClass, '.cls'));
        }
      } else if (m[4] !== undefined) {
        const opts = splitOptions(m[3]);
        for (const raw of m[4].split(',')) {
          const name = raw.trim();
          if (!name) continue;
          if (!packages.includes(name)) packages.push(name);
          pkgOptions.set(name, [...(pkgOptions.get(name) ?? []), ...opts]);
          enqueue(resolve(name, '.sty'));
        }
      } else if (m[6] !== undefined) {
        for (const raw of m[6].split(',')) {
          const name = raw.trim();
          if (name) pkgOptions.set(name, [...(pkgOptions.get(name) ?? []), ...splitOptions(m[5])]);
        }
      } else if (m[7] !== undefined) {
        enqueue(resolve(m[7], '.tex'));
      }
    }
  }

  const has = (p: string) => packages.includes(p);
  const opts = (p: string) => pkgOptions.get(p) ?? [];
  const cls = documentClass ?? '';

  let family: CiteFamily = 'bibtex';
  let familySource = 'none';
  let biblatexStyle: string | null = null;
  let apa = cls === 'apa7';
  let natbibCommands = false;

  const apa7Option = cls === 'apa7' ? (['biblatex', 'natbib', 'apacite'] as const).find((o) => classOptions.includes(o)) : undefined;
  if (apa7Option === 'biblatex' || (!apa7Option && has('biblatex'))) {
    family = 'biblatex';
    familySource = apa7Option ? 'apa7[biblatex]' : 'biblatex';
    const o = opts('biblatex');
    biblatexStyle = (optValue(o, 'citestyle') || optValue(o, 'style') || (apa7Option ? 'apa' : 'numeric')).toLowerCase();
    natbibCommands = truthy(optValue(o, 'natbib'));
  } else if (apa7Option === 'natbib') {
    family = 'natbib';
    familySource = 'apa7[natbib]';
    natbibCommands = true;
  } else if (apa7Option === 'apacite') {
    family = 'apacite';
    familySource = 'apa7[apacite]';
  } else if (has('apacite')) {
    const natbibapa = opts('apacite').includes('natbibapa');
    family = natbibapa ? 'natbib' : 'apacite';
    familySource = natbibapa ? 'apacite[natbibapa]' : 'apacite';
    natbibCommands = natbibapa;
  } else if (has('natbib')) {
    family = 'natbib';
    familySource = 'natbib';
    natbibCommands = true;
  } else if (CLASS_NATBIB[cls]?.(classOptions) || CLASS_NATBIB_PREFIX.some((p) => cls.startsWith(p))) {
    family = 'natbib';
    familySource = `class ${cls}`;
    natbibCommands = true;
  }
  if (family === 'apacite' || familySource.startsWith('apacite') || apa7Option === 'natbib') apa = true;
  if (biblatexStyle?.startsWith('apa')) apa = true;

  const label = family === 'biblatex'
    ? `biblatex · ${biblatexStyle!.startsWith('apa') ? 'APA' : biblatexStyle}`
    : family === 'natbib' ? (apa ? 'natbib · APA' : 'natbib')
      : family === 'apacite' ? 'apacite · APA' : 'BibTeX';

  const hyperref = has('hyperref');
  const cleverefOpts = opts('cleveref');
  return {
    rootFile,
    documentClass,
    classOptions,
    family,
    familySource,
    biblatexStyle,
    natbibCommands,
    apa,
    label,
    packages,
    cleveref: has('cleveref'),
    cleverefCapitalise: cleverefOpts.includes('capitalise') || cleverefOpts.includes('capitalize'),
    hyperref,
    amsmath: has('amsmath') || has('mathtools') || has('empheq') || AMS_CLASSES.has(cls),
    varioref: has('varioref'),
    nameref: has('nameref') || hyperref,
    bibFiles: [],
    files,
  };
}
