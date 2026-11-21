import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { FastifyReply } from 'fastify';
import type { ServerFeature } from '../types.js';
import type { ProjectMeta } from '../../db/types.js';
import * as store from '../../store.js';
import * as gitops from '../../gitops.js';
import { BRANCH_RE } from '../../util.js';
import { applySpansToDoc, bumpFilesSignal, flushBranchDocs, markPathsChanged, refreshBranchDocsFromDisk, signalCommitted } from '../../collab.js';
import { scheduleAutopush } from '../../autopush.js';
import { BUILD_AUX_SETTING, outputPdfRel, rootFallback } from '../../compile.js';
import { KEEPABLE_EXTS, TypesetFirstError, arxivTree, committedTree, outputLayout } from '../../submission.js';

/**
 * F11 generated files and downloads, server side (WP30), and F10's download
 * names. Every typeset already builds the bibliography; WP30's compiler rules
 * add glossaries, acronyms and nomenclature (project switch
 * `outputs.buildAux`, on by default). These routes let people see, download
 * and keep what the typeset generated:
 *
 * - GET  /api/projects/:id/output/list?branch   what the last typeset left in the main document's .aldine-out
 * - POST /api/projects/:id/output/keep {branch, name}   copy one generated file into the project, one commit (members)
 * - GET  /api/projects/:id/export/arxiv?branch[&check=1]   the arXiv ZIP, or with check=1 its warnings as JSON; 409 "Typeset first"
 * - GET  /api/projects/:id/download/pdf?branch[&inline=1]   the PDF, named after the project
 *
 * Downloads are named after the project, never the root file: most roots are
 * main.tex, so root names would give everyone main.pdf. Inside the archive
 * files keep their names (arXiv needs main.bbl beside main.tex).
 */

/** One entry of GET …/output/list. `tracked` only for files Add to project accepts. */
export interface OutputEntry { name: string; path: string; size: number; mtime: string; fromLastRun: boolean; keepable: boolean; tracked?: 'same' | 'differs' | null }

const branchOf = (q: unknown): string | null => {
  const b = typeof q === 'string' && q ? q : 'main';
  return BRANCH_RE.test(b) && !b.includes('..') ? b : null;
};

/** The root this branch typesets (the project's, or the fallback when the branch lacks it). */
const branchRoot = (meta: ProjectMeta, branch: string) => (meta.rootFile ? rootFallback(meta.id, branch, meta.rootFile)?.root ?? meta.rootFile : '');

const keepable = (name: string) => KEEPABLE_EXTS.includes(path.extname(name).slice(1).toLowerCase());

/** A download name from the project name: no characters Windows or macOS refuse, no device names, never empty. */
export function downloadName(projectName: string, ext: string): string {
  let n = projectName.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-').trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = `${n}-`;
  return `${(n || 'document').slice(0, 150)}${ext}`;
}

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266). */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const ascii = stem.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[^A-Za-z0-9._() -]+/g, '-').replace(/^[-. ]+|[-. ]+$/g, '').slice(0, 80) || 'document';
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}${ext}"; filename*=UTF-8''${utf8}`;
}

/** The generated files of a branch, as GET …/output/list answers. */
export function listOutputs(projectId: string, branch: string, rootFile: string): { root: string | null; outDir: string | null; typesetAt: string | null; files: OutputEntry[] } {
  if (!rootFile) return { root: null, outDir: null, typesetAt: null, files: [] };
  const dir = store.branchDir(projectId, branch);
  const { rootDir, outDir } = outputLayout(rootFile);
  const outAbs = path.join(dir, outDir);
  let sentinel: number | null = null;
  try { sentinel = fs.statSync(path.join(outAbs, '.aldine-run')).mtimeMs; } catch { /* never typeset */ }
  let names: string[] = [];
  try {
    // A real folder only: a link named .aldine-out is not the compiler's.
    if (fs.lstatSync(outAbs).isDirectory()) names = fs.readdirSync(outAbs);
  } catch { /* no output yet */ }
  const files: OutputEntry[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    let st: fs.Stats;
    try { st = fs.lstatSync(path.join(outAbs, name)); } catch { continue; }
    if (!st.isFile()) continue; // fmt/ (the preamble cache) and links
    const entry: OutputEntry = { name, path: path.posix.join(outDir, name), size: st.size, mtime: st.mtime.toISOString(), fromLastRun: sentinel !== null && st.mtimeMs >= sentinel, keepable: keepable(name) };
    if (entry.keepable) entry.tracked = trackedState(path.join(outAbs, name), path.join(dir, rootDir, name));
    files.push(entry);
  }
  return { root: rootFile, outDir, typesetAt: sentinel === null ? null : new Date(sentinel).toISOString(), files };
}

