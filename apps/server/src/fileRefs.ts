/**
 * Galley (V2, feature 10): the reference-aware rename's planner. Pure: given
 * the text of the project's TeX sources, the list of its files, the main
 * document and a set of moves, it finds every place a source names a moved
 * file (or is itself moved while naming files relative to its own folder)
 * and the edit that keeps the name pointing at the same file afterwards.
 *
 * Only the argument is ever edited, and only when the old argument would no
 * longer resolve to the file's new path: `\includegraphics{fig}` survives
 * `fig.png` → `fig.jpg` untouched. A reference inside a comment or a
 * verbatim-like environment is reported with kind 'comment' (the preview
 * leaves it unchecked); one built from a macro, or an unbraced `\input
 * name`, is reported as unresolved and never edited.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { maskComments } from './bibload.js';
import { latexEscape } from './util.js';

const P = path.posix;

export type RefKind = 'code' | 'directive' | 'latexmkrc' | 'comment';

/** A requested change of name: a file, or a folder with everything in it. */
export interface Move { from: string; to: string; folder?: boolean }

export interface TexSource { path: string; text: string }

export interface RefEdit {
  /** Stable across plans: the file, the command, its ordinal with that argument in the file, the old argument. */
  id: string;
  file: string;
  line: number;
  kind: RefKind;
  /** The whole line before and after the edit. */
  before: string;
  after: string;
  /** The `from` of the move this edit depends on (the target's, else the referencing file's or the root's). */
  follows: string;
  command: string;
  oldArg: string;
  newArg: string;
  /** Offsets of the argument in the file's text (LF). */
  start: number;
  end: number;
}

export interface Unresolved { file: string; line: number; text: string }

export interface RefPlan { edits: RefEdit[]; unresolved: Unresolved[] }

/** The text files the planner reads: TeX sources and latexmk's rc file. */
export function scannedPath(rel: string): boolean {
  const base = P.basename(rel);
  return /\.(tex|ltx|sty|cls|rnw|dtx)$/i.test(base) || base === '.latexmkrc' || base === 'latexmkrc';
}

// ---------------------------------------------------------------- moves

export function makeMapper(moves: readonly Move[]): (p: string) => { path: string; move: Move } | null {
  return (p) => {
    for (const m of moves) {
      if (!m.folder && p === m.from) return { path: m.to, move: m };
      if (m.folder && p.startsWith(`${m.from}/`)) return { path: m.to + p.slice(m.from.length), move: m };
    }
    return null;
  };
}

// ------------------------------------------------------------ commands

const GFX_EXTS = ['.pdf', '.png', '.jpg', '.mps', '.jpeg', '.PDF', '.PNG', '.JPG', '.JPEG', '.eps'];

type Base = 'root' | 'file' | 'gfx';
interface Spec {
  /** Candidate file names for an argument, in TeX's search order. */
  cands(arg: string): string[];
  /** The suffix the command adds itself, which a rewritten argument must leave off. */
  implied?: string;
  list?: boolean;
  /** Only a file of the project counts (a .sty or .cls of the same name may be TeX Live's). */
  local?: boolean;
  gfx?: boolean;
  /** Where a relative argument is read from: the main document's folder (latexmk -cd), else the file's own. */
  base: 'root' | 'file';
}

const hasExt = (arg: string) => /\.[A-Za-z0-9]{1,8}$/.test(P.basename(arg));
const tex = (a: string) => [`${a}.tex`, a];

