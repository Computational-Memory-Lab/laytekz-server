/**
 * Galley: V2 build outputs (WP30). The arXiv-ready ZIP: the branch's tracked
 * tree plus what the last typeset generated that arXiv cannot make itself
 * (the .bbl named after the main document, index and glossary files), minus
 * hidden files (arXiv deletes them), re-rooted at the main document's folder
 * when everything it uses lies inside it, with a 00README.json only when
 * arXiv would otherwise guess wrong. Built as a git tree through a throwaway
 * index, so `git archive` writes the ZIP exactly as the source download does
 * and the branch's own index, refs and working tree stay untouched.
 *
 * Its own execFile: gitops.ts belongs to another package in this wave.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { branchDir, repoDir } from './store.js';

/** The biblatex .bbl format versions arXiv's TeX Live reads (TeX Live 2025:
 *  biblatex 3.21, format 3.3). A .bbl in any other format makes arXiv's run
 *  fail, so it is left out and arXiv runs Biber from the .bib instead. Change
 *  only together with test/arxiv-archive.test.mjs. */
export const ACCEPTED_BBL_FORMATS: readonly string[] = ['3.3'];

/** Generated files a typeset leaves that TeX reads back and arXiv does not
 *  rebuild: the bibliography, the index, the glossaries, the nomenclature. */
export const KEEPABLE_EXTS: readonly string[] = ['bbl', 'ind', 'gls', 'acr', 'sls', 'nls'];

/** "% $ biblatex bbl format version 3.3 $" → "3.3"; null for a BibTeX .bbl. */
export function bblFormatVersion(text: string): string | null {
  const m = /^%\s*\$\s*biblatex bbl format version\s+([0-9][0-9.]*)\s*\$/m.exec(text.slice(0, 4096));
  return m ? m[1] : null;
}

/** Where a root's generated files live: "paper/main.tex" → { rootDir: "paper", base: "main", outDir: "paper/.aldine-out" }. */
export function outputLayout(rootFile: string): { rootDir: string; base: string; outDir: string } {
  const dir = path.posix.dirname(rootFile || 'main.tex');
  const rootDir = dir === '.' ? '' : dir;
  const base = path.posix.basename(rootFile || 'main.tex').replace(/\.tex$/i, '');
  return { rootDir, base, outDir: path.posix.join(rootDir, '.aldine-out') };
}

/** The .bib files the last run named: \bibdata in the .aux (BibTeX), file datasources in the .bcf (Biber). */
export function bibNames(aux: string, bcf: string | null): string[] {
  const out: string[] = [];
  const add = (n: string) => { const v = n.trim(); if (v && !out.includes(v)) out.push(v); };
  for (const m of aux.matchAll(/^\\bibdata\{([^}\n]*)\}/gm)) {
    for (const p of m[1].split(',')) if (p.trim()) add(/\.bib$/i.test(p.trim()) ? p : `${p.trim()}.bib`);
  }
  for (const m of (bcf ?? '').matchAll(/<bcf:datasource\b([^>]*)>([^<]*)<\/bcf:datasource>/g)) {
    if (/\btype="file"/.test(m[1]) && !(/\bglob="true"/.test(m[1]) && /[*?[\]{}]/.test(m[2]))) add(m[2].replace(/&amp;/g, '&'));
  }
  return out;
}

/** Refused with 409: the generated files on disk do not describe the source. */
export class TypesetFirstError extends Error {}

export interface ArxivResult {
  /** The tree to archive (a tree id, or "<tree>:<folder>" resolved to one). */
  tree: string;
  /** Paths in the archive, sorted. */
  files: string[];
  /** Plain sentences; the client shows them before "Download anyway". */
  warnings: string[];
  /** The archive is the main document's folder, not the whole project. */
  rerooted: string | null;
}

function git(dir: string, args: string[], opts: { input?: string | Buffer; env?: Record<string, string> } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.symlinks=false', ...args], { cwd: dir, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input ?? '');
  });
}