function trackedState(generated: string, own: string): 'same' | 'differs' | null {
  let st: fs.Stats;
  try { st = fs.lstatSync(own); } catch { return null; }
  if (!st.isFile()) return null;
  try { return fs.readFileSync(own).equals(fs.readFileSync(generated)) ? 'same' : 'differs'; } catch { return null; }
}

/** `git check-ignore -v` for one path: the .gitignore (repository-relative) whose rule ignores it, or null. */
function ignoringFile(dir: string, rel: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['check-ignore', '-v', '--no-index', '--', rel], { cwd: dir }, (err, stdout) => {
      if (err) return resolve(null); // exit 1: not ignored
      const m = /^(.*?):\d+:(.*?)\t/.exec(String(stdout));
      if (!m || m[2].startsWith('!')) return resolve(null);
      const source = m[1];
      // Only a .gitignore in the tree can be changed and shared; .git/info/exclude
      // and a global excludes file are nobody's to edit, and the file is tracked anyway.
      if (path.isAbsolute(source) || source.startsWith('.git/') || path.posix.basename(source) !== '.gitignore') return resolve(null);
      resolve(source);
    });
  });
}

/** A file's new text: through its open document when there is one (collaborators see it), else on disk. */
function writeText(projectId: string, branch: string, rel: string, text: string): void {
  if (applySpansToDoc(projectId, branch, rel, text) !== null) return;
  const abs = path.join(store.branchDir(projectId, branch), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  refreshBranchDocsFromDisk(projectId, branch, [rel]);
}

const typesetFirst = (reply: FastifyReply, err: TypesetFirstError) => reply.code(409).send({ error: err.message, code: 'typeset-first' });

const feature: ServerFeature = {
  id: 'outputs',
  projectSettings: [
    // Switches the glossary, acronym and nomenclature rules (compile.ts sends buildAux: false when it is false).
    { id: BUILD_AUX_SETTING, validate: (v) => typeof v === 'boolean', clientWritable: true, clientVisible: true, copyWithProject: true },
  ],
  capabilities: () => ({ outputs: { list: true, keep: true, arxiv: true, pdf: true } }),
  register(app, kit) {
    app.get<{ Params: { id: string }; Querystring: { branch?: string } }>('/api/projects/:id/output/list', async (req, reply) => {
      const meta = await kit.requireAccess(req, reply);
      if (!meta) return;
      const branch = branchOf(req.query.branch);
      if (!branch) return reply.code(400).send({ error: 'bad branch name' });
      try { await gitops.ensureWorktree(meta.id, branch); } catch { return reply.code(404).send({ error: 'branch not found' }); }
      return reply.header('cache-control', 'no-store').send(listOutputs(meta.id, branch, branchRoot(meta, branch)));
    });

    const keepLimit = kit.limiter('keep', { burst: 10, perSecond: 1 });
    app.post<{ Params: { id: string }; Body: { branch?: string; name?: string } }>('/api/projects/:id/output/keep', async (req, reply) => {
      const meta = await kit.requireMember(req, reply, 'add generated files to the project');
      if (!meta) return;
      if (!keepLimit(req)) return reply.code(429).send({ error: 'Too many requests. Try again in a moment.' });
      const branch = branchOf(req.body?.branch);
      if (!branch) return reply.code(400).send({ error: 'bad branch name' });
      const name = req.body?.name;
      if (typeof name !== 'string' || !/^[^/\\\u0000]+$/.test(name) || name.startsWith('.') || name.startsWith('-') || !keepable(name)) {
        return reply.code(400).send({ error: `Only these generated files can be added to the project: ${KEEPABLE_EXTS.map((e) => `.${e}`).join(', ')}` });
      }
      try { await gitops.ensureWorktree(meta.id, branch); } catch { return reply.code(404).send({ error: 'branch not found' }); }
      const root = branchRoot(meta, branch);
      if (!root) return reply.code(409).send({ error: 'Typeset first: this project has no main document yet.', code: 'typeset-first' });
      const dir = store.branchDir(meta.id, branch);
      const { rootDir, outDir } = outputLayout(root);
      const source = path.join(dir, outDir, name);
      let bytes: Buffer;
      try {
        if (!fs.lstatSync(source).isFile()) throw new Error('not a file');
        bytes = fs.readFileSync(source);
      } catch {
        return reply.code(404).send({ error: `The last typeset made no ${name}. Typeset, then try again.` });
      }
      const rel = rootDir ? `${rootDir}/${name}` : name;
      const target = path.join(dir, rel);
      try { if (!fs.lstatSync(target).isFile()) return reply.code(409).send({ error: `${rel} is a folder or a link in the project, so ${name} cannot be added there.` }); } catch { /* new file */ }
      const text = bytes.toString('utf8');
      flushBranchDocs(meta.id, branch);
      const result = await gitops.withRepoLock(meta.id, async () => {
        const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
        if (before === text) return { unchanged: true as const, created: false, gitignore: null as string | null, commit: null as string | null };
        const files: Array<{ path: string; before: string | null; after: string }> = [{ path: rel, before, after: text }];
        writeText(meta.id, branch, rel, text);
        // A new project's .gitignore no longer ignores *.bbl, but an imported
        // or older one may: the negation makes the intent visible to every
        // clone, not only to this server's index.
        const ignoredBy = await ignoringFile(dir, rel);
        if (ignoredBy) {
          const giBefore = fs.readFileSync(path.join(dir, ignoredBy), 'utf8');
          const pattern = `!/${path.posix.relative(path.posix.dirname(ignoredBy), rel)}`;
          const giAfter = `${giBefore}${giBefore && !giBefore.endsWith('\n') ? '\n' : ''}${pattern}\n`;
          writeText(meta.id, branch, ignoredBy, giAfter);
          files.push({ path: ignoredBy, before: giBefore, after: giAfter });
        }
        let commit: string | null = null;
        if (!meta.manualCommits) {
          const r = await gitops.commitWriteHeld(meta.id, branch, files, `${before === null ? 'Add' : 'Update'} ${rel} from the last typeset`, kit.author(req));
          if (r.committed && r.hash) commit = r.hash.slice(0, 7);
        }
        markPathsChanged(meta.id, branch, files.map((f) => f.path));
        return { unchanged: false as const, created: before === null, gitignore: ignoredBy, commit };
      });
      if (!result.unchanged) {
        bumpFilesSignal(meta.id, branch);
        if (result.commit) {
          signalCommitted(meta.id, branch);
          if (branch === 'main') scheduleAutopush(meta.id);
        }
      }
      return { ok: true, path: rel, ...result };
    });

    // A download is a check then the ZIP; a few retries after "Typeset first" fit in the burst.
    const exportLimit = kit.limiter('arxiv', { burst: 20, perSecond: 0.5 });
    app.get<{ Params: { id: string }; Querystring: { branch?: string; check?: string } }>('/api/projects/:id/export/arxiv', async (req, reply) => {
      const meta = await kit.requireAccess(req, reply);
      if (!meta) return;
      const branch = branchOf(req.query.branch);
      if (!branch) return reply.code(400).send({ error: 'bad branch name' });
      if (!exportLimit(req)) return reply.code(429).send({ error: 'Too many downloads. Try again in a moment.' });
      try { await gitops.ensureWorktree(meta.id, branch); } catch { return reply.code(404).send({ error: 'branch not found' }); }
      const root = branchRoot(meta, branch);
      if (!root) return reply.code(409).send({ error: 'Typeset first: this project has no main document yet.', code: 'typeset-first' });
      flushBranchDocs(meta.id, branch);
      // As the source ZIP: a download is not a commit with manual commits on.
      let tree: string;
      if (meta.manualCommits) tree = await gitops.workingTreeId(meta.id, branch);
      else {
        await gitops.autoCommit(meta.id, branch, undefined, kit.author(req)).catch(() => {});
        tree = await committedTree(meta.id, branch);
      }
      let built: Awaited<ReturnType<typeof arxivTree>>;
      try {
        built = await arxivTree(meta.id, branch, tree, { rootFile: root, engine: meta.engine });
      } catch (err) {
        if (err instanceof TypesetFirstError) return typesetFirst(reply, err);
        throw err;
      }
      const name = downloadName(`${meta.name} (arXiv)`, '.zip');
      if (req.query.check === '1') return reply.header('cache-control', 'no-store').send({ ok: true, name, warnings: built.warnings, files: built.files, rerooted: built.rerooted });
      const zip = await gitops.archiveZip(meta.id, branch, built.tree);
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', contentDisposition('attachment', name))
        .header('x-laytekz-warnings', encodeURIComponent(JSON.stringify(built.warnings)))
        .header('cache-control', 'no-store')
        .send(zip);
    });

    app.get<{ Params: { id: string }; Querystring: { branch?: string; inline?: string } }>('/api/projects/:id/download/pdf', async (req, reply) => {
      const meta = await kit.requireAccess(req, reply);
      if (!meta) return;
      const branch = branchOf(req.query.branch);
      if (!branch) return reply.code(400).send({ error: 'bad branch name' });
      try { await gitops.ensureWorktree(meta.id, branch); } catch { return reply.code(404).send({ error: 'branch not found' }); }
      const root = branchRoot(meta, branch);
      const abs = root ? path.join(store.branchDir(meta.id, branch), outputPdfRel(root)) : null;
      try { if (!abs || !fs.lstatSync(abs).isFile()) throw new Error('none'); } catch {
        return reply.code(404).send({ error: 'Typeset first: there is no PDF yet.', code: 'typeset-first' });
      }
      return reply
        .type('application/pdf')
        .header('content-disposition', contentDisposition(req.query.inline === '1' ? 'inline' : 'attachment', downloadName(meta.name, '.pdf')))
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(fs.createReadStream(abs));
    });
  },
};

export default feature;
