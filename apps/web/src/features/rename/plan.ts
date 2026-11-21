/**
 * F10 reference-aware rename, client side (WP29): what the preview shows and
 * sends, as pure functions over the server's plan (WP28's frozen contract,
 * `GET …/file/rename-plan`). Nothing here touches the DOM or the network.
 */

export type EditKind = 'code' | 'directive' | 'latexmkrc' | 'comment';
export interface PlanRename { from: string; to: string; kind: 'requested' | 'sibling'; checked: boolean; disabled?: boolean; reason?: string }
export interface PlanEdit { id: string; file: string; line: number; kind: EditKind; before: string; after: string; checked: boolean; follows?: string }
export interface PlanSetting { label: string; from: string; to: string }
export interface PlanUnresolved { file: string; line: number; text: string }
export interface PlanWarning { kind: string; message: string; blocking: boolean }
export interface RenamePlan {
  renames: PlanRename[];
  edits: PlanEdit[];
  settings: PlanSetting[];
  unresolved: PlanUnresolved[];
  warnings: PlanWarning[];
}
export interface ApplyBody { branch: string; from: string; to: string; renames: { from: string; to: string }[]; edits: string[] }
export interface ApplyResult {
  ok: boolean; newRoot?: string; commit?: string; undo?: string | null;
  renamed: number; edited: number; skipped: number; files: number; moves: [string, string][];
}
export interface TitleEdit { id: string; file: string; line: number; before: string; after: string; checked: boolean }
export interface TitlePlan { offer: boolean; edits: TitleEdit[] }

/** What the person picked in the preview: the siblings (by `from`) and the reference ids. */
export interface Selection { renames: ReadonlySet<string>; edits: ReadonlySet<string> }

// ---------------------------------------------------------------- reading

const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const KINDS: readonly string[] = ['code', 'directive', 'latexmkrc', 'comment'];
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The server's answer as a plan, or null when it is not one (an older or newer server): the page then renames as before. */
export function readPlan(raw: unknown): RenamePlan | null {
  const o = obj(raw);
  if (!o || !Array.isArray(o.renames) || !Array.isArray(o.edits)) return null;
  const renames: PlanRename[] = [];
  for (const r of o.renames) {
    const x = obj(r);
    if (!x || !str(x.from) || !str(x.to) || (x.kind !== 'requested' && x.kind !== 'sibling')) return null;
    renames.push({ from: x.from, to: x.to, kind: x.kind, checked: x.checked === true, ...(x.disabled === true ? { disabled: true } : {}), ...(str(x.reason) ? { reason: x.reason } : {}) });
  }
  if (renames.filter((r) => r.kind === 'requested').length !== 1) return null;
  const edits: PlanEdit[] = [];
  for (const e of o.edits) {
    const x = obj(e);
    if (!x || !str(x.id) || !str(x.file) || !num(x.line) || !str(x.before) || !str(x.after)) return null;
    edits.push({ id: x.id, file: x.file, line: x.line, kind: (KINDS.includes(String(x.kind)) ? x.kind : 'code') as EditKind, before: x.before, after: x.after, checked: x.checked === true, ...(str(x.follows) ? { follows: x.follows } : {}) });
  }
  const settings = arr(o.settings).map(obj).filter((x): x is Record<string, unknown> => !!x && str(x.label) && str(x.from) && str(x.to))
    .map((x) => ({ label: x.label as string, from: x.from as string, to: x.to as string }));
  const unresolved = arr(o.unresolved).map(obj).filter((x): x is Record<string, unknown> => !!x && str(x.file) && num(x.line) && str(x.text))
    .map((x) => ({ file: x.file as string, line: x.line as number, text: x.text as string }));
  const warnings = arr(o.warnings).map(obj).filter((x): x is Record<string, unknown> => !!x && str(x.message))
    .map((x) => ({ kind: str(x.kind) ? x.kind : 'other', message: x.message as string, blocking: x.blocking === true }));
  return { renames, edits, settings, unresolved, warnings };
}

export function readTitlePlan(raw: unknown): TitlePlan | null {
  const o = obj(raw);
  if (!o || typeof o.offer !== 'boolean') return null;
  const edits = arr(o.edits).map(obj).filter((x): x is Record<string, unknown> => !!x && str(x.id) && str(x.file) && num(x.line) && str(x.before) && str(x.after))
    .map((x) => ({ id: x.id as string, file: x.file as string, line: x.line as number, before: x.before as string, after: x.after as string, checked: x.checked !== false }));
  return { offer: o.offer && edits.length > 0, edits };
}

// ---------------------------------------------------------------- shaping

