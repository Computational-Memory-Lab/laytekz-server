/**
 * Galley (V2, feature 10): the reference-aware rename. `planRename` previews
 * what renaming a file or folder would change (same-name siblings of the
 * main document, the references in other files, the project settings that
 * name it); `applyRename` makes the confirmed part of it as one commit whose
 * trailers (`Aldine-Moves`, `Aldine-Meta`) let `/revert` put everything back,
 * or, in a project that commits by hand, as one undo image. Title plan and
 * apply do the same for `\title{<project name>}` when the project is renamed.
 *
 * Writes follow search.ts's replace: under the repo lock, open documents
 * change through a CRDT edit of the argument only (a collaborator's typing
 * elsewhere on the line survives), closed files on disk; moved files keep
 * their Yjs state (moveDocState), so highlights and agent marks follow.
 */
import * as store from './store.js';
import * as gitops from './gitops.js';
import * as comments from './comments.js';
import {
  flushBranchDocs, refreshBranchDocsFromDisk, applyEditsToDoc, openDocContent, inFileLineEndings, withCrlf,
  moveDocState, markTreeChanged, markPathsChanged, bumpFilesSignal, bumpCommentsSignal, notifyCommitted, signalBranch,
} from './collab.js';
import { SEARCH_LIMITS, currentText, splice, writeDisk } from './search.js';
import { saveImage, moveDocsBack, type ImageFile, type RenameRecord } from './undoImages.js';
import { importPath, isHiddenPath, optionLikePath, invalidRootFile } from './util.js';
import { planReferences, planTitle, documentSources, scannedPath, siblingRenames, makeMapper, type Move, type RefEdit, type RefKind, type TexSource } from './fileRefs.js';
import { FILES_MOVED_SIGNAL, type FilesMovedSignal } from './features/types.js';
import type { ProjectMeta } from './db/types.js';

/** A refusal the route sends as is; `status` 409 means nothing was changed. */
export class RenameError extends Error {
  constructor(readonly status: number, readonly body: { error: string; [k: string]: unknown }) { super(body.error); }
}

export interface PlanRenameRow { from: string; to: string; kind: 'requested' | 'sibling'; checked: boolean; disabled?: boolean; reason?: string }
export interface PlanEditRow { id: string; file: string; line: number; kind: RefKind; before: string; after: string; checked: boolean; follows: string }
export interface RenamePlan {
  renames: PlanRenameRow[];
  edits: PlanEditRow[];
  settings: Array<{ label: string; from: string; to: string }>;
  unresolved: Array<{ file: string; line: number; text: string }>;
  warnings: Array<{ kind: string; message: string; blocking: boolean }>;
}
export interface ApplyBody { branch?: unknown; from?: unknown; to?: unknown; renames?: unknown; edits?: unknown }
export interface ApplyResult {
  ok: true;
  newRoot?: string;
  commit?: string;
  undo?: string | null;
  renamed: number;
  edited: number;
  skipped: number;
  files: number;
  moves: Array<[string, string]>;
}

// ------------------------------------------------------------ checks

/** The requested rename, normalised; the same refusals as POST /file/rename. */
export function checkRequested(projectId: string, branch: string, from: unknown, to: unknown): Move {
  if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) throw new RenameError(400, { error: 'from/to required' });
  const f = importPath(from);
  const t = importPath(to);
  if (!f || !t) throw new RenameError(400, { error: 'Path must name a file or folder in the project' });
  if (isHiddenPath(f) || isHiddenPath(t)) throw new RenameError(403, { error: 'forbidden path' });
  if (optionLikePath(t)) throw new RenameError(400, { error: 'File name cannot start with "-"' });
  if (f === t) throw new RenameError(400, { error: 'The new name is the same as the old one' });
  if (!store.fileExists(projectId, branch, f)) throw new RenameError(404, { error: `No file named "${f}"` });
  if (store.fileExists(projectId, branch, t)) throw new RenameError(409, { error: `A file named "${t}" already exists` });
  const folder = store.isDirectory(projectId, branch, f);
  if (folder && t.startsWith(`${f}/`)) throw new RenameError(400, { error: `"${f}" cannot move into a folder inside itself` });
  return { from: f, to: t, folder };
}

