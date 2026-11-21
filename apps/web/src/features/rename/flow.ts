/**
 * F10 rename flows (WP29): the file-rename and project-rename interceptors,
 * the toast's Undo, and the notice a collaborator sees when the file they
 * have open is renamed. Everything the flows reach outside this feature comes
 * in through `RenameDeps`, so the tests drive them without a page or server.
 */
import type { EditorPageCtx, Interceptors } from '../types';
import type { ReferencesMode } from './settings';
import {
  applyBody, bodyMoves, blockingMessage, doneMessage, initialSelection, leftMessage, needsDialog, onlyBody, pairLabel,
  readPlan, readTitlePlan, referencesLeft, remapPath, reverseMoves, sameMoves, titleDiff, viewPlan,
  type ApplyBody, type ApplyResult, type RenamePlan, type Selection,
} from './plan';
import type { RenameClient } from './client';

export type PreviewChoice = { kind: 'cancel' } | { kind: 'only' } | { kind: 'apply'; selection: Selection; always: boolean };

export interface RenameDeps {
  client: RenameClient;
  setting<T>(id: string): T;
  setSetting<T>(id: string, v: T): void;
  /** Shows the preview dialog and resolves the person's choice. */
  preview(plan: RenamePlan, o: { manual: boolean }): Promise<PreviewChoice>;
  now(): number;
  /** How long to wait for the server's moves signal before following by hand (ms). */
  followAfterMs?: number;
}

type FileRename = Parameters<Interceptors['fileRename']>[0];
const errText = (err: unknown) => (err instanceof Error && err.message ? err.message : String(err));
const statusOf = (err: unknown) => (err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 0);

// ---------------------------------------------------------------- own moves

/** Moves this tab asked for (or is undoing), so their signal does not tell this person that someone renamed their file. */
const OWN_MS = 60_000;
let own: { moves: [string, string][]; at: number }[] = [];
export function noteOwnMoves(moves: [string, string][], now: number): void {
  own = [...own.filter((m) => now - m.at < OWN_MS), { moves, at: now }];
}
export function isOwnMoves(moves: readonly (readonly [string, string])[], now: number): boolean {
  own = own.filter((m) => now - m.at < OWN_MS);
  return own.some((m) => sameMoves(m.moves, moves) || (moves.length === 1 && m.moves.some(([a, b]) => a === moves[0][0] && b === moves[0][1])));
}
export function resetOwnMoves(): void { own = []; }

/** Records every `filesMoved` from now on, so a signal that beats the HTTP reply is not missed. */
function watchMoves(page: EditorPageCtx) {
  const seen: (readonly (readonly [string, string])[])[] = [];
  const waiters = new Set<() => void>();
  const off = page.events.on('filesMoved', (e) => { seen.push(e.moves); for (const w of [...waiters]) w(); });
  return {
    /** Resolves true once `moves` were signalled, false after `ms`. Stops watching either way. */
    wait(moves: readonly (readonly [string, string])[], ms: number): Promise<boolean> {
      const hit = () => seen.some((s) => sameMoves(s, moves));
      if (hit()) { off(); return Promise.resolve(true); }
      return new Promise((done) => {
        const finish = (v: boolean) => { waiters.delete(check); clearTimeout(timer); off(); done(v); };
        const check = () => { if (hit()) finish(true); };
        const timer = setTimeout(() => finish(false), ms);
        waiters.add(check);
      });
    },
    stop() { off(); },
  };
}

/** The page follows the moves itself when their signal does not arrive (a dropped connection): the open file, then the tree. */
async function follow(page: EditorPageCtx, watch: ReturnType<typeof watchMoves>, moves: [string, string][], deps: RenameDeps, newRoot: string | undefined) {
  const active = page.activeFile();
  if (newRoot) void page.refreshProject().catch(() => {});
  if (await watch.wait(moves, deps.followAfterMs ?? 2500)) return;
  const next = active ? remapPath(active, moves) : null;
  if (next && next !== active && page.activeFile() === active) page.openFile(next);
  await page.refreshFiles().catch(() => {});
}

// ---------------------------------------------------------------- file rename

const modeOf = (v: unknown): ReferencesMode => (v === 'always' || v === 'never' ? v : 'ask');

