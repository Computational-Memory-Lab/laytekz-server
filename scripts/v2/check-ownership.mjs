#!/usr/bin/env node
// Usage:
//   node scripts/v2/check-ownership.mjs <WP>            check a package before it reports done
//   node scripts/v2/check-ownership.mjs <WP> --list     print the package's own changed files (scratch-sync uses it)
//   node scripts/v2/check-ownership.mjs <WP> --strict   also fail on changes nobody in the wave owns (the integrator, before committing)
//   node scripts/v2/check-ownership.mjs --lint          check ownership.json itself (no two packages of a wave claim a file)
//
// Every agent works in the same two working trees, so a change cannot be
// pinned on whoever made it. A package's claim is the "## Files" list of its
// notes (docs/galley-v2/<WP>.md); the check fails when that list names a file
// outside the package's globs, or a frozen file. Changes no package of the
// wave owns are reported as stray (fatal with --strict): if one is not yours,
// say so in your report and leave it alone.

import {
  DESKTOP_PREFIX, DESKTOP_ROOT, SERVER_ROOT, changedFiles, isLiteral, loadOwnership, matchesGlobs,
  notesFiles, packagesOfWave, repoOf, trackedFiles,
} from './lib.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const wp = args.find((a) => !a.startsWith('--'));
const own = loadOwnership();

const ROOTS = { server: SERVER_ROOT, desktop: DESKTOP_ROOT };
const label = (repo, file) => (repo === 'desktop' ? DESKTOP_PREFIX + file : file);
const globsOf = (id, repo) => own.packages[id]?.[repo] ?? [];
const owns = (id, repo, file) => matchesGlobs(file, globsOf(id, repo));

function lint() {
  const problems = [];
  const ids = Object.keys(own.packages);
  for (let n = 1; n <= 45; n++) {
    const id = `WP${String(n).padStart(2, '0')}`;
    if (!own.packages[id]) problems.push(`${id} is missing`);
  }
  for (const id of ids) {
    const p = own.packages[id];
    if (!/^(WP\d\d|WPX\d)$/.test(id) || !p.slug || !p.wave) problems.push(`${id}: needs an id like WP07 (WPX1 outside the plan), a slug and a wave`);
    if (!p.server.includes(`docs/galley-v2/${id}.md`)) problems.push(`${id}: does not own its notes file`);
  }
  for (const repo of ['server', 'desktop']) {
    const files = new Set(trackedFiles(ROOTS[repo]));
    for (const c of changedFiles(ROOTS[repo]) ?? []) files.add(c.path);
    for (const id of ids) for (const g of globsOf(id, repo)) if (isLiteral(g)) files.add(g);
    for (const f of files) {
      if (!matchesGlobs(f, own.frozen[repo] ?? [])) continue;
      const claim = ids.filter((id) => id !== 'WP01' && owns(id, repo, f));
      if (claim.length) problems.push(`${label(repo, f)} is frozen but claimed by ${claim.join(', ')}`);
    }
    for (const wave of [...new Set(ids.map((id) => own.packages[id].wave))]) {
      const members = packagesOfWave(own, wave);
      for (const f of files) {
        const claim = members.filter((id) => owns(id, repo, f));
        if (claim.length > 1) problems.push(`wave ${wave}: ${label(repo, f)} is claimed by ${claim.join(' and ')}`);
      }
    }
  }
  return problems;
}

if (flags.has('--lint')) {
  const problems = lint();
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.log(problems.length ? `ownership.json: ${problems.length} problem(s)` : `ownership.json: OK (${Object.keys(own.packages).length} packages, no overlap within a wave)`);
  process.exit(problems.length ? 1 : 0);
}

if (!wp || !own.packages[wp]) {
  console.error(`usage: check-ownership.mjs <WP01…WP45|WPX1…> [--list|--strict]  |  --lint${wp ? `\nunknown package ${wp}` : ''}`);
  process.exit(2);
}

const pkg = own.packages[wp];
const peers = packagesOfWave(own, pkg.wave);
const frozen = (repo, f) => matchesGlobs(f, own.frozen[repo] ?? []) && !(wp === 'WP01');
const neverEdited = (repo, f) => matchesGlobs(f, own.neverEdited[repo] ?? []);

const changed = [];
for (const repo of ['server', 'desktop']) {
  const list = changedFiles(ROOTS[repo]);
  if (list === null) { if (repo === 'server') { console.error(`not a git repository: ${ROOTS[repo]}`); process.exit(2); } continue; }
  for (const c of list) changed.push({ repo, ...c });
}
const mine = changed.filter((c) => owns(wp, c.repo, c.path));

if (flags.has('--list')) {
  // One path per line; deleted files carry a leading '-' so a sync can remove them.
  for (const c of mine) console.log(`${c.deleted ? '-' : ''}${label(c.repo, c.path)}`);
  process.exit(0);
}

const errors = [];
const warnings = [];
const claimed = notesFiles(wp);
if (claimed === null) errors.push(`docs/galley-v2/${wp}.md does not exist: write your notes (docs/galley-v2/README.md says how)`);
for (const p of claimed ?? []) {
  const { repo, file } = repoOf(p);
  if (neverEdited(repo, file)) errors.push(`${p}: never edited in V2 (plan §2.7)`);
  else if (frozen(repo, file)) errors.push(`${p}: frozen; file a request instead (docs/galley-v2/README.md)`);
  else if (!owns(wp, repo, file)) errors.push(`${p}: listed in your notes but not owned by ${wp}`);
  else if (!changed.some((c) => c.repo === repo && c.path === file)) warnings.push(`${p}: listed in your notes but unchanged against HEAD`);
}
for (const c of mine) {
  const p = label(c.repo, c.path);
  if (claimed && !claimed.includes(p)) warnings.push(`${p}: changed, owned by ${wp}, but missing from the "## Files" list of your notes`);
}
const stray = changed.filter((c) => !peers.some((id) => owns(id, c.repo, c.path)));
for (const c of stray) {
  const p = label(c.repo, c.path);
  (flags.has('--strict') ? errors : warnings).push(`${p}: changed, but no package of wave ${pkg.wave} owns it${frozen(c.repo, c.path) ? ' (frozen)' : ''}`);
}

console.log(`${wp} ${pkg.slug} (wave ${pkg.wave}): ${mine.length} changed file(s) of its own; ${changed.length} changed in the trees`);
for (const w of warnings) console.log(`  ! ${w}`);
for (const e of errors) console.error(`  ✗ ${e}`);
if (errors.length) { console.error(`${wp}: ownership check FAILED`); process.exit(1); }
console.log(`${wp}: ownership check passed${warnings.length ? ' (see the warnings)' : ''}`);
