/**
 * Which project file a command names (WP20): `\input{sec/intro}` is
 * `sec/intro.tex` beside the main document, `\includegraphics{fig/a}` tries
 * the graphics extensions and `\graphicspath`, `\subfile` and `\subimport`
 * read beside the current file. Pure: the caller passes the file list.
 */

export interface ResolveEnv {
  /** The open file's project path. */
  currentFile: string;
  /** The main document, whose folder TeX runs in; null: the open file's. */
  rootFile: string | null;
  /** Every file of the project (paths, no folders). */
  files: readonly string[];
  /** `\graphicspath` folders, relative to the main document's folder. */
  graphicsPaths?: readonly string[];
}

const GRAPHICS = ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg'];

/** The extensions a command tries, in TeX's order. */
export function extensionsFor(command: string, name: string): readonly string[] {
  const hasExt = /\.[A-Za-z0-9]{1,5}$/.test(name.split('/').pop() ?? '');
  switch (command) {
    case 'includegraphics': return hasExt ? [''] : GRAPHICS;
    case 'includepdf': return hasExt ? [''] : ['.pdf', ''];
    case 'bibliography': return /\.bib$/i.test(name) ? [''] : ['.bib'];
    case 'include': case 'includeonly': case 'includefrom': case 'subincludefrom': return ['.tex'];
    case 'input': case 'subfile': case 'includestandalone': case 'import': case 'subimport': case 'inputfrom': case 'subinputfrom':
      return hasExt ? ['', '.tex'] : ['.tex', ''];
    case 'usepackage': case 'RequirePackage': return ['.sty'];
    case 'documentclass': case 'LoadClass': return ['.cls'];
    case 'bibliographystyle': return ['.bst'];
    default: return [''];
  }
}

/** Commands that read relative to the file they are in, not the main document. */
const BESIDE_CURRENT = new Set(['subfile', 'subimport', 'subinputfrom', 'subincludefrom']);

export const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');

/** `a/./b/../c` → `a/c`; null when it climbs out of the project. */
export function normalize(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

/** The project file `name` means for `command`, or null when there is none. */
export function resolveFile(name: string, command: string, env: ResolveEnv): string | null {
  const clean = name.trim().replace(/^"(.*)"$/, '$1');
  if (!clean || clean.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(clean)) return null;
  const all = new Set(env.files);
  const rootDir = dirOf(env.rootFile ?? env.currentFile);
  const curDir = dirOf(env.currentFile);
  const dirs = BESIDE_CURRENT.has(command) ? [curDir, rootDir] : [rootDir, curDir];
  if (command === 'includegraphics') for (const g of env.graphicsPaths ?? []) dirs.push(rootDir + g.replace(/\/?$/, '/'));
  dirs.push('');
  const exts = extensionsFor(command, clean);
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = normalize(dir + clean + ext);
      if (p == null || seen.has(p)) continue;
      seen.add(p);
      if (all.has(p)) return p;
    }
  }
  // Last chance: exactly one file anywhere in the project ends with the name.
  const lower = clean.replace(/^\.\//, '').toLowerCase();
  const matches = env.files.filter((f) => exts.some((ext) => {
    const want = lower + ext.toLowerCase();
    const fl = f.toLowerCase();
    return fl === want || fl.endsWith('/' + want);
  }));
  return matches.length === 1 ? matches[0] : null;
}

/** The folders `\graphicspath{{fig/}{img/}}` in a source names. */
export function graphicsPathsIn(text: string): string[] {
  const m = /\\graphicspath\s*\{((?:\s*\{[^{}]*\})+)\s*\}/.exec(text);
  if (!m) return [];
  return [...m[1].matchAll(/\{([^{}]*)\}/g)].map((x) => x[1].trim()).filter(Boolean);
}

/** A package's CTAN page. */
export function ctanUrl(name: string): string {
  return `https://ctan.org/pkg/${encodeURIComponent(name)}`;
}

/** The regular expression that finds a key wherever a command or a .bib entry lists it: `\ref{key}`,
 *  `\cite{a, key}`, `\label{key}`, `@article{key,`, `crossref = {key}`. */
export function referencePattern(key: string): string {
  return `[{,]\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,}]`;
}