const BRANCH_OK = /^[A-Za-z0-9._/-]+$/;
export function branchOf(raw: unknown): string {
  const b = typeof raw === 'string' && raw ? raw : 'main';
  if (!BRANCH_OK.test(b) || b.includes('..')) throw new RenameError(400, { error: 'invalid branch name' });
  return b;
}

// ------------------------------------------------------------ scan

interface Scan { files: string[]; sources: TexSource[]; large: string[] }

/** The branch's files and the text of its TeX sources (open documents as the editor holds them). Over the scan cap: 413. */
function scanBranch(projectId: string, branch: string): Scan {
  const files = store.listFiles(projectId, branch).filter((e) => e.type === 'file').map((e) => e.path);
  const sources: TexSource[] = [];
  const large: string[] = [];
  let units = 0;
  for (const p of files) {
    if (!scannedPath(p)) continue;
    const cur = currentText(projectId, branch, p);
    if (cur === 'large') { large.push(p); continue; }
    units += cur.cost;
    if (units > SEARCH_LIMITS.scanUnits) throw new RenameError(413, { error: 'This project holds too much text to check its references — rename only the file' });
    if (cur.text !== null) sources.push({ path: p, text: cur.text });
  }
  return { files, sources, large };
}

const filesUnder = (files: readonly string[], dir: string) => files.filter((f) => f.startsWith(`${dir}/`));

// ------------------------------------------------------------ plan

interface Computed {
  plan: RenamePlan;
  moves: Move[];
  edits: RefEdit[];
  scan: Scan;
  newRoot: string | null;
  newZoteroBib: string | null;
}

/** `chosen`: the siblings to include ('all': every one that is not disabled, as the preview shows them). */
function compute(projectId: string, branch: string, meta: ProjectMeta, req: Move, chosen: 'all' | Array<{ from: string; to: string }>): Computed {
  const scan = scanBranch(projectId, branch);
  const root = meta.rootFile ?? '';
  const siblings = req.folder ? [] : siblingRenames(scan.files, root, req.from, req.to);
  const picked = chosen === 'all'
    ? siblings.filter((s) => !s.disabled)
    : siblings.filter((s) => !s.disabled && chosen.some((c) => c.from === s.from && c.to === s.to));
  const moves: Move[] = [req, ...picked.map((s) => ({ from: s.from, to: s.to }))];
  const refs = planReferences(scan.sources, scan.files, root, moves);
  const map = makeMapper(moves);
  const newRoot = root ? map(root)?.path ?? null : null;
  const bib = meta.zotero?.bibFile ? importPath(meta.zotero.bibFile) : null;
  const newZoteroBib = bib ? map(bib)?.path ?? null : null;
  const checkedSibling = new Map(siblings.map((s) => [s.from, s.checked]));

  const warnings: RenamePlan['warnings'] = [];
  if (newRoot) {
    const bad = invalidRootFile(newRoot);
    if (bad) warnings.push({ kind: 'invalid-root', message: bad, blocking: true });
  }
  const targets = new Set<string>();
  for (const m of moves) {
    if (targets.has(m.to)) warnings.push({ kind: 'collision', message: `Two files would be named "${m.to}"`, blocking: true });
    targets.add(m.to);
  }
  for (const e of refs.edits) {
    if (/\s/.test(e.newArg) && ['bibliography', 'nobibliography', 'usepackage', 'RequirePackage', 'documentclass', 'LoadClass', 'include', 'includeonly', 'bibliographystyle'].includes(e.command)) {
      warnings.push({ kind: 'space', message: `"${e.newArg}" has a space in its name, which \\${e.command} cannot load`, blocking: false });
    }
  }
  for (const p of scan.large) warnings.push({ kind: 'large', message: `${p} is too large to check for references`, blocking: false });

  const plan: RenamePlan = {
    renames: [
      { from: req.from, to: req.to, kind: 'requested', checked: true },
      ...siblings.map((s) => ({ from: s.from, to: s.to, kind: 'sibling' as const, checked: s.checked, ...(s.disabled ? { disabled: true, reason: s.reason } : {}) })),
    ],
    edits: refs.edits.map((e) => ({
      id: e.id, file: e.file, line: e.line, kind: e.kind, before: e.before, after: e.after, follows: e.follows,
      checked: e.kind !== 'comment' && (e.follows === req.from || checkedSibling.get(e.follows) === true),
    })),
    settings: [
      ...(newRoot ? [{ label: 'Main document', from: root, to: newRoot }] : []),
      ...(newZoteroBib && bib ? [{ label: 'Zotero sync file', from: bib, to: newZoteroBib }] : []),
    ],
    unresolved: refs.unresolved,
    warnings,
  };
  return { plan, moves, edits: refs.edits, scan, newRoot, newZoteroBib };
}

