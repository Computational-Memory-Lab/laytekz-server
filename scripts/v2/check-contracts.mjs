#!/usr/bin/env node
// Usage: node scripts/v2/check-contracts.mjs
//
// Static consistency of the V2 contracts that no type checker sees across the
// two apps and the desktop shell: the feature id lists, the manifests, the
// stub files, the settings registry imports, the shell feature list, the
// vocabulary twin (once WP08 adds it) and ownership.json. Exits 1 on a problem.

import fs from 'node:fs';
import path from 'node:path';
import { DESKTOP_ROOT, SERVER_ROOT } from './lib.mjs';

const problems = [];
const read = (root, p) => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return null; } };
const exists = (root, p) => fs.existsSync(path.join(root, p));

function idsFrom(file) {
  const src = read(SERVER_ROOT, file);
  const m = src && /FEATURE_IDS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src);
  if (!m) { problems.push(`${file}: no FEATURE_IDS list`); return []; }
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const webIds = idsFrom('apps/web/src/features/types.ts');
const srvIds = idsFrom('apps/server/src/features/types.ts');
if (webIds.join() !== srvIds.join()) problems.push(`FEATURE_IDS differ: web [${webIds}] server [${srvIds}]`);
if (new Set(webIds).size !== webIds.length) problems.push('FEATURE_IDS has a duplicate');

const imported = (file, re) => [...(read(SERVER_ROOT, file) ?? '').matchAll(re)].map((m) => m[1]);
const webManifest = imported('apps/web/src/features/manifest.ts', /^import (?!type )\w+ from '\.\/([^/']+)'/gm);
const srvManifest = imported('apps/server/src/features/index.ts', /from '\.\/([^/']+)\/server\.js'/g);
const registry = imported('apps/web/src/settings/registry/index.ts', /from '\.\.\/\.\.\/features\/([^/']+)\/settings'/g);
if (webManifest.join() !== webIds.join()) problems.push(`web manifest imports [${webManifest}], expected FEATURE_IDS order`);
if (srvManifest.join() !== webIds.join()) problems.push(`server manifest imports [${srvManifest}], expected FEATURE_IDS order`);
if (registry.join() !== webIds.join()) problems.push(`settings registry imports [${registry}], expected every features/<id>/settings in FEATURE_IDS order`);

for (const id of webIds) {
  for (const f of [`apps/web/src/features/${id}/index.ts`, `apps/web/src/features/${id}/settings.ts`, `apps/server/src/features/${id}/server.ts`]) {
    const src = read(SERVER_ROOT, f);
    if (src === null) problems.push(`${f} is missing`);
    else if (!f.endsWith('settings.ts') && !src.includes(`id: '${id}'`)) problems.push(`${f} does not declare id '${id}'`);
  }
  const settings = read(SERVER_ROOT, `apps/web/src/features/${id}/settings.ts`) ?? '';
  // The registry loads every settings.ts on every page: no runtime import of
  // UI, CodeMirror or the store (a cycle). Type imports and dynamic import() are fine.
  const bad = /^import\s+(?!type\s)[^;]*?from\s+'(react|react-dom|@codemirror\/[^']*|[^']*settings\/store|[^']*\.tsx)'/m.exec(settings);
  if (bad) problems.push(`features/${id}/settings.ts imports '${bad[1]}' at run time: settings files are pure data`);
}
for (const dir of fs.readdirSync(path.join(SERVER_ROOT, 'apps/web/src/features'), { withFileTypes: true })) {
  if (dir.isDirectory() && !dir.name.startsWith('__') && !webIds.includes(dir.name)) problems.push(`apps/web/src/features/${dir.name}/ is not a feature id`);
}

// desktop-v2 sits beside server-v2 on the Mac only; a scratch tree on the build machine has none.
const hasDesktop = fs.existsSync(DESKTOP_ROOT);
const shell = hasDesktop ? read(DESKTOP_ROOT, 'src/main/features/index.js') : null;
if (hasDesktop && shell === null) problems.push(`${DESKTOP_ROOT}/src/main/features/index.js is missing`);
else if (shell !== null) {
  const ids = [...shell.matchAll(/from '\.\/([^/']+)\/index\.js'/g)].map((m) => m[1]);
  for (const id of ids) {
    const src = read(DESKTOP_ROOT, `src/main/features/${id}/index.js`);
    if (src === null) problems.push(`desktop-v2/src/main/features/${id}/index.js is missing`);
    else if (!src.includes(`id: '${id}'`)) problems.push(`desktop-v2/src/main/features/${id}/index.js does not declare id '${id}'`);
    else if (/^import\s[^;]*from 'electron'/m.test(src)) problems.push(`desktop-v2/src/main/features/${id}/index.js imports electron at its top level`);
  }
}

const webVocab = read(SERVER_ROOT, 'apps/web/src/latex/vocab.ts');
const srvVocab = read(SERVER_ROOT, 'apps/server/src/latex/vocab.ts');
if ((webVocab === null) !== (srvVocab === null)) problems.push('latex/vocab.ts exists in one app only (the twin must be byte-identical)');
else if (webVocab !== null && webVocab !== srvVocab) problems.push('apps/web/src/latex/vocab.ts and apps/server/src/latex/vocab.ts differ (they must be byte-identical)');

const own = JSON.parse(read(SERVER_ROOT, 'scripts/v2/ownership.json') ?? '{}');
// A late feature stays reserved until a package (WPX<n>) owns its web directory.
const ownedLate = (id) => Object.values(own.packages ?? {}).some((p) => (p.server ?? []).includes(`apps/web/src/features/${id}/**`));
for (const id of ['pdfComments', 'refManagers']) if (!webIds.includes(id) || !(own.reserved?.[id] || ownedLate(id))) problems.push(`late feature '${id}' is missing from FEATURE_IDS, or neither reserved nor owned in ownership.json`);
const planned = Object.keys(own.packages ?? {}).filter((id) => /^WP\d\d$/.test(id)).length;
if (planned !== 45) problems.push(`ownership.json lists ${planned} planned packages (WP01…WP45), not 45`);
if (!exists(SERVER_ROOT, 'docs/galley-v2/README.md')) problems.push('docs/galley-v2/README.md is missing');

for (const p of problems) console.error(`  ✗ ${p}`);
console.log(problems.length ? `contracts: ${problems.length} problem(s)` : `contracts: OK (${webIds.length} feature ids, both manifests, the registry, ${shell ? 'the shell list' : 'desktop-v2 not present, shell list not checked'})`);
process.exit(problems.length ? 1 : 0);
