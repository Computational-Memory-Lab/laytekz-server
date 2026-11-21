/**
 * The shared LaTeX vocabulary (src/latex/vocab.ts) has a byte-identical twin
 * in the web app (apps/web/src/latex/vocab.ts): the web image builds from
 * apps/web alone and NodeNext cannot import across the apps. This checks the
 * twin, that the server copy loads under the server's own toolchain, and the
 * invariants consumers rely on.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { check, eq } from './assert.mjs';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
const server = read('../src/latex/vocab.ts');
const web = read('../../web/src/latex/vocab.ts');
check(Buffer.compare(server, web) === 0, 'apps/server/src/latex/vocab.ts and apps/web/src/latex/vocab.ts must be byte-identical');
check(!/^\s*import\s/m.test(server.toString('utf8')), 'the vocabulary imports nothing');

const v = await import('../src/latex/vocab.ts');

const lists = [
  'MATH_ENVIRONMENTS', 'INNER_MATH_ENVIRONMENTS', 'VERBATIM_ENVIRONMENTS', 'CODE_ENVIRONMENTS', 'THEOREM_ENVIRONMENTS',
  'FLOAT_ENVIRONMENTS', 'LIST_ENVIRONMENTS', 'TEXT_ENVIRONMENTS', 'CITE_COMMANDS', 'REF_COMMANDS', 'LABEL_COMMANDS',
  'TEXT_IN_MATH_COMMANDS', 'MONO_COMMANDS', 'VERBATIM_READ_COMMANDS', 'PREAMBLE_TEXT_COMMANDS', 'MATH_OPERATOR_NAMES',
  'GREEK_LETTERS', 'MATH_ONLY_COMMANDS',
];
const NAME = /^[A-Za-z@]+\*?$/;
for (const name of lists) {
  const list = v[name];
  check(Array.isArray(list) && list.length > 0, `${name} is a non-empty list`);
  eq(list.length, new Set(list).size, `${name} has no duplicates`);
  for (const n of list) check(NAME.test(n), `${name}: '${n}' is a bare name (no backslash)`);
}

for (const [env, family] of Object.entries(v.TABLE_ENVIRONMENTS)) {
  check(['tabular', 'array', 'align'].includes(family), `TABLE_ENVIRONMENTS.${env} has a known family`);
}
for (const [env, sig] of Object.entries(v.TABLE_ENVIRONMENT_ARGS)) {
  check(env in v.TABLE_ENVIRONMENTS, `TABLE_ENVIRONMENT_ARGS.${env} is a table environment`);
  check(/^[{[]*$/.test(sig), `TABLE_ENVIRONMENT_ARGS.${env} is made of { and [`);
}
for (const [name, roles] of [...Object.entries(v.COMMAND_ARGS), ...Object.entries(v.ENVIRONMENT_ARGS)]) {
  check(/^[UPKRLGECNDOXVTMupkrlgecndoxvtm]+$/.test(roles), `${name}: '${roles}' uses only role letters`);
}

const cites = new Set(v.CITE_COMMANDS);
for (const r of v.REF_COMMANDS) check(!cites.has(r), `${r} is a citation command and a reference command`);
eq(v.COMMAND_ARGS.citep, 'ttK', 'a citation command takes notes and keys');
eq(v.COMMAND_ARGS.cref, 'R', 'a reference command takes keys');
eq(v.TABLE_ENVIRONMENTS['tabular*'], 'tabular', 'tabular* is a text table');
eq(v.TABLE_ENVIRONMENTS.aligned, 'align', 'aligned aligns equations');
check(!('gather' in v.TABLE_ENVIRONMENTS), 'gather has no cells');
eq(v.SECTIONING_LEVELS.subsection, 2, 'subsection is level 2');

console.log('vocab-twin: ok');