export function requested(plan: RenamePlan): PlanRename {
  return plan.renames.find((r) => r.kind === 'requested') ?? plan.renames[0];
}
export const siblings = (plan: RenamePlan) => plan.renames.filter((r) => r.kind === 'sibling');

/** The rename an edit depends on: its own `follows`, else the requested one. */
export const followsOf = (plan: RenamePlan, e: PlanEdit) => e.follows ?? requested(plan).from;

/** With the sibling offer turned off, the siblings and the references that follow them are left out. */
export function viewPlan(plan: RenamePlan, o: { siblings: boolean }): RenamePlan {
  if (o.siblings) return plan;
  const gone = new Set(siblings(plan).map((s) => s.from));
  return { ...plan, renames: plan.renames.filter((r) => r.kind === 'requested'), edits: plan.edits.filter((e) => !gone.has(followsOf(plan, e))) };
}

export const blockingMessage = (plan: RenamePlan): string | null => plan.warnings.find((w) => w.blocking)?.message ?? null;

/**
 * Whether to ask. Not when the rename touches nothing else: no sibling that
 * could move with it, no reference, nothing that needs attention, nothing in
 * the way. The settings that name the file (the main document, the Zotero
 * sync file) follow a plain rename as well, so they alone never ask.
 */
export function needsDialog(plan: RenamePlan): boolean {
  return siblings(plan).some((s) => !s.disabled) || plan.edits.length > 0 || plan.unresolved.length > 0 || blockingMessage(plan) !== null;
}

/** References to the renamed file that a plain rename leaves pointing at the old name (comments do not count). */
export function referencesLeft(plan: RenamePlan): number {
  const from = requested(plan).from;
  return plan.edits.filter((e) => e.kind !== 'comment' && followsOf(plan, e) === from).length;
}

// ---------------------------------------------------------------- choosing

/** An edit can be chosen only while the rename it depends on is chosen. */
export function editEnabled(plan: RenamePlan, sel: Selection, e: PlanEdit): boolean {
  const f = followsOf(plan, e);
  if (f === requested(plan).from) return true;
  const sib = siblings(plan).find((s) => s.from === f);
  return !sib || sel.renames.has(f);
}

/** As the server suggests: checked siblings that can move, then the checked references they allow (comments start unchecked). */
export function initialSelection(plan: RenamePlan): Selection {
  const renames = new Set(siblings(plan).filter((s) => s.checked && !s.disabled).map((s) => s.from));
  const sel: Selection = { renames, edits: new Set() };
  return { renames, edits: new Set(plan.edits.filter((e) => e.checked && editEnabled(plan, sel, e)).map((e) => e.id)) };
}

/** A sibling's box: its references follow it (back to their suggested state when it is ticked again). */
export function toggleRename(plan: RenamePlan, sel: Selection, from: string, on: boolean): Selection {
  const sib = siblings(plan).find((s) => s.from === from);
  if (!sib || sib.disabled) return sel;
  const renames = new Set(sel.renames);
  const edits = new Set(sel.edits);
  if (on) renames.add(from); else renames.delete(from);
  for (const e of plan.edits) {
    if (followsOf(plan, e) !== from) continue;
    if (on && e.checked) edits.add(e.id);
    if (!on) edits.delete(e.id);
  }
  return { renames, edits };
}

export function toggleEdit(plan: RenamePlan, sel: Selection, id: string, on: boolean): Selection {
  const e = plan.edits.find((x) => x.id === id);
  if (!e || !editEnabled(plan, sel, e)) return sel;
  const edits = new Set(sel.edits);
  if (on) edits.add(id); else edits.delete(id);
  return { renames: sel.renames, edits };
}

export function chosenEdits(plan: RenamePlan, sel: Selection): PlanEdit[] {
  return plan.edits.filter((e) => sel.edits.has(e.id) && editEnabled(plan, sel, e));
}

export function applyBody(plan: RenamePlan, sel: Selection, branch: string): ApplyBody {
  const req = requested(plan);
  return {
    branch, from: req.from, to: req.to,
    renames: siblings(plan).filter((s) => !s.disabled && sel.renames.has(s.from)).map((s) => ({ from: s.from, to: s.to })),
    edits: chosenEdits(plan, sel).map((e) => e.id),
  };
}

/** "Rename only paper.tex": the file alone, as its own commit. */
export function onlyBody(plan: RenamePlan, branch: string): ApplyBody {
  const req = requested(plan);
  return { branch, from: req.from, to: req.to, renames: [], edits: [] };
}

/** The pairs the apply will move, in the order the server makes them. */
export const bodyMoves = (b: ApplyBody): [string, string][] => [[b.from, b.to], ...b.renames.map((r) => [r.from, r.to] as [string, string])];

// ---------------------------------------------------------------- words

