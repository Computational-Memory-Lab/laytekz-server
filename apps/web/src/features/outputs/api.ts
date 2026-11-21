/**
 * F11 generated files and the arXiv download (WP34): the requests and the
 * download flows. Other code (ShareModal) reaches this feature only here.
 *
 * Server routes (WP30, srv/features/outputs):
 *   GET  /api/projects/:id/output/list?branch   the output folder's files
 *   POST /api/projects/:id/output/keep          {branch, name}: copy into the project, one commit
 *   GET  /api/projects/:id/export/arxiv?branch  the ZIP; 409 "Typeset first"; warnings in X-Laytekz-Warnings
 */
import { apiRequest, ApiError } from '../../api';
import { withBase } from '../../basePath';
import { downloadName, outputDirOf, outputSibling } from '../../util/outputFiles';
import type { EditorPageCtx, Notify } from '../types';
import type { PluginConfirm } from '../../plugins/host';
import { fallbackOutputDir, parseOutputList, parseWarnings, sortGenerated, type GeneratedFile, type GeneratedList } from './generated';

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

/** What the probes look for when the server has no list route: what Share offered in V1, plus BibTeX's log. */
const PROBED = ['.bbl', '.log', '.blg'];

async function probe(pdfUrl: string): Promise<GeneratedFile[]> {
  const found = await Promise.all(PROBED.map(async (ext) => {
    const f = outputSibling(pdfUrl, ext);
    if (!f) return null;
    try {
      const r = await fetch(f.url.replace('/output?', '/output/exists?'));
      const b = r.ok ? ((await r.json()) as { exists?: boolean }) : null;
      return b?.exists ? f.name : null;
    } catch { return null; }
  }));
  return found.filter((n): n is string => !!n).map((name) => ({ name, size: null, mtime: null, fromLastRun: true, tracked: null }));
}

/**
 * The files the last typesets wrote. Falls back to probing beside the PDF
 * (V1's way) when the server answers the list route with 404, so the list
 * and Share keep working against a server without WP30.
 */
export async function loadGenerated(o: { projectId: string; branch: string; pdfUrl: string | null; rootFile?: string | null }): Promise<GeneratedList> {
  const pdfDir = o.pdfUrl ? outputDirOf(o.pdfUrl) : null;
  try {
    const body = await apiRequest<unknown>(`${projectPath(o.projectId)}/output/list?branch=${encodeURIComponent(o.branch)}`);
    const { dir, files } = parseOutputList(body);
    return { dir: dir ?? fallbackOutputDir(pdfDir, o.rootFile), files, partial: false };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
    const files = o.pdfUrl ? sortGenerated(await probe(o.pdfUrl)) : [];
    return { dir: fallbackOutputDir(pdfDir, o.rootFile), files, partial: true };
  }
}

/** WP30's answer to a keep: where the file went, and whether anything changed. */
export interface KeepResult { ok?: boolean; path?: string; unchanged?: boolean; created?: boolean; gitignore?: string | null; commit?: string | null }

/** Copies a generated file into the project folder and commits it (confirmed by the caller). */
export function keepGenerated(projectId: string, branch: string, name: string): Promise<KeepResult> {
  return apiRequest<KeepResult>(`${projectPath(projectId)}/output/keep`, { method: 'POST', body: JSON.stringify({ branch, name }) });
}

/** The arXiv ZIP, or why there is none. */
export type ArxivFetch =
  | { ok: true; blob: Blob; warnings: string[] }
  | { ok: false; status: number; message: string };

export async function fetchArxiv(projectId: string, branch: string): Promise<ArxivFetch> {
  let res: Response;
  try {
    res = await fetch(withBase(`${projectPath(projectId)}/export/arxiv?branch=${encodeURIComponent(branch)}`));
  } catch {
    return { ok: false, status: 0, message: 'Could not reach the server. Check your connection and try again.' };
  }
  if (!res.ok) {
    let message = '';
    try { const b = (await res.json()) as { error?: unknown; message?: unknown }; message = typeof b.error === 'string' ? b.error : typeof b.message === 'string' ? b.message : ''; } catch { /* not JSON */ }
    if (res.status === 409 && !message) message = 'Typeset first';
    if (res.status === 404 && (!message || /not found/i.test(message))) message = 'This server cannot build arXiv ZIPs yet.';
    return { ok: false, status: res.status, message: message || `HTTP ${res.status}` };
  }
  return { ok: true, blob: await res.blob(), warnings: parseWarnings(res.headers.get('x-laytekz-warnings')) };
}