/**
 * The `fileRename` interceptor. 'default' lets the page rename as it always
 * did (the server's plain rename keeps the main document, the Zotero file and
 * review threads in step); 'handled' means this flow did it, or the person
 * cancelled.
 */
export async function interceptFileRename(r: FileRename, page: EditorPageCtx, deps: RenameDeps, force?: ReferencesMode): Promise<'handled' | 'default'> {
  if (!page.canEdit() || page.showcase()) return 'default';
  const mode = force ?? modeOf(deps.setting('rename.references'));
  let plan: RenamePlan | null = null;
  try {
    plan = readPlan(await deps.client.plan(page.projectId, page.branch, r.from, r.to));
  } catch (err) {
    // 413: too much text to check. Anything else (a name taken, a bad path)
    // the plain rename refuses with its own message.
    if (statusOf(err) === 413) page.toast(`${errText(err)}. Only the file is renamed.`, 'info');
  }
  if (!plan) { noteOwnMoves([[r.from, r.to]], deps.now()); return 'default'; }
  plan = viewPlan(plan, { siblings: deps.setting<boolean>('rename.siblings') !== false });
  if (!needsDialog(plan)) { noteOwnMoves([[r.from, r.to]], deps.now()); return 'default'; }

  if (mode === 'never') {
    const left = referencesLeft(plan);
    if (!left || blockingMessage(plan)) { noteOwnMoves([[r.from, r.to]], deps.now()); return 'default'; }
    await apply(page, deps, onlyBody(plan, page.branch), { left, retry: r });
    return 'handled';
  }
  if (mode === 'always' && !blockingMessage(plan)) {
    await apply(page, deps, applyBody(plan, initialSelection(plan), page.branch));
    return 'handled';
  }
  const choice = await deps.preview(plan, { manual: page.project()?.manualCommits === true });
  if (choice.kind === 'cancel') return 'handled';
  if (choice.kind === 'apply' && choice.always) deps.setSetting<ReferencesMode>('rename.references', 'always');
  await apply(page, deps, choice.kind === 'only' ? onlyBody(plan, page.branch) : applyBody(plan, choice.selection, page.branch));
  return 'handled';
}

/** Applies, then says what changed with an Undo (or, in "Never" mode, an Update for the references left behind). */
async function apply(page: EditorPageCtx, deps: RenameDeps, body: ApplyBody, never?: { left: number; retry: FileRename }): Promise<ApplyResult | null> {
  noteOwnMoves(bodyMoves(body), deps.now());
  const watch = watchMoves(page);
  let res: ApplyResult;
  try {
    res = await deps.client.apply(page.projectId, body);
  } catch (err) {
    watch.stop();
    page.toast(statusOf(err) === 409 ? errText(err) : `Could not rename ${body.from}: ${errText(err)}`, 'error');
    return null;
  }
  const moves = res.moves?.length ? res.moves : bodyMoves(body);
  noteOwnMoves(moves, deps.now());
  void follow(page, watch, moves, deps, res.newRoot);
  if (never) {
    page.toast(leftMessage({ ...res, moves }, never.left), 'ok', {
      label: 'Update',
      run: () => { void undo(page, deps, { ...res, moves }, { quiet: true }).then((ok) => { if (ok) void interceptFileRename(never.retry, page, deps, 'ask'); }); },
    });
  } else {
    page.toast(doneMessage({ ...res, moves }), 'ok', res.commit || res.undo ? { label: 'Undo', run: () => { void undo(page, deps, { ...res, moves }); } } : undefined);
  }
  return res;
}

/** Puts a rename back: its commit reverted, or its undo image restored (manual commits). */
export async function undo(page: EditorPageCtx, deps: RenameDeps, res: ApplyResult, o: { quiet?: boolean } = {}): Promise<boolean> {
  const back = reverseMoves(res.moves);
  const [a] = res.moves[0] ? pairLabel(res.moves[0][0], res.moves[0][1]) : ['the file'];
  noteOwnMoves(back, deps.now());
  const watch = watchMoves(page);
  try {
    let newRoot: string | undefined;
    if (res.commit) {
      const r = await deps.client.revert(page.projectId, page.branch, [res.commit], `Undo the rename of ${res.moves[0]?.[0] ?? 'a file'}`);
      if (!r.ok) { watch.stop(); page.toast(`Nothing to undo: ${a} is already back`, 'info'); return false; }
      newRoot = r.newRoot;
    } else if (res.undo) {
      const r = await deps.client.undo(page.projectId, page.branch, res.undo);
      newRoot = r.newRoot;
      if (r.skipped?.length) page.toast(`Left ${r.skipped.join(', ')} alone: changed since the rename`, 'info');
    } else {
      watch.stop();
      return false;
    }
    void follow(page, watch, back, deps, newRoot ?? res.newRoot);
    if (!o.quiet) page.toast(`Put back ${a}${res.moves.length > 1 || res.edited ? ' and everything the rename changed' : ''}`, 'ok');
    return true;
  } catch (err) {
    watch.stop();
    page.toast(`Could not undo: ${errText(err)}`, 'error');
    return false;
  }
}

