/**
 * F11 generated files (WP34): the pure half. What the server's
 * `GET /api/projects/:id/output/list` answers (WP30), how the list reads, and
 * which files may be viewed or added to the project. No React, no fetch.
 */
import { downloadName } from '../../util/outputFiles';

/** A file the last typesets wrote into the output folder (`.aldine-out`). */
export interface GeneratedFile {
  name: string;
  /** Bytes; null when the server did not say (the fallback probes). */
  size: number | null;
  /** Milliseconds since the epoch; null when unknown. */
  mtime: number | null;
  /** Written by the last typeset (true), left from an earlier one (false), or unknown (null). */
  fromLastRun: boolean | null;
  /** A file of the same name in the project folder: identical, different, or none. */
  tracked: 'same' | 'differs' | null;
  /** The server's word on whether Add to project takes it; null when it did not say (KEEPABLE decides). */
  keepable?: boolean | null;
}

export interface GeneratedList {
  /** The output folder as the output route names it (`paper/.aldine-out`); null when unknown. */
  dir: string | null;
  files: GeneratedFile[];
  /** The server has no list route yet: these are the files a probe found, and Add is not offered. */
  partial: boolean;
}

/** What a typeset builds that the project may keep: arXiv wants the .bbl, journals sometimes the index or glossary
 *  (WP30's KEEPABLE_EXTS, used when the server's entry does not say). */
export const KEEPABLE = /\.(bbl|ind|gls|acr|sls|nls)$/i;
/** Plain-text files the list opens read-only. */
export const VIEWABLE = /\.(log|blg|bbl|ilg|glg|alg|nlg|ind|gls|nls|acr|ist|out|toc|lof|lot)$/i;

/** A direct child of the output folder: no folders, no dotfiles (the run's own markers). */
const SAFE_NAME = /^[^/\\.][^/\\]*$/;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function time(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v; // seconds or milliseconds
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

function entry(raw: unknown): GeneratedFile | null {
  if (typeof raw === 'string') raw = { name: raw };
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name : null;
  if (!name || !SAFE_NAME.test(name) || name === 'fmt') return null;
  const tracked = o.tracked === 'same' || o.tracked === 'differs' ? o.tracked : null;
  return {
    name,
    size: num(o.size),
    mtime: time(o.mtime),
    fromLastRun: typeof o.fromLastRun === 'boolean' ? o.fromLastRun : null,
    tracked,
    keepable: typeof o.keepable === 'boolean' ? o.keepable : null,
  };
}

/**
 * The list route's answer: an array of entries, or an object holding one
 * (`files`, `entries` or `outputs`) and, optionally, the output folder
 * (`dir`, `outDir` or `outputDir`). Anything unexpected is dropped, never thrown on.
 */
export function parseOutputList(body: unknown): { dir: string | null; files: GeneratedFile[] } {
  let rows: unknown = body;
  let dir: string | null = null;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const o = body as Record<string, unknown>;
    rows = o.files ?? o.entries ?? o.outputs ?? [];
    const d = o.dir ?? o.outDir ?? o.outputDir;
    if (typeof d === 'string' && !/(^|\/)\.\.(\/|$)/.test(d)) dir = d.replace(/^\/+|\/+$/g, '');
  }
  const files: GeneratedFile[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const f = entry(r);
    if (f && !seen.has(f.name)) { seen.add(f.name); files.push(f); }
  }
  return { dir, files: sortGenerated(files) };
}

/** The PDF first, then what a submission needs, then the logs, then the rest. */
function rank(name: string): number {
  if (/\.pdf$/i.test(name)) return 0;
  if (/\.bbl$/i.test(name)) return 1;
  if (KEEPABLE.test(name)) return 2;
  if (/\.(log|blg)$/i.test(name)) return 3;
  return 4;
}

/** This typeset's files before an earlier one's; within each, by rank and then by name. */
export function sortGenerated(files: readonly GeneratedFile[]): GeneratedFile[] {
  const age = (f: GeneratedFile) => (f.fromLastRun === false ? 1 : 0);
  return [...files].sort((a, b) => age(a) - age(b) || rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** "812 B", "3.4 KB", "1.2 MB"; empty when unknown. */
export function formatSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The row's second line: size, and which typeset wrote it. */
export function describeFile(f: GeneratedFile): string {
  const when = f.fromLastRun === false ? 'earlier typeset' : f.fromLastRun ? 'this typeset' : '';
  return [formatSize(f.size), when].filter(Boolean).join(' · ');
}

/** What the project-copy control offers for a file: add it, update the copy, nothing to do, or nothing at all. */
export function keepState(f: GeneratedFile, list: Pick<GeneratedList, 'partial'>, canEdit: boolean): 'add' | 'update' | 'same' | null {
  if (!(f.keepable ?? KEEPABLE.test(f.name)) || list.partial) return null;
  if (f.tracked === 'same') return 'same';
  if (!canEdit) return null;
  return f.tracked === 'differs' ? 'update' : 'add';
}

/**
 * The name a download of `f` gets. The PDF is named after the project, as
 * every PDF download is; the other files keep the names TeX gave them,
 * because arXiv needs `main.bbl` to match `main.tex`.
 */
export function downloadNameFor(f: Pick<GeneratedFile, 'name'>, projectName: string | null | undefined): string {
  return /\.pdf$/i.test(f.name) ? downloadName(projectName, 'pdf') : f.name;
}

/** The output folder when the server does not say: beside the PDF on screen, else beside the main document. */
export function fallbackOutputDir(pdfDir: string | null, rootFile: string | null | undefined): string {
  if (pdfDir != null) return pdfDir;
  const root = rootFile ?? '';
  const slash = root.lastIndexOf('/');
  return slash < 0 ? '.aldine-out' : `${root.slice(0, slash)}/.aldine-out`;
}

/** The output route's link to `name` in `dir` (root-relative, before the base path). */
export function outputHref(projectId: string, branch: string, dir: string, name: string): string {
  const path = dir ? `${dir}/${name}` : name;
  return `/api/projects/${encodeURIComponent(projectId)}/output?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}`;
}

/** The arXiv export's warnings, from its `X-Laytekz-Warnings` header: a JSON array (URI-encoded or not), or lines. */
export function parseWarnings(header: string | null): string[] {
  if (!header) return [];
  let text = header;
  try { text = decodeURIComponent(header); } catch { /* not encoded */ }
  try {
    const v = JSON.parse(text) as unknown;
    if (Array.isArray(v)) return v.filter((w): w is string => typeof w === 'string' && w.trim() !== '').map((w) => w.trim());
    if (typeof v === 'string') text = v;
  } catch { /* plain lines */ }
  return text.split(/\r?\n/).map((w) => w.trim()).filter(Boolean);
}