/** Saves `href` (a link on this site, or a blob URL) under `name`, as a click on a download link would. */
export function saveLink(href: string, name: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  saveLink(url, name);
  // The download has its own copy once it starts; Safari needs the URL a moment longer.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** `<Project name> (arXiv).zip` */
export const arxivName = (projectName: string | null | undefined) => downloadName(`${(projectName ?? '').trim() || 'document'} (arXiv)`, 'zip');

// ---- The page the feature is active on, and whether its source changed since its last typeset ----

interface Active { page: EditorPageCtx; edits: number; requestedAt: number; cleanAt: number }
let active: Active | null = null;

/** Called from the feature's activate(): keeps count of edits against the typesets that saw them. */
export function trackPage(page: EditorPageCtx): () => void {
  const a: Active = { page, edits: 0, requestedAt: 0, cleanAt: 0 };
  active = a;
  const offs = [
    page.events.on('docChanged', () => { a.edits++; }),
    page.events.on('agentWrite', () => { a.edits++; }),
    page.events.on('compileRequested', () => { a.requestedAt = a.edits; }),
    page.events.on('compileFinished', ({ result, own }) => { if (own && result.ok && !result.draft) a.cleanAt = a.requestedAt; }),
  ];
  return () => { offs.forEach((off) => off()); if (active === a) active = null; };
}

/** The last typeset is a full, successful one that has seen every edit since. */
function typesetIsCurrent(a: Active): boolean {
  const r = a.page.lastCompile();
  return !!r && r.ok && !r.draft && !r.needsFullRun && a.edits <= a.cleanAt;
}

/** Starts a full typeset and resolves with the first result that comes after it was requested. */
function typesetAndWait(page: EditorPageCtx, timeoutMs = 240_000): Promise<{ ok: boolean } | null> {
  return new Promise((resolve) => {
    let requested = false;
    const offs: (() => void)[] = [];
    const done = (v: { ok: boolean } | null) => { offs.forEach((off) => off()); clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    offs.push(page.events.on('compileRequested', () => { requested = true; }));
    offs.push(page.events.on('compileFinished', ({ result }) => { if (requested && !result.draft) done({ ok: result.ok }); }));
    page.compile();
  });
}

let busy = false;

interface ArxivHost {
  projectId: string;
  branch: string;
  projectName: string | null | undefined;
  toast: Notify;
  confirm(o: PluginConfirm): Promise<boolean>;
  /** The editor page, when there is one: it typesets first if the PDF is behind the source. */
  page?: EditorPageCtx | null;
}

/**
 * "Download for arXiv": a full typeset first when the last one was a draft,
 * failed, or is behind the source; then the server's ZIP (the source with the
 * .bbl, without hidden files). Warnings ask before saving; a ZIP without them
 * saves at once, named after the project.
 */
export async function downloadForArxiv(host: ArxivHost): Promise<boolean> {
  if (busy) { host.toast('The arXiv ZIP is on its way.', 'info'); return false; }
  busy = true;
  try {
    const a = host.page && active?.page === host.page ? active : null;
    if (host.page && (!a || !typesetIsCurrent(a))) {
      host.toast('Typesetting first, so the ZIP has the current bibliography…', 'info');
      const r = await typesetAndWait(host.page);
      if (!r) { host.toast('The typeset is taking too long. Try the arXiv download again when it finishes.', 'error'); return false; }
      if (!r.ok) { host.toast('The typeset failed. Fix the errors, then download for arXiv again.', 'error'); return false; }
    }
    const got = await fetchArxiv(host.projectId, host.branch);
    if (!got.ok) {
      const retry = host.page && got.status === 409 ? { label: 'Typeset', run: () => host.page!.compile() } : undefined;
      const text = got.status !== 409 ? `Could not build the arXiv ZIP: ${got.message}`
        : /^typeset first\W*$/i.test(got.message) ? 'Typeset first: the arXiv ZIP needs a current typeset.' : got.message;
      host.toast(text, 'error', retry);
      return false;
    }
    if (got.warnings.length) {
      const ok = await host.confirm({
        title: 'Download for arXiv anyway?',
        body: `${got.warnings.join('\n')}\n\narXiv may not typeset this ZIP as it is.`,
        confirmLabel: 'Download anyway',
      });
      if (!ok) return false;
    }
    saveBlob(got.blob, arxivName(host.projectName));
    return true;
  } finally {
    busy = false;
  }
}

/** For ShareModal: the same flow, through the editor page when this project and branch are open in it. */
export function requestArxivDownload(host: Omit<ArxivHost, 'page'>): Promise<boolean> {
  const page = active && active.page.projectId === host.projectId && active.page.branch === host.branch ? active.page : null;
  return downloadForArxiv({ ...host, page });
}