// ---------------------------------------------------------------- project rename

/**
 * The `projectRename` interceptor: when the main document's \title is still
 * the old name, ask whether to change it too. The project is renamed either
 * way; dismissing the question keeps the title. Home has no page (no project
 * or branch to read), so the question is asked from the editor only.
 */
export async function interceptProjectRename(r: { from: string; to: string }, page: EditorPageCtx | null, deps: RenameDeps): Promise<'handled' | 'default'> {
  const to = r.to.trim();
  if (!page || !page.canEdit() || page.showcase() || !to || to === r.from) return 'default';
  if (deps.setting<boolean>('rename.title') === false) return 'default';
  let plan;
  try { plan = readTitlePlan(await deps.client.titlePlan(page.projectId, page.branch, r.from, to)); } catch { return 'default'; }
  if (!plan?.offer) return 'default';
  const change = await page.confirm({ title: 'Also change the document title?', body: titleDiff(plan), confirmLabel: 'Change title too', cancelLabel: 'Only rename the project' });
  // A refused rename: the page tries again itself and says why.
  try { await deps.client.renameProject(page.projectId, to); } catch { return 'default'; }
  if (!change) return 'handled';
  try {
    const res = await deps.client.titleApply(page.projectId, { branch: page.branch, from: r.from, to, edits: plan.edits.map((e) => e.id) });
    if (!res.edited) { page.toast('Renamed the project. The title had changed in the meantime, so it was left alone', 'info'); return 'handled'; }
    page.toast(`Renamed the project and changed the document title to ${to}`, 'ok', res.commit || res.undo ? {
      label: 'Undo',
      run: () => { void undoTitle(page, deps, r.from, res); },
    } : undefined);
  } catch (err) {
    page.toast(`Renamed the project, but could not change the title: ${errText(err)}`, 'error');
  }
  return 'handled';
}

async function undoTitle(page: EditorPageCtx, deps: RenameDeps, oldName: string, res: { commit?: string; undo?: string | null }) {
  try {
    if (res.commit) await deps.client.revert(page.projectId, page.branch, [res.commit], 'Undo the title change');
    else if (res.undo) await deps.client.undo(page.projectId, page.branch, res.undo);
    await deps.client.renameProject(page.projectId, oldName);
    await page.refreshProject();
    page.toast(`Put back the name and title ${oldName}`, 'ok');
  } catch (err) {
    page.toast(`Could not undo: ${errText(err)}`, 'error');
  }
}

// ---------------------------------------------------------------- collaborators

/**
 * Per editor page: when someone else renames the file this person has open,
 * the page has already followed it (WP06); say who did it. File spots follow
 * the moved files, folders included.
 */
export function followPeers(page: EditorPageCtx, deps: Pick<RenameDeps, 'now'>, spots: { rename(a: string, b: string): void }, docName: (path: string) => string): () => void {
  return page.events.on('filesMoved', ({ moves, by }) => {
    for (const [a, b] of moves) { try { spots.rename(docName(a), docName(b)); } catch { /* spots are a convenience */ } }
    if (isOwnMoves(moves, deps.now())) return;
    const active = page.activeFile();
    if (!active) return;
    const hit = moves.find(([a, b]) => active === a || active.startsWith(`${a}/`) || active === b || active.startsWith(`${b}/`));
    if (!hit) return;
    const [a, b] = pairLabel(hit[0], hit[1]);
    const me = page.user()?.name;
    page.toast(by && by !== me ? `${by} renamed ${a} to ${b}` : `${a} was renamed to ${b}`, 'info');
  });
}