/** GET …/file/rename-plan: what renaming `from` to `to` would change. Changes nothing. */
export async function planRename(projectId: string, branch: string, from: unknown, to: unknown): Promise<RenamePlan> {
  await gitops.ensureWorktree(projectId, branch);
  const req = checkRequested(projectId, branch, from, to);
  const meta = await store.readMeta(projectId);
  return compute(projectId, branch, meta, req, 'all').plan;
}

// ------------------------------------------------------------ apply

const quote = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);

export function renameCommitMessage(moves: ReadonlyArray<[string, string]>, edited: number, files: number, record: RenameRecord): string {
  const [first, ...rest] = moves;
  const subject = `Rename ${quote(first[0])} to ${quote(first[1])}`;
  const body: string[] = [];
  if (rest.length) body.push(`Also renamed ${rest.map(([a]) => a).join(', ')}.`);
  if (edited) body.push(`Updated ${edited} reference${edited === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}.`);
  return `${subject}\n\n${body.length ? `${body.join(' ')}\n\n` : ''}${renameTrailers(record)}\n`;
}

/** The trailers `/revert` reads back. JSON on one line each; the trailer names are wire identifiers. */
export function renameTrailers(record: RenameRecord): string {
  return `Aldine-Moves: ${JSON.stringify(record.moves)}\nAldine-Meta: ${JSON.stringify(record.meta)}`;
}

const isPair = (v: unknown): v is [string, string] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && !!importPath(v[0]) && !!importPath(v[1]);

/** The rename a commit made, from its trailers; null for any other commit. */
export function parseRenameTrailers(message: string): RenameRecord | null {
  const moves = /^Aldine-Moves: (.*)$/m.exec(message)?.[1];
  if (!moves) return null;
  try {
    const m = JSON.parse(moves) as unknown;
    if (!Array.isArray(m) || !m.length || !m.every(isPair)) return null;
    const rawMeta = /^Aldine-Meta: (.*)$/m.exec(message)?.[1];
    const meta = rawMeta ? JSON.parse(rawMeta) as Record<string, unknown> : {};
    const out: RenameRecord = { moves: m.map(([a, b]) => [importPath(a)!, importPath(b)!]), meta: {} };
    if (isPair(meta.rootFile)) out.meta.rootFile = meta.rootFile;
    if (isPair(meta.zoteroBib)) out.meta.zoteroBib = meta.zoteroBib;
    return out;
  } catch { return null; }
}

/**
 * POST …/file/rename-apply: the requested rename, the chosen siblings and
 * the confirmed reference edits (by id; one whose text changed since the
 * preview is skipped and counted). Any refusal is a 409 before anything is
 * written.
 */