export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Both names in full when the file changes folder, else the names alone. */
export function pairLabel(from: string, to: string): [string, string] {
  return dirOf(from) === dirOf(to) ? [baseName(from), baseName(to)] : [from, to];
}

export function dialogTitle(plan: RenamePlan): string {
  const req = requested(plan);
  const [a, b] = pairLabel(req.from, req.to);
  return dirOf(req.from) !== dirOf(req.to) && baseName(req.from) === baseName(req.to) ? `Move ${a} to ${dirOf(req.to) || 'the top level'}?` : `Rename ${a} to ${b}?`;
}

export function primaryLabel(plan: RenamePlan, sel: Selection): string {
  const files = 1 + siblings(plan).filter((s) => !s.disabled && sel.renames.has(s.from)).length;
  const refs = chosenEdits(plan, sel).length;
  const what = files === 1 ? `Rename ${baseName(requested(plan).from)}` : `Rename ${files} files`;
  return refs ? `${what} and update ${plural(refs, 'reference')}` : what;
}

export const onlyLabel = (plan: RenamePlan) => `Rename only ${baseName(requested(plan).from)}`;

export function siblingNote(r: PlanRename): string {
  if (r.disabled) return r.reason ?? 'Cannot be renamed';
  if (/\.xmpdata$/i.test(r.from)) return 'read by pdfx as \\jobname.xmpdata';
  return 'same name as the main document';
}

export function editNote(e: PlanEdit): string | null {
  if (e.kind === 'comment') return 'in a comment';
  if (e.kind === 'latexmkrc') return 'not used by this server\'s typesetting; kept correct for local builds';
  if (e.kind === 'directive') return 'a directive for local editors';
  return null;
}

/** Shown under an unticked reference to the renamed file itself. */
export function danglingNote(plan: RenamePlan, sel: Selection, e: PlanEdit): string | null {
  if (e.kind === 'comment' || sel.edits.has(e.id) || followsOf(plan, e) !== requested(plan).from) return null;
  return 'will point at a file that no longer exists';
}

/** References grouped by file, in file order then line order. */
export function editsByFile(plan: RenamePlan): { file: string; edits: PlanEdit[] }[] {
  const groups = new Map<string, PlanEdit[]>();
  for (const e of plan.edits) groups.set(e.file, [...(groups.get(e.file) ?? []), e]);
  return [...groups].map(([file, edits]) => ({ file, edits: [...edits].sort((a, b) => a.line - b.line) }));
}

/** "Renamed paper.tex to thesis.tex and 1 other file, and updated 5 references in 3 files". */
export function doneMessage(res: ApplyResult): string {
  const [first, ...rest] = res.moves;
  if (!first) return 'Renamed';
  const [a, b] = pairLabel(first[0], first[1]);
  let s = `Renamed ${a} to ${b}`;
  if (rest.length) s += ` and ${plural(rest.length, 'other file')}`;
  if (res.edited) s += `${rest.length ? ',' : ''} and updated ${plural(res.edited, 'reference')} in ${plural(Math.max(1, res.files), 'file')}`;
  if (res.skipped) s += `. ${plural(res.skipped, 'reference')} changed since the preview and ${res.skipped === 1 ? 'was' : 'were'} left alone`;
  return s;
}

export function leftMessage(res: ApplyResult, left: number): string {
  return `${doneMessage(res)}. ${plural(left, 'reference')} still ${left === 1 ? 'uses' : 'use'} the old name`;
}

/** The title question's one-line diff. */
export function titleDiff(plan: TitlePlan): string {
  const e = plan.edits[0];
  if (!e) return '';
  const more = plan.edits.length > 1 ? ` (and ${plural(plan.edits.length - 1, 'other place')})` : '';
  return `${e.before.trim()}  →  ${e.after.trim()}${more}`;
}

/** Where `path` is after `moves` (a folder's move carries what is in it). */
export function remapPath(path: string, moves: readonly (readonly [string, string])[]): string {
  let p = path;
  for (const [from, to] of moves) {
    if (p === from) p = to;
    else if (p.startsWith(`${from}/`)) p = to + p.slice(from.length);
  }
  return p;
}

/** The same pairs, in any order. */
export function sameMoves(a: readonly (readonly [string, string])[], b: readonly (readonly [string, string])[]): boolean {
  const key = (m: readonly (readonly [string, string])[]) => m.map(([x, y]) => `${x}\u0000${y}`).sort().join('\u0001');
  return a.length === b.length && key(a) === key(b);
}

/** The moves that put `moves` back: reversed, each pair swapped. */
export const reverseMoves = (moves: readonly (readonly [string, string])[]): [string, string][] => [...moves].reverse().map(([a, b]) => [b, a]);
