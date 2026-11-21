/** A file the typeset wrote beside its PDF, served by the same output route. */
export interface OutputFile { name: string; url: string }

/** Only the path and query are read and written: the links stay relative,
 *  under whatever base path the app is served from. */
const parse = (url: string) => new URL(url, 'http://output.invalid');

/** The file an output-route link serves (`main.pdf`), null when it names none. */
export function outputFileName(url: string): string | null {
  const path = parse(url).searchParams.get('path');
  return path ? path.slice(path.lastIndexOf('/') + 1) || null : null;
}

/**
 * The link to the file with extension `ext` (`.bbl`, `.log`) that the typeset
 * of `pdfUrl` wrote beside it, through the same route. TeX names them after
 * the root file, as arXiv expects of a .bbl. The PDF's cache-busting `t`
 * names that PDF's run only, so it is dropped.
 */
export function outputSibling(pdfUrl: string, ext: string): OutputFile | null {
  const u = parse(pdfUrl);
  const path = u.searchParams.get('path');
  if (!path || !/\.pdf$/i.test(path)) return null;
  const sibling = path.replace(/\.pdf$/i, ext);
  u.searchParams.set('path', sibling);
  u.searchParams.delete('t');
  return { name: sibling.slice(sibling.lastIndexOf('/') + 1), url: u.pathname + u.search };
}

/** Windows refuses these as file names, with or without an extension. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Galley: V2 (WP34) the name a download gets, after the project: `My paper.pdf`,
 * `My paper (arXiv).zip`. Characters no file system takes become `-`, control
 * characters go, trailing dots and spaces go (Windows drops them), a Windows
 * device name gains a `_`, and an empty name is `document`. Files inside an
 * archive keep their TeX names (`main.bbl` must match `main.tex`); only the
 * download itself is named after the project.
 */
export function downloadName(projectName: string | null | undefined, ext: string): string {
  let stem = (projectName ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[. ]+$/, '');
  if (!stem.trim()) stem = 'document';
  if (DEVICE_NAME.test(stem)) stem = `${stem}_`;
  const suffix = ext.replace(/^\.+/, '');
  return suffix ? `${stem}.${suffix}` : stem;
}

/**
 * Galley: V2 (WP34) the folder the typeset of `pdfUrl` wrote into, as the
 * output route names it (`paper/.aldine-out`), or null when the link names no
 * file. The generated files are its direct children.
 */
export function outputDirOf(url: string): string | null {
  const path = parse(url).searchParams.get('path');
  if (!path) return null;
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}