export async function applyRename(projectId: string, body: ApplyBody, author: gitops.CommitAuthor | undefined, by: string | null): Promise<ApplyResult> {
  const branch = branchOf(body.branch);
  await gitops.ensureWorktree(projectId, branch);
  checkRequested(projectId, branch, body.from, body.to);
  const chosen = Array.isArray(body.renames)
    ? body.renames.filter((r): r is { from: string; to: string } => !!r && typeof r === 'object' && typeof (r as { from?: unknown }).from === 'string' && typeof (r as { to?: unknown }).to === 'string')
      .map((r) => ({ from: importPath(r.from) ?? '', to: importPath(r.to) ?? '' }))
    : [];
  const ids = new Set(Array.isArray(body.edits) ? body.edits.filter((e): e is string => typeof e === 'string') : []);
  const manual = (await store.readMeta(projectId)).manualCommits === true;

  return gitops.withRepoLock(projectId, async (): Promise<ApplyResult> => {
    flushBranchDocs(projectId, branch);
    const req = checkRequested(projectId, branch, body.from, body.to);
    const siblings = chosen.filter((c) => c.from !== req.from);
    let meta = await store.readMeta(projectId);
    const first = compute(projectId, branch, meta, req, siblings);
    const missing = siblings.filter((c) => !first.moves.some((m) => m.from === c.from && m.to === c.to));
    if (missing.length) throw new RenameError(409, { error: `The files changed since the preview ("${missing[0].from}") — rename again` });
    const blocking = first.plan.warnings.filter((w) => w.blocking);
    if (blocking.length) throw new RenameError(409, { error: blocking[0].message, warnings: blocking });

    // The person's earlier unsaved typing in these files goes into an
    // autosave of its own, so the rename's commit holds the rename alone.
    if (!manual) {
      const touched = new Set<string>();
      for (const m of first.moves) {
        if (m.folder) for (const f of filesUnder(first.scan.files, m.from)) touched.add(f);
        else touched.add(m.from);
      }
      for (const e of first.edits) if (ids.has(e.id)) touched.add(e.file);
      await gitops.checkpointPathsHeld(projectId, branch, [...touched]);
      flushBranchDocs(projectId, branch);
    }
    meta = await store.readMeta(projectId);

    // ---- synchronous from the final plan to the last write: no keystroke
    // lands between reading a file and changing it.
    const c = compute(projectId, branch, meta, req, siblings);
    if (c.plan.warnings.some((w) => w.blocking) || c.moves.length !== first.moves.length) throw new RenameError(409, { error: 'The files changed since the preview — rename again' });
    for (const m of c.moves) {
      if (store.fileExists(projectId, branch, m.to)) throw new RenameError(409, { error: `A file named "${m.to}" already exists` });
    }
    const map = makeMapper(c.moves);
    const chosenEdits = c.edits.filter((e) => ids.has(e.id));
    const skipped = ids.size - chosenEdits.length;
    const byFile = new Map<string, RefEdit[]>();
    for (const e of chosenEdits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);

    // Before-images and how each edited file keeps its line endings, read
    // before the moves evict the documents.
    const pre = new Map<string, { text: string; raw: string; open: boolean; crlf: boolean }>();
    for (const file of byFile.keys()) {
      const cur = currentText(projectId, branch, file);
      if (cur === 'large' || cur.text === null) continue;
      const crlf = cur.open ? inFileLineEndings(projectId, branch, file, 'a\nb') !== 'a\nb' : cur.crlf === true;
      pre.set(file, { text: cur.text, raw: cur.raw ?? (crlf ? withCrlf(cur.text) : cur.text), open: cur.open, crlf });
    }
    const movedFiles: Array<[string, string]> = [];
    for (const m of c.moves) {
      if (m.folder) for (const f of filesUnder(c.scan.files, m.from)) movedFiles.push([f, m.to + f.slice(m.from.length)]);
      else movedFiles.push([m.from, m.to]);
    }
    const movedBytes = manual ? new Map(movedFiles.map(([a]) => [a, store.readFile(projectId, branch, a)])) : new Map<string, Buffer>();

    const done: Move[] = [];
    try {
      for (const m of c.moves) {
        moveDocState(projectId, branch, m.from, m.to, m.folder ? { folder: true, files: c.scan.files } : undefined);
        store.renameFile(projectId, branch, m.from, m.to);
        done.push(m);
      }
    } catch (err) {
      for (const m of done.reverse()) { try { store.renameFile(projectId, branch, m.to, m.from); moveDocState(projectId, branch, m.to, m.from, m.folder ? { folder: true, files: filesUnder(c.scan.files, m.from).map((f) => m.to + f.slice(m.from.length)) } : undefined); } catch { /* best effort */ } }
      throw new RenameError(500, { error: `Could not rename "${req.from}": ${(err as Error).message}` });
    }

    const writes: Array<{ path: string; before: string; after: string }> = [];
    const reseed: string[] = [];
    let edited = 0;
    for (const [file, es] of byFile) {
      const now = pre.get(file);
      if (!now) continue;
      const sorted = [...es].sort((a, b) => a.start - b.start);
      const edits = sorted.map((e) => ({ from: e.start, to: e.end, insert: e.newArg }));
      const target = map(file)?.path ?? file;
      const moved = target !== file;
      let after: string;
      if (!moved && now.open && applyEditsToDoc(projectId, branch, file, edits) === 'applied') {
        after = inFileLineEndings(projectId, branch, file, openDocContent(projectId, branch, file) ?? splice(now.text, edits));
      } else {
        const lf = splice(now.text, edits);
        after = now.crlf ? withCrlf(lf) : lf;
        writeDisk(projectId, branch, target, after);
        if (!moved) reseed.push(target);
      }
      edited += edits.length;
      writes.push({ path: target, before: now.raw, after });
    }
    if (reseed.length) refreshBranchDocsFromDisk(projectId, branch, reseed);
    // ---- end of the synchronous part

    const record: RenameRecord = { moves: c.moves.map((m) => [m.from, m.to]), meta: {} };
    const root = meta.rootFile ?? '';
    if (c.newRoot && root) record.meta.rootFile = [root, c.newRoot];
    const bib = meta.zotero?.bibFile ? importPath(meta.zotero.bibFile) : null;
    if (c.newZoteroBib && bib) record.meta.zoteroBib = [bib, c.newZoteroBib];
    if (record.meta.rootFile || record.meta.zoteroBib) {
      const m = await store.readMeta(projectId);
      if (record.meta.rootFile && m.rootFile === record.meta.rootFile[0]) m.rootFile = record.meta.rootFile[1];
      if (record.meta.zoteroBib && m.zotero && importPath(m.zotero.bibFile) === record.meta.zoteroBib[0]) m.zotero.bibFile = record.meta.zoteroBib[1];
      await store.writeMeta(m);
    }
    let movedComments = false;
    for (const m of c.moves) {
      try { if (await comments.movePath(projectId, branch, m.from, m.to, m.folder === true)) movedComments = true; } catch (err) { console.warn(`[rename] moving review comments failed: ${(err as Error).message}`); }
    }
    if (movedComments) bumpCommentsSignal(projectId, branch);
    if (c.moves.some((m) => m.folder)) markTreeChanged(projectId, branch);
    else markPathsChanged(projectId, branch, [...movedFiles.flat(), ...writes.map((w) => w.path)]);

    let commit: string | undefined;
    let undo: string | null | undefined;
    const editedFiles = writes.length;
    if (!manual) {
      try {
        const res = await gitops.commitTreeHeld(projectId, branch, {
          moves: record.moves,
          writes: writes.map((w) => ({ path: w.path, content: w.after })),
        }, renameCommitMessage(record.moves, edited, editedFiles, record), author);
        if (res.committed && res.hash) { commit = res.hash.slice(0, 7); notifyCommitted(projectId, branch); }
      } catch (err) {
        console.warn(`[rename] the rename's commit failed, left for the autosave: ${(err as Error).message}`);
      }
    } else {
      const images: ImageFile[] = [];
      const writtenAt = new Map(writes.map((w) => [w.path, w]));
      for (const [a, b] of movedFiles) {
        const w = writtenAt.get(b);
        images.push({ path: a, before: movedBytes.get(a) ?? null, after: null });
        images.push({ path: b, before: null, after: w ? Buffer.from(w.after) : movedBytes.get(a) ?? null });
      }
      const movedTargets = new Set(movedFiles.map(([, b]) => b));
      for (const w of writes) if (!movedTargets.has(w.path)) images.push({ path: w.path, before: Buffer.from(w.before), after: Buffer.from(w.after) });
      undo = await saveImage(projectId, branch, images, Date.now(), record).catch(() => null);
    }
    signalMoves(projectId, branch, record.moves, by);
    bumpFilesSignal(projectId, branch);
    return {
      ok: true,
      ...(c.newRoot ? { newRoot: c.newRoot } : {}),
      ...(commit ? { commit } : {}),
      ...(manual ? { undo } : {}),
      renamed: c.moves.length,
      edited,
      skipped,
      files: editedFiles,
      moves: record.moves,
    };
  });
}