const SPECS: Record<string, Spec> = {
  input: { cands: tex, base: 'root' },
  include: { cands: (a) => [`${a}.tex`], implied: '.tex', base: 'root' },
  includeonly: { cands: (a) => [`${a}.tex`], implied: '.tex', list: true, base: 'root' },
  subfile: { cands: (a) => [a, `${a}.tex`], base: 'root' },
  includestandalone: { cands: (a) => [a, `${a}.tex`], base: 'root' },
  includegraphics: { cands: (a) => [...(hasExt(a) ? [a] : []), ...GFX_EXTS.map((e) => a + e)], gfx: true, base: 'root' },
  includesvg: { cands: (a) => [a, `${a}.svg`], gfx: true, base: 'root' },
  includepdf: { cands: (a) => [a, `${a}.pdf`], base: 'root' },
  lstinputlisting: { cands: (a) => [a], base: 'root' },
  verbatiminput: { cands: (a) => [a], base: 'root' },
  VerbatimInput: { cands: (a) => [a], base: 'root' },
  inputminted: { cands: (a) => [a], base: 'root' },
  bibliography: { cands: (a) => [a.endsWith('.bib') ? a : `${a}.bib`], implied: '.bib', list: true, base: 'root' },
  nobibliography: { cands: (a) => [a.endsWith('.bib') ? a : `${a}.bib`], implied: '.bib', list: true, base: 'root' },
  addbibresource: { cands: (a) => [a], base: 'root' },
  addglobalbib: { cands: (a) => [a], base: 'root' },
  addsectionbib: { cands: (a) => [a], base: 'root' },
  bibliographystyle: { cands: (a) => [`${a}.bst`], implied: '.bst', local: true, base: 'root' },
  usepackage: { cands: (a) => [`${a}.sty`], implied: '.sty', list: true, local: true, base: 'root' },
  RequirePackage: { cands: (a) => [`${a}.sty`], implied: '.sty', list: true, local: true, base: 'root' },
  documentclass: { cands: (a) => [`${a}.cls`], implied: '.cls', local: true, base: 'root' },
  LoadClass: { cands: (a) => [`${a}.cls`], implied: '.cls', local: true, base: 'root' },
};
/** `% !TEX root =`, the subfiles class option and latexmkrc entries: relative to the file itself. */
const SELF: Spec = { cands: (a) => [a, `${a}.tex`], base: 'file' };

const COMMAND_RE = new RegExp(`\\\\(${[...Object.keys(SPECS), 'graphicspath'].join('|')})(?![A-Za-z@])\\*?`, 'g');
const VERBATIM_RE = /\\begin\{(verbatim\*?|Verbatim\*?|comment|lstlisting|minted)\}[\s\S]*?\\end\{\1\}/g;
const TEX_ROOT_RE = /^[ \t]*%+[ \t]*![ \t]*TEX[ \t]+root[ \t]*=[ \t]*(.*?)[ \t]*$/gim;

/** One path argument found in a source. */
interface Ref {
  file: string;
  command: string;
  arg: string;
  start: number;
  end: number;
  kind: RefKind;
  spec: Spec;
}

/** The `{…}` group starting at `i` (which must be `{`): its inner span, or null if unbalanced within 500 characters or a blank line. */
function braceGroup(text: string, i: number): { start: number; end: number; next: number } | null {
  if (text[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < text.length && j < i + 500; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === '\n' && text[j + 1] === '\n') return null;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { start: i + 1, end: j, next: j + 1 };
  }
  return null;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || (text[i] === '\n' && text[i + 1] !== '\n'))) i++;
  return i;
}

/** Skips `[…]` option groups; returns the position after them and the text of the last one. */
function skipOptions(text: string, i: number): { next: number; options: { start: number; end: number } | null } {
  let options: { start: number; end: number } | null = null;
  for (;;) {
    const j = skipSpace(text, i);
    if (text[j] !== '[') return { next: i, options };
    let depth = 0;
    let k = j;
    for (; k < text.length && k < j + 500; k++) {
      if (text[k] === '{') depth++;
      else if (text[k] === '}') depth--;
      else if (text[k] === ']' && depth <= 0) break;
    }
    if (text[k] !== ']') return { next: i, options };
    options = { start: j + 1, end: k };
    i = k + 1;
  }
}

function lineOf(text: string, at: number): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

function lineSpan(text: string, at: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const eol = text.indexOf('\n', at);
  return { start, end: eol === -1 ? text.length : eol };
}