const mtime = (abs: string): number | null => { try { return fs.statSync(abs).mtimeMs; } catch { return null; } };
const readText = (abs: string): string | null => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } };
const inside = (root: string, abs: string) => abs === root || abs.startsWith(root + path.sep);
const hidden = (p: string) => p.split('/').some((s) => s.startsWith('.'));
const odd = (p: string) => /[^\x21-\x7e]/.test(p);
const listOf = (xs: string[]) => (xs.length > 3 ? `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more` : xs.join(', '));
/** A path argument that leaves the folder it is written in. */
const LEAVES_FOLDER = /\\(?:input|include|includeonly|subfile|includegraphics|includesvg|includepdf|addbibresource|bibliography|lstinputlisting|verbatiminput|import|subimport|graphicspath)\*?\s*(?:\[[^\]]*\]\s*)?\{\s*\{?\s*(?:\.\/)?\.\.\//;

/**
 * Plan and build the arXiv tree for `branch` from `tree` (the branch's
 * committed tree, or its working tree for a project with manual commits).
 * The caller has flushed open documents. Throws TypesetFirstError when the
 * last typeset is missing, was a draft, or is older than a .bib it loads.
 */
export async function arxivTree(projectId: string, branch: string, tree: string, opts: { rootFile: string; engine?: string }): Promise<ArxivResult> {
  const dir = branchDir(projectId, branch);
  const { rootDir, base, outDir } = outputLayout(opts.rootFile);
  const outAbs = path.join(dir, outDir);
  const rootAbs = path.join(dir, rootDir);
  const sentinel = mtime(path.join(outAbs, '.aldine-run'));
  if (sentinel === null || mtime(path.join(outAbs, `${base}.pdf`)) === null) throw new TypesetFirstError('Typeset first: the arXiv ZIP includes files the typeset makes.');
  if (fs.existsSync(path.join(outAbs, '.aldine-draft'))) throw new TypesetFirstError('Typeset first: the last typeset was a quick one without the bibliography.');
  const aux = readText(path.join(outAbs, `${base}.aux`)) ?? '';
  const bcf = readText(path.join(outAbs, `${base}.bcf`));
  const bibs = bibNames(aux, bcf);
  for (const b of bibs) {
    const abs = path.resolve(rootAbs, b);
    if (!inside(dir, abs)) continue;
    const t = mtime(abs);
    if (t !== null && t > sentinel) throw new TypesetFirstError(`Typeset first: ${b} changed since the last typeset.`);
  }

  const tracked = new Map<string, { mode: string; blob: string }>();
  for (const rec of (await git(dir, ['ls-tree', '-r', '-z', '--full-tree', tree])).split('\0')) {
    const m = /^(\d{6}) blob ([0-9a-f]{40,64})\t(.*)$/s.exec(rec);
    if (m) tracked.set(m[3], { mode: m[1], blob: m[2] });
  }
  const warnings: string[] = [];
  const remove = new Set([...tracked.keys()].filter(hidden));
  const add = new Map<string, Buffer>();
  const at = (name: string) => (rootDir ? `${rootDir}/${name}` : name);

  // Generated files go next to the main document, named after it, which is
  // where TeX looks once the output folder is gone. A tracked copy the user
  // added stays unless the typeset's own is newer.
  for (const ext of KEEPABLE_EXTS) {
    const name = `${base}.${ext}`;
    const gen = path.join(outAbs, name);
    const genTime = mtime(gen);
    if (genTime === null) continue;
    const ownTime = tracked.has(at(name)) ? mtime(path.join(rootAbs, name)) : null;
    if (ownTime !== null && ownTime >= genTime) continue;
    add.set(at(name), fs.readFileSync(gen));
  }
  const bblPath = at(`${base}.bbl`);
  const bblBytes = add.get(bblPath) ?? (tracked.has(bblPath) ? fs.readFileSync(path.join(rootAbs, `${base}.bbl`)) : null);
  if (bblBytes) {
    const v = bblFormatVersion(bblBytes.toString('utf8'));
    if (v !== null && !ACCEPTED_BBL_FORMATS.includes(v)) {
      add.delete(bblPath);
      remove.add(bblPath);
      warnings.push(`${base}.bbl was left out: it is in biblatex format ${v}, and arXiv reads only format ${ACCEPTED_BBL_FORMATS.join(' or ')}. arXiv runs Biber on your .bib files instead.`);
    }
  } else if (bibs.length) {
    warnings.push(bcf !== null
      ? `No ${base}.bbl was made, so arXiv will run Biber on your .bib files itself.`
      : `No ${base}.bbl was made, and arXiv does not run BibTeX, so the bibliography will be empty there. Check the bibliography's errors and typeset again.`);
  }

  // Re-root at the main document's folder when nothing it holds reaches out of it.
  let rerooted: string | null = null;
  if (rootDir) {
    const under = [...tracked.keys()].filter((p) => p.startsWith(`${rootDir}/`) && /\.(tex|ltx|sty|cls)$/i.test(p));
    const leaves = under.filter((p) => LEAVES_FOLDER.test((readText(path.join(dir, p)) ?? '').replace(/(^|[^\\])%.*$/gm, '$1')));
    if (leaves.length) warnings.push(`The main document is in the folder ${rootDir} and ${listOf(leaves)} use${leaves.length === 1 ? 's' : ''} files outside it, but arXiv typesets from the top of the ZIP. Move the main document to the top of the project, or keep everything it uses inside ${rootDir}.`);
    else rerooted = rootDir;
  }
  const final = new Set<string>([...tracked.keys(), ...add.keys()].filter((p) => !remove.has(p)));
  const archived = [...final].filter((p) => !rerooted || p.startsWith(`${rerooted}/`)).map((p) => (rerooted ? p.slice(rerooted.length + 1) : p));
  const topRoot = rerooted ? path.posix.basename(opts.rootFile) : opts.rootFile;

  // 00README.json only where arXiv would guess wrong: XeLaTeX, or more than one top-level document.
  const engine = opts.engine === 'xelatex' ? 'xelatex' : opts.engine === 'lualatex' ? 'lualatex' : 'pdflatex';
  if (engine === 'lualatex') warnings.push('arXiv does not offer LuaLaTeX, so it will typeset this project with pdfLaTeX. Switch the compiler to pdfLaTeX or XeLaTeX and typeset to check.');
  const topLevel = archived.filter((p) => !p.includes('/') && /\.tex$/i.test(p) && /^[^%\n]*\\documentclass/m.test(readText(path.join(dir, rerooted ? `${rerooted}/${p}` : p)) ?? ''));
  if ((engine === 'xelatex' || topLevel.length > 1) && !archived.includes('00README.json') && !archived.includes('00README.XXX')) {
    const readme = JSON.stringify({ process: { compiler: engine === 'xelatex' ? 'xelatex' : 'pdflatex' }, sources: [{ filename: topRoot, usage: 'toplevel' }] }, null, 2) + '\n';
    add.set(rerooted ? `${rerooted}/00README.json` : '00README.json', Buffer.from(readme));
    archived.push('00README.json');
  }
  const renamed = archived.filter(odd);
  if (renamed.length) warnings.push(`arXiv may rename files whose names have spaces or characters outside ASCII: ${listOf(renamed.sort())}.`);

  // The tree: a throwaway index from `tree`, minus the removals, plus the additions.
  const index = path.join(os.tmpdir(), `laytekz-arxiv-${crypto.randomBytes(8).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(dir, ['read-tree', tree], { env });
    const recs: string[] = [];
    for (const p of remove) recs.push(`0 ${'0'.repeat(40)}\t${p}`);
    for (const [p, bytes] of add) {
      const blob = (await git(dir, ['hash-object', '-w', '--stdin'], { input: bytes })).trim();
      recs.push(`100644 ${blob}\t${p}`);
    }
    if (recs.length) await git(dir, ['update-index', '-z', '--index-info'], { env, input: recs.map((r) => `${r}\0`).join('') });
    let out = (await git(dir, ['write-tree'], { env })).trim();
    if (rerooted) out = (await git(dir, ['rev-parse', `${out}:${rerooted}`])).trim();
    return { tree: out, files: archived.sort(), warnings, rerooted };
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** The tree id of a branch's last commit. */
export async function committedTree(projectId: string, branch: string): Promise<string> {
  return (await git(repoDir(projectId), ['rev-parse', '--verify', `refs/heads/${branch}^{tree}`])).trim();
}