/** Tells every client on the branch which paths moved, so editors follow (WP06 emits `filesMoved`). */
export function signalMoves(projectId: string, branch: string, moves: Array<[string, string]>, by: string | null): void {
  if (!moves.length) return;
  const value: FilesMovedSignal = { moves, by, at: Date.now() };
  try { signalBranch(projectId, branch, FILES_MOVED_SIGNAL, value); } catch (err) { console.warn(`[rename] moves signal failed: ${(err as Error).message}`); }
}

// ------------------------------------------------------------ undo

/**
 * After a revert or an undo image put the files back: the settings that
 * named a moved file return to the old name (only while they still hold the
 * rename's value), review threads move back, and clients follow. `docs`:
 * also carry the documents back (the revert path; restoreImage did it
 * already for an image). Returns the main document when it changed.
 */
export async function undoRenameEffects(projectId: string, branch: string, record: RenameRecord, by: string | null, o: { docs: boolean }): Promise<string | undefined> {
  const listed = () => store.listFiles(projectId, branch).filter((e) => e.type === 'file').map((e) => e.path);
  if (o.docs) moveDocsBack(projectId, branch, record.moves, (p) => store.isDirectory(projectId, branch, p), (dir) => filesUnder(listed(), dir));
  let newRoot: string | undefined;
  if (record.meta.rootFile || record.meta.zoteroBib) {
    const m = await store.readMeta(projectId);
    let changed = false;
    if (record.meta.rootFile && m.rootFile === record.meta.rootFile[1]) { m.rootFile = record.meta.rootFile[0]; newRoot = m.rootFile; changed = true; }
    if (record.meta.zoteroBib && m.zotero && importPath(m.zotero.bibFile) === record.meta.zoteroBib[1]) { m.zotero.bibFile = record.meta.zoteroBib[0]; changed = true; }
    if (changed) await store.writeMeta(m);
  }
  const back: Array<[string, string]> = [...record.moves].reverse().map(([a, b]) => [b, a]);
  let movedComments = false;
  for (const [from, to] of back) {
    const folder = store.isDirectory(projectId, branch, to);
    try { if (await comments.movePath(projectId, branch, from, to, folder)) movedComments = true; } catch { /* threads stay */ }
  }
  if (movedComments) bumpCommentsSignal(projectId, branch);
  markTreeChanged(projectId, branch);
  signalMoves(projectId, branch, back, by);
  return newRoot;
}