/** Every path argument in one source, plus the ones that cannot be resolved (macros, unbraced). */
function findRefs(src: TexSource): { refs: Ref[]; raw: Array<{ start: number; text: string }> } {
  const { path: file, text } = src;
  const refs: Ref[] = [];
  const raw: Array<{ start: number; text: string }> = [];
  const base = P.basename(file);
  if (base === '.latexmkrc' || base === 'latexmkrc') {
    const m = /@default_files\s*=\s*\(([^)]*)\)/.exec(text);
    if (m) {
      const inner = m.index + m[0].indexOf('(') + 1;
      for (const q of m[1].matchAll(/(['"])([^'"\n]+)\1/g)) {
        const start = inner + q.index! + 1;
        refs.push({ file, command: 'default_files', arg: q[2], start, end: start + q[2].length, kind: 'latexmkrc', spec: SELF });
      }
    }
    return { refs, raw };
  }
  const masked = maskComments(text);
  const hidden: Array<[number, number]> = [];
  for (const m of masked.matchAll(VERBATIM_RE)) hidden.push([m.index!, m.index! + m[0].length]);
  const inComment = (at: number) => masked[at] !== text[at] || hidden.some(([a, b]) => at >= a && at < b);

  for (const m of text.matchAll(TEX_ROOT_RE)) {
    const arg = m[1];
    if (!arg) continue;
    const start = m.index! + m[0].lastIndexOf(arg);
    refs.push({ file, command: '!TEX root', arg, start, end: start + arg.length, kind: 'directive', spec: SELF });
  }

  for (const m of text.matchAll(COMMAND_RE)) {
    const command = m[1];
    const at = m.index!;
    // An escaped backslash before it: `\\input` is a line break and a word.
    let bs = 0;
    for (let k = at - 1; k >= 0 && text[k] === '\\'; k--) bs++;
    if (bs % 2) continue;
    const kind: RefKind = inComment(at) ? 'comment' : 'code';
    const opt = skipOptions(text, at + m[0].length);
    let i = skipSpace(text, opt.next);
    if (command === 'graphicspath') {
      const outer = braceGroup(text, i);
      if (!outer) continue;
      let j = skipSpace(text, outer.start);
      while (j < outer.end) {
        const g = braceGroup(text, j);
        if (!g) break;
        const arg = text.slice(g.start, g.end);
        if (arg.trim()) refs.push({ file, command, arg, start: g.start, end: g.end, kind, spec: { cands: (a) => [a], base: 'root' } });
        j = skipSpace(text, g.next);
      }
      continue;
    }
    if (command === 'inputminted') {
      const lang = braceGroup(text, i);
      if (!lang) continue;
      i = skipSpace(text, lang.next);
    }
    const group = braceGroup(text, i);
    if (!group) {
      // `\input paper`: TeX reads a bare name up to a space, never edited.
      if (command === 'input' && /[A-Za-z0-9./_-]/.test(text[i] ?? '')) {
        const word = /^[^\s{}%\\]+/.exec(text.slice(i))?.[0] ?? '';
        if (word && kind === 'code') raw.push({ start: at, text: `\\input ${word}` });
      }
      continue;
    }
    if (command === 'documentclass' && opt.options) {
      // \documentclass[../main.tex]{subfiles}: the option names the main document.
      const cls = text.slice(group.start, group.end).trim();
      if (cls === 'subfiles') {
        const o = text.slice(opt.options.start, opt.options.end);
        const arg = o.trim();
        if (arg) {
          const start = opt.options.start + o.indexOf(arg);
          refs.push({ file, command: 'subfiles', arg, start, end: start + arg.length, kind: kind === 'comment' ? 'comment' : 'directive', spec: SELF });
        }
        continue;
      }
    }
    const spec = SPECS[command];
    const inner = text.slice(group.start, group.end);
    const pieces = spec.list ? inner.split(',') : [inner];
    let off = group.start;
    for (const piece of pieces) {
      const arg = piece.trim();
      const start = off + piece.indexOf(arg);
      off += piece.length + 1;
      if (!arg) continue;
      if (/[\\#]/.test(arg)) { if (kind === 'code') raw.push({ start: at, text: text.slice(at, group.end + 1) }); continue; }
      refs.push({ file, command, arg, start, end: start + arg.length, kind, spec });
    }
  }
  refs.sort((a, b) => a.start - b.start);
  return { refs, raw };
}

// ------------------------------------------------------------ resolution

/** A relative argument joined to a folder; null when it leaves the project or is absolute. */
function joinIn(dir: string, arg: string): string | null {
  if (arg.startsWith('/') || /^[A-Za-z]:/.test(arg)) return null;
  const p = P.normalize(P.join(dir, arg));
  if (p === '..' || p.startsWith('../') || p === '.') return null;
  return p;
}

function resolveIn(spec: Spec, arg: string, dirs: string[], files: ReadonlySet<string>): { path: string; dir: string } | null {
  for (const dir of dirs) {
    for (const c of spec.cands(arg)) {
      const p = joinIn(dir, c);
      if (p && files.has(p)) return { path: p, dir };
    }
  }
  return null;
}

/** What a relative path from `dir` to `target` is, written as `oldArg` was (./, extension). */
function writeAs(spec: Spec, oldArg: string, oldTarget: string, dir: string, target: string, files: ReadonlySet<string>): string | null {
  let rel = P.relative(dir || '.', target);
  if (!rel) return null;
  if (oldArg.startsWith('./') && !rel.startsWith('../')) rel = `./${rel}`;
  const tries: string[] = [];
  if (spec.implied) {
    if (!rel.endsWith(spec.implied)) return null;
    const bare = rel.slice(0, -spec.implied.length);
    // \bibliography{refs.bib} written with its extension keeps it.
    if (spec.implied === '.bib' && oldArg.endsWith('.bib')) tries.push(rel);
    tries.push(bare);
  } else {
    const oldExt = P.extname(oldTarget);
    const wroteExt = oldArg.endsWith(oldExt) && oldExt !== '';
    const ext = P.extname(rel);
    if (!wroteExt && ext) tries.push(rel.slice(0, -ext.length));
    tries.push(rel);
  }
  for (const t of tries) {
    const r = resolveIn(spec, t, [dir], files);
    if (r && r.path === target) return t;
  }
  return null;
}

const editId = (file: string, command: string, ordinal: number, arg: string) =>
  crypto.createHash('sha1').update(`${file}\0${command}\0${ordinal}\0${arg}`).digest('hex').slice(0, 12);

/**
 * The edits that keep every reference pointing at the same file after
 * `moves`, and the references that cannot be followed (built from macros,
 * unbraced) when they may concern a moved file. `files` lists the project's
 * files before the moves; `rootFile` is the main document's path before them.
 */
export function planReferences(sources: readonly TexSource[], files: readonly string[], rootFile: string, moves: readonly Move[]): RefPlan {
  const map = makeMapper(moves);
  const oldFiles = new Set(files);
  const newFiles = new Set(files.map((f) => map(f)?.path ?? f));
  const root = rootFile || 'main.tex';
  const rootMove = map(root);
  const oldRootDir = P.dirname(root) === '.' ? '' : P.dirname(root);
  const newRootPath = rootMove?.path ?? root;
  const newRootDir = P.dirname(newRootPath) === '.' ? '' : P.dirname(newRootPath);
  const needles = moves.map((m) => P.basename(m.from).replace(/\.[^.]*$/, '')).filter((s) => s.length >= 2);

  // \graphicspath entries (root-relative folders), from every source.
  const gfxDirs: string[] = [];
  const scanned = sources.map((s) => ({ src: s, ...findRefs(s) }));
  for (const s of scanned) for (const r of s.refs) if (r.command === 'graphicspath' && r.kind === 'code') {
    const d = joinIn(oldRootDir, r.arg);
    if (d && !gfxDirs.includes(d)) gfxDirs.push(d);
  }
  const newGfxDirs = gfxDirs.map((d) => {
    const m = moves.find((mv) => mv.folder && (d === mv.from || d.startsWith(`${mv.from}/`)));
    return m ? m.to + d.slice(m.from.length) : d;
  });

  const edits: RefEdit[] = [];
  const unresolved: Unresolved[] = [];
  for (const { src, refs, raw } of scanned) {
    const fileMove = map(src.path);
    const oldSelfDir = P.dirname(src.path) === '.' ? '' : P.dirname(src.path);
    const newSelfPath = fileMove?.path ?? src.path;
    const newSelfDir = P.dirname(newSelfPath) === '.' ? '' : P.dirname(newSelfPath);
    const seen = new Map<string, number>();
    for (const r of raw) {
      if (needles.some((n) => r.text.includes(n))) unresolved.push({ file: src.path, line: lineOf(src.text, r.start), text: r.text.slice(0, 200) });
    }
    for (const r of refs) {
      const key = `${r.command}\0${r.arg}`;
      const ordinal = seen.get(key) ?? 0;
      seen.set(key, ordinal + 1);
      let oldDirs: string[];
      let newDirs: string[];
      if (r.command === 'graphicspath') {
        // A folder entry: edited when that folder moves.
        const d = joinIn(oldRootDir, r.arg.replace(/\/+$/, ''));
        if (!d) continue;
        const m = moves.find((mv) => mv.folder && (d === mv.from || d.startsWith(`${mv.from}/`)));
        const nd = m ? m.to + d.slice(m.from.length) : d;
        if (nd === d && oldRootDir === newRootDir) continue;
        let rel = P.relative(newRootDir || '.', nd) || '.';
        if (r.arg.endsWith('/')) rel += '/';
        if (r.arg.startsWith('./') && !rel.startsWith('../')) rel = `./${rel}`;
        if (rel === r.arg) continue;
        edits.push(makeEdit(src, r, rel, ordinal, m?.from ?? rootMove?.move.from ?? moves[0].from));
        continue;
      }
      if (r.spec.base === 'file') { oldDirs = [oldSelfDir]; newDirs = [newSelfDir]; }
      else if (r.spec.gfx) { oldDirs = [oldRootDir, ...gfxDirs]; newDirs = [newRootDir, ...newGfxDirs]; }
      else { oldDirs = [oldRootDir, oldSelfDir]; newDirs = [newRootDir, newSelfDir]; }
      const old = resolveIn(r.spec, r.arg, oldDirs, oldFiles);
      if (!old) continue;
      const targetMove = map(old.path);
      const target = targetMove?.path ?? old.path;
      // The folder the argument was read from, after the moves.
      const at = oldDirs.indexOf(old.dir);
      const dir = newDirs[at];
      const now = resolveIn(r.spec, r.arg, [dir], newFiles);
      if (now && now.path === target) continue;
      const follows = targetMove?.move.from ?? (r.spec.base === 'file' ? fileMove?.move.from : rootMove?.move.from) ?? fileMove?.move.from;
      if (!follows) continue;
      const next = writeAs(r.spec, r.arg, old.path, dir, target, newFiles);
      if (next === null || next === r.arg) {
        if (next === null) unresolved.push({ file: src.path, line: lineOf(src.text, r.start), text: lineText(src.text, r.start).slice(0, 200) });
        continue;
      }
      edits.push(makeEdit(src, r, next, ordinal, follows));
    }
  }
  return { edits, unresolved };
}

function lineText(text: string, at: number): string {
  const s = lineSpan(text, at);
  return text.slice(s.start, s.end);
}

function makeEdit(src: TexSource, r: Ref, newArg: string, ordinal: number, follows: string): RefEdit {
  const span = lineSpan(src.text, r.start);
  const line = src.text.slice(span.start, span.end);
  return {
    id: editId(src.path, r.command, ordinal, r.arg),
    file: src.path,
    line: lineOf(src.text, r.start),
    kind: r.kind,
    before: line,
    after: line.slice(0, r.start - span.start) + newArg + line.slice(r.end - span.start),
    follows,
    command: r.command,
    oldArg: r.arg,
    newArg,
    start: r.start,
    end: r.end,
  };
}

/** The files a main document reads with \input, \include and \subfile, itself first. */
export function documentSources(sources: readonly TexSource[], rootFile: string): TexSource[] {
  const byPath = new Map(sources.map((s) => [s.path, s]));
  const files = new Set(sources.map((s) => s.path));
  const rootDir = P.dirname(rootFile) === '.' ? '' : P.dirname(rootFile);
  const out: TexSource[] = [];
  const queue = [rootFile];
  const seen = new Set<string>();
  while (queue.length && out.length < 200) {
    const p = queue.shift()!;
    if (seen.has(p)) continue;
    seen.add(p);
    const src = byPath.get(p);
    if (!src) continue;
    out.push(src);
    for (const r of findRefs(src).refs) {
      if (r.kind !== 'code' || !['input', 'include', 'subfile'].includes(r.command)) continue;
      const hit = resolveIn(r.spec, r.arg, [rootDir], files);
      if (hit) queue.push(hit.path);
    }
  }
  return out;
}

// ------------------------------------------------------------ siblings

/** Same-stem files the preview checks by default when the main document is renamed. */
export const SIBLING_EXTS = ['.bib', '.sty', '.cls', '.bst', '.bbl', '.xmpdata', '.ind', '.gls', '.nls'];

export interface SiblingRename { from: string; to: string; checked: boolean; disabled?: boolean; reason?: string }

/**
 * Files beside the main document that share its name, when the main document
 * itself is renamed: `paper.bib` follows `paper.tex` → `thesis.tex`. Those
 * whose kind TeX ties to the document's name are checked; any other is
 * offered unchecked; one whose new name is taken is disabled.
 */
export function siblingRenames(files: readonly string[], rootFile: string, from: string, to: string): SiblingRename[] {
  if (!rootFile || from !== rootFile || !/\.tex$/i.test(from) || !/\.tex$/i.test(to)) return [];
  const dir = P.dirname(from);
  const stem = P.basename(from).slice(0, -4);
  const newDir = P.dirname(to);
  const newStem = P.basename(to).slice(0, -4);
  const taken = new Set(files);
  const out: SiblingRename[] = [];
  for (const f of files) {
    if (f === from || P.dirname(f) !== dir) continue;
    const base = P.basename(f);
    if (!base.startsWith(`${stem}.`)) continue;
    const ext = base.slice(stem.length);
    const target = P.join(newDir, newStem + ext);
    if (target === f) continue;
    if (taken.has(target) || target === to) out.push({ from: f, to: target, checked: false, disabled: true, reason: `A file named "${target}" already exists` });
    else out.push({ from: f, to: target, checked: SIBLING_EXTS.includes(ext.toLowerCase()) });
  }
  return out;
}

// ------------------------------------------------------------ title

export interface TitleEdit { id: string; file: string; line: number; before: string; after: string; start: number; end: number; insert: string }

/**
 * `\title{<old name>}` (and hyperref's `pdftitle={<old name>}`) where the
 * document still carries the project's old name exactly, as the default
 * project seeds it, and the edit to the new name. Comments do not count.
 */
export function planTitle(sources: readonly TexSource[], oldName: string, newName: string): TitleEdit[] {
  const oldT = latexEscape(oldName.trim());
  const newT = latexEscape(newName.trim());
  if (!oldT || !newT || oldT === newT) return [];
  const out: TitleEdit[] = [];
  const esc = oldT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(\\\\title\\s*(?:\\[[^\\]]*\\])?\\s*\\{|pdftitle\\s*=\\s*\\{)(${esc})\\}`, 'g');
  for (const src of sources) {
    const masked = maskComments(src.text);
    let ordinal = 0;
    for (const m of masked.matchAll(re)) {
      const start = m.index! + m[1].length;
      const end = start + m[2].length;
      const span = lineSpan(src.text, start);
      const line = src.text.slice(span.start, span.end);
      out.push({
        id: editId(src.path, m[1].startsWith('pdftitle') ? 'pdftitle' : 'title', ordinal++, m[2]),
        file: src.path,
        line: lineOf(src.text, start),
        before: line,
        after: line.slice(0, start - span.start) + newT + line.slice(end - span.start),
        start, end, insert: newT,
      });
    }
  }
  return out;
}
