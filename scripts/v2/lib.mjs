// Shared helpers for the V2 tooling (scripts/v2). Node built-ins only, so the
// scripts run anywhere the repository is checked out, with no install.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** server-v2's root (this file is scripts/v2/lib.mjs). */
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** desktop-v2 sits beside server-v2 unless V2_DESKTOP says otherwise. */
export const DESKTOP_ROOT = path.resolve(process.env.V2_DESKTOP || path.join(SERVER_ROOT, '..', 'desktop-v2'));
/** The prefix that marks a desktop-v2 path in notes files and in --list output. */
export const DESKTOP_PREFIX = 'desktop-v2/';

export function loadOwnership() {
  return JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'scripts/v2/ownership.json'), 'utf8'));
}

function expandBraces(p) {
  const m = /\{([^{}]*)\}/.exec(p);
  if (!m) return [p];
  return m[1].split(',').flatMap((alt) => expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length)));
}

function toRegExp(p) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const cache = new Map();
/** A glob as regular expressions: `*` stops at '/', `**` crosses it, `?`, `{a,b}`. */
export function globRegExps(glob) {
  let r = cache.get(glob);
  if (!r) { r = expandBraces(glob).map(toRegExp); cache.set(glob, r); }
  return r;
}

/** Whether `file` is matched by the positive globs and by none of the '!' ones. */
export function matchesGlobs(file, globs) {
  let hit = false;
  for (const g of globs) {
    if (g.startsWith('!')) { if (globRegExps(g.slice(1)).some((r) => r.test(file))) return false; }
    else if (!hit && globRegExps(g).some((r) => r.test(file))) hit = true;
  }
  return hit;
}

/** A glob without wildcards names one file. */
export const isLiteral = (g) => !g.startsWith('!') && !/[*?{]/.test(g);

/**
 * Paths changed in a repository's working tree against HEAD (modified, added,
 * deleted, renamed both ways, untracked), relative to its root; null when the
 * directory is not a git repository.
 */
export function changedFiles(root) {
  let out;
  try {
    out = execFileSync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2);
    files.push({ path: e.slice(3), status: xy.trim() || xy, deleted: xy.includes('D') });
    if (xy[0] === 'R' || xy[0] === 'C') { i++; files.push({ path: parts[i], status: 'R-', deleted: true }); }
  }
  return files;
}

/** Files git tracks in a repository (for overlap checks). */
export function trackedFiles(root) {
  try {
    return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

/** The packages of a wave ('0.0', '0', '1', …). */
export function packagesOfWave(own, wave) {
  return Object.entries(own.packages).filter(([, p]) => p.wave === wave).map(([id]) => id);
}

/**
 * The paths listed under "## Files" in docs/galley-v2/<WP>.md: the first
 * backticked token of each bullet. A desktop path starts with 'desktop-v2/'.
 * null when the notes file does not exist.
 */
export function notesFiles(wp) {
  const file = path.join(SERVER_ROOT, 'docs/galley-v2', `${wp}.md`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const out = [];
  let inFiles = false;
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line)) { inFiles = /^##\s+Files\b/i.test(line); continue; }
    if (!inFiles) continue;
    const m = /^\s*[-*]\s+`([^`]+)`/.exec(line);
    if (m) out.push(m[1].replace(/^server-v2\//, ''));
  }
  return out;
}

/** Split a notes/--list path into its repository and repo-relative path. */
export function repoOf(p) {
  return p.startsWith(DESKTOP_PREFIX) ? { repo: 'desktop', file: p.slice(DESKTOP_PREFIX.length) } : { repo: 'server', file: p };
}