/** The renames among the commits a revert is about to undo, newest first as the revert takes them. */
export async function renamesIn(projectId: string, hashes: string[]): Promise<RenameRecord[]> {
  const bodies = await gitops.commitBodies(projectId, hashes).catch(() => [] as string[]);
  return bodies.map(parseRenameTrailers).filter((r): r is RenameRecord => r !== null);
}

// ------------------------------------------------------------ title

export interface TitlePlan { offer: boolean; edits: Array<{ id: string; file: string; line: number; kind: 'code'; before: string; after: string; checked: boolean }> }

function titleSources(projectId: string, branch: string, meta: ProjectMeta): TexSource[] {
  const scan = scanBranch(projectId, branch);
  const root = meta.rootFile && scan.files.includes(meta.rootFile) ? meta.rootFile : null;
  return root ? documentSources(scan.sources, root) : [];
}

/** GET …/title-plan?from=<old project name>&to=<new name>: whether the document's \title still carries the old name. */
export async function titlePlan(projectId: string, branch: string, from: unknown, to: unknown): Promise<TitlePlan> {
  if (typeof from !== 'string' || typeof to !== 'string') throw new RenameError(400, { error: 'from/to required' });
  await gitops.ensureWorktree(projectId, branch);
  const meta = await store.readMeta(projectId);
  const edits = planTitle(titleSources(projectId, branch, meta), from, to);
  return { offer: edits.length > 0, edits: edits.map((e) => ({ id: e.id, file: e.file, line: e.line, kind: 'code' as const, before: e.before, after: e.after, checked: true })) };
}

