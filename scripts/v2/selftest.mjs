#!/usr/bin/env node
// Usage: node scripts/v2/selftest.mjs
// Tests the glob matcher the ownership tooling relies on, then runs the
// manifest lint and the contract check.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesGlobs } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (cond, what) => { if (!cond) { failed++; console.error(`  ✗ ${what}`); } };

const W = 'apps/web/src/';
check(matchesGlobs(`${W}settings/store.ts`, [`${W}settings/**`, `!${W}settings/types.ts`]), '** covers a direct child');
check(matchesGlobs(`${W}settings/registry/core.ts`, [`${W}settings/**`]), '** covers a grandchild');
check(!matchesGlobs(`${W}settings/types.ts`, [`${W}settings/**`, `!${W}settings/types.ts`]), '! removes a file');
check(!matchesGlobs(`${W}settings/registry/index.ts`, [`${W}settings/**`, `!${W}settings/registry/index.ts`]), '! removes a nested file');
check(matchesGlobs(`${W}features/escape/index.ts`, [`${W}features/*/index.ts`]), '* matches one segment');
check(!matchesGlobs(`${W}features/escape/ui/index.ts`, [`${W}features/*/index.ts`]), '* stops at /');
check(matchesGlobs(`${W}components/PdfPane.tsx`, [`${W}components/{CodePane,PdfPane}.tsx`]), '{a,b} expands');
check(!matchesGlobs(`${W}components/Pane.tsx`, [`${W}components/{CodePane,PdfPane}.tsx`]), '{a,b} is exact');
check(matchesGlobs('e2e/tests/205-editor-host.spec.ts', ['e2e/tests/205-*.spec.ts']), 'spec numbering');
check(!matchesGlobs('e2e/tests/2050-x.spec.ts', ['e2e/tests/205-*.spec.ts']), 'spec numbering is exact');
check(matchesGlobs(`${W}features/suggest/ghost.ts`, [`${W}features/suggest/**`, `!${W}features/suggest/model/**`]), 'negated subtree keeps siblings');
check(!matchesGlobs(`${W}features/suggest/model/worker.ts`, [`${W}features/suggest/**`, `!${W}features/suggest/model/**`]), 'negated subtree');
check(matchesGlobs('a.b/c', ['a.b/c']) && !matchesGlobs('aXb/c', ['a.b/c']), 'dots are literal');
check(matchesGlobs(`${W}editor/__tests__/spellcheck.test.ts`, [`${W}editor/__tests__/spellcheck*`]), 'prefix glob');

for (const script of [['check-ownership.mjs', '--lint'], ['check-contracts.mjs']]) {
  try { execFileSync(process.execPath, [path.join(here, script[0]), ...script.slice(1)], { stdio: 'inherit' }); }
  catch { failed++; console.error(`  ✗ ${script.join(' ')} failed`); }
}
console.log(failed ? `selftest: ${failed} failure(s)` : 'selftest: OK');
process.exit(failed ? 1 : 0);