/** POST …/title-apply {branch, from, to, edits?}: changes the title (all matches, or the ids given) as one commit. */
export async function titleApply(projectId: string, body: { branch?: unknown; from?: unknown; to?: unknown; edits?: unknown }, author: gitops.CommitAuthor | undefined): Promise<{ ok: true; commit?: string; edited: number; undo?: string | null }> {
  const branch = branchOf(body.branch);
  const { from, to } = body;
  if (typeof from !== 'string' || typeof to !== 'string' || !to.trim()) throw new RenameError(400, { error: 'from/to required' });
  await gitops.ensureWorktree(projectId, branch);
  const only = Array.isArray(body.edits) ? new Set(body.edits.filter((e): e is string => typeof e === 'string')) : null;
  const manual = (await store.readMeta(projectId)).manualCommits === true;
  return gitops.withRepoLock(projectId, async () => {
    flushBranchDocs(projectId, branch);
    let meta = await store.readMeta(projectId);
    const firstFiles = [...new Set(planTitle(titleSources(projectId, branch, meta), from, to).map((e) => e.file))];
    if (!manual && firstFiles.length) { await gitops.checkpointPathsHeld(projectId, branch, firstFiles); flushBranchDocs(projectId, branch); }
    meta = await store.readMeta(projectId);
    const edits = planTitle(titleSources(projectId, branch, meta), from, to).filter((e) => !only || only.has(e.id));
    const byFile = new Map<string, typeof edits>();
    for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
    const writes: Array<{ path: string; before: string; after: string }> = [];
    const reseed: string[] = [];
    for (const [file, es] of byFile) {
      const cur = currentText(projectId, branch, file);
      if (cur === 'large' || cur.text === null) continue;
      const spans = [...es].sort((a, b) => a.start - b.start).map((e) => ({ from: e.start, to: e.end, insert: e.insert }));
      const before = cur.raw ?? inFileLineEndings(projectId, branch, file, cur.text);
      let after: string;
      if (cur.open && applyEditsToDoc(projectId, branch, file, spans) === 'applied') {
        after = inFileLineEndings(projectId, branch, file, openDocContent(projectId, branch, file) ?? splice(cur.text, spans));
      } else {
        const lf = splice(cur.text, spans);
        after = cur.crlf ? withCrlf(lf) : lf;
        writeDisk(projectId, branch, file, after);
        reseed.push(file);
      }
      writes.push({ path: file, before, after });
    }
    if (reseed.length) refreshBranchDocsFromDisk(projectId, branch, reseed);
    if (!writes.length) return { ok: true as const, edited: 0 };
    markPathsChanged(projectId, branch, writes.map((w) => w.path));
    let commit: string | undefined;
    let undo: string | null | undefined;
    if (!manual) {
      const res = await gitops.commitWriteHeld(projectId, branch, writes, `Change the document title to ${quote(to.trim())}`, author).catch(() => null);
      if (res?.committed && res.hash) { commit = res.hash.slice(0, 7); notifyCommitted(projectId, branch); }
    } else {
      undo = await saveImage(projectId, branch, writes.map((w) => ({ path: w.path, before: Buffer.from(w.before), after: Buffer.from(w.after) }))).catch(() => null);
    }
    bumpFilesSignal(projectId, branch);
    return { ok: true as const, edited: edits.length, ...(commit ? { commit } : {}), ...(manual ? { undo } : {}) };
  });
}
