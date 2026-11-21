/**
 * The vocabulary (latex/vocab.ts) as the lookups texContext makes: sets,
 * argument roles, and the names of grammar nodes that already say what an
 * argument holds. Lookups go through Maps so a command named `constructor`
 * never reads Object.prototype.
 */
import {
  CITE_COMMANDS, CODE_ENVIRONMENTS, COMMAND_ARGS, ENVIRONMENT_ARGS, FLOAT_ENVIRONMENTS,
  INNER_MATH_ENVIRONMENTS, LIST_ENVIRONMENTS, MATH_ENVIRONMENTS, MONO_COMMANDS, PREAMBLE_TEXT_COMMANDS,
  TABLE_ENVIRONMENTS, TABLE_ENVIRONMENT_ARGS, TEXT_ENVIRONMENTS, TEXT_IN_MATH_COMMANDS, THEOREM_ENVIRONMENTS,
  VERBATIM_ENVIRONMENTS, VERBATIM_READ_COMMANDS,
} from '../../latex/vocab';
import type { ArgKind, TableFamily } from './types';

export const MATH_ENVS: ReadonlySet<string> = new Set(MATH_ENVIRONMENTS);
export const INNER_MATH_ENVS: ReadonlySet<string> = new Set(INNER_MATH_ENVIRONMENTS);
export const VERBATIM_ENVS: ReadonlySet<string> = new Set(VERBATIM_ENVIRONMENTS);
export const CODE_ENVS: ReadonlySet<string> = new Set(CODE_ENVIRONMENTS);
export const THEOREM_ENVS: ReadonlySet<string> = new Set(THEOREM_ENVIRONMENTS);
export const TEXT_IN_MATH: ReadonlySet<string> = new Set(TEXT_IN_MATH_COMMANDS);
export const MONO: ReadonlySet<string> = new Set(MONO_COMMANDS);
export const VERBATIM_READ: ReadonlySet<string> = new Set(VERBATIM_READ_COMMANDS);
export const PREAMBLE_TEXT: ReadonlySet<string> = new Set(PREAMBLE_TEXT_COMMANDS);
const CITES: ReadonlySet<string> = new Set(CITE_COMMANDS);

const TABLES: ReadonlyMap<string, TableFamily> = new Map(Object.entries(TABLE_ENVIRONMENTS));
const TABLE_ARGS: ReadonlyMap<string, string> = new Map(Object.entries(TABLE_ENVIRONMENT_ARGS));
const COMMANDS: ReadonlyMap<string, string> = new Map(Object.entries(COMMAND_ARGS));
const ENVIRONMENTS: ReadonlyMap<string, string> = new Map(Object.entries(ENVIRONMENT_ARGS));

/** Environments the vocabulary knows to hold no cells: the name heuristic never applies to them. */
const KNOWN_NON_TABLE: ReadonlySet<string> = new Set([
  ...TEXT_ENVIRONMENTS, ...FLOAT_ENVIRONMENTS, ...LIST_ENVIRONMENTS, ...THEOREM_ENVIRONMENTS,
  ...VERBATIM_ENVIRONMENTS, ...CODE_ENVIRONMENTS, ...MATH_ENVIRONMENTS, ...INNER_MATH_ENVIRONMENTS,
]);

/** An unknown environment named like a table environment (`mytabular`, `longtblr`), but not like a float (`mytable`). */
const TABLE_LIKE_NAME = /tab(?!le)|tbl/i;

export function vocabTableFamily(name: string): TableFamily | null {
  return TABLES.get(name) ?? null;
}

export function tableArgsSignature(name: string): string | null {
  return TABLE_ARGS.get(name) ?? null;
}

/** Whether the vocabulary knows `name` as an environment without cells (math, verbatim, floats, lists, prose). */
export function knownNonTable(name: string): boolean {
  return !TABLES.has(name) && KNOWN_NON_TABLE.has(name);
}

/** Whether the name heuristic may call `name` a tabular. */
export function tableLikeName(name: string): boolean {
  return !KNOWN_NON_TABLE.has(name) && TABLE_LIKE_NAME.test(name);
}

export function isMathEnvName(name: string): boolean {
  return MATH_ENVS.has(name) || INNER_MATH_ENVS.has(name);
}

export function stripStar(name: string): string {
  return name.endsWith('*') ? name.slice(0, -1) : name;
}

/** U url · P path · K cite key · R ref key · L label · G package · E env name · C colour ·
 *  N defined name · D definition · O option · X package-read value · V verbatim · T text · M math. */
export type Role = 'U' | 'P' | 'K' | 'R' | 'L' | 'G' | 'E' | 'C' | 'N' | 'D' | 'O' | 'X' | 'V' | 'T' | 'M';

/** The `k`th mandatory (or optional) argument's role in a vocabulary role string; the last letter repeats. */
export function pickRole(spec: string | undefined, optional: boolean, k: number): Role | null {
  if (!spec) return null;
  const letters: string[] = [];
  for (const c of spec) if ((c >= 'a' && c <= 'z') === optional) letters.push(c);
  if (!letters.length) return null;
  return letters[Math.min(k, letters.length - 1)].toUpperCase() as Role;
}

/** A natbib/biblatex-style citation command the vocabulary does not list (`\citeyearNP`); `\citetext` is prose. */
const CITE_NAME = /^[a-zA-Z]*[cC]ite[a-zA-Z]*$/;

export function commandRole(base: string, optional: boolean, k: number): Role | null {
  const listed = pickRole(COMMANDS.get(base), optional, k);
  if (listed) return listed;
  if (!CITES.has(base) && base !== 'citetext' && CITE_NAME.test(base)) return optional ? 'T' : 'K';
  return null;
}

export function environmentRole(name: string, optional: boolean, k: number, theorem: boolean): Role {
  const listed = pickRole(ENVIRONMENTS.get(name), optional, k);
  if (listed) return listed;
  if (optional && theorem) return 'T';
  return 'O';
}

/** Grammar nodes on an argument's wrapper chain that fix its role, whatever the command. */
const GRAMMAR_ROLES: ReadonlyMap<string, Role> = new Map<string, Role>([
  ['UrlArgument', 'U'], ['FilePathArgument', 'P'], ['BareFilePathArgument', 'P'], ['BibKeyArgument', 'K'],
  ['RefArgument', 'R'], ['LabelArgument', 'L'], ['PackageArgument', 'G'], ['DocumentClassArgument', 'G'],
  ['DefinitionArgument', 'D'], ['DefinitionFragmentArgument', 'D'], ['TabularArgument', 'T'],
  ['SectioningArgument', 'T'], ['SpanArgument', 'O'], ['ColumnArgument', 'O'],
  ['VerbContent', 'V'], ['LstInlineContent', 'V'],
]);

export function grammarRole(names: readonly string[]): Role | null {
  for (const n of names) {
    const r = GRAMMAR_ROLES.get(n);
    if (r) return r;
  }
  return null;
}

export const ROLE_ARG_KIND: Readonly<Partial<Record<Role, ArgKind>>> = {
  U: 'url', P: 'path', K: 'cite-key', R: 'ref-key', L: 'label', G: 'package', E: 'env-name', C: 'color',
  N: 'definition', D: 'definition', O: 'option', X: 'option', T: 'text',
};

/** The chip's word for a literal argument. */
export function literalDetail(role: Role, base: string): string {
  switch (role) {
    case 'U': return base === 'email' ? 'email' : 'URL';
    case 'P': return 'path';
    case 'K': return 'citation key';
    case 'R': return 'reference key';
    case 'L': return 'label';
    case 'G': return base === 'documentclass' || base === 'LoadClass' ? 'class' : 'package';
    case 'E': return 'environment name';
    case 'C': return 'color';
    default: return VALUE_DETAIL.get(base) ?? 'value';
  }
}

const VALUE_DETAIL: ReadonlyMap<string, string> = new Map([
  ['ce', 'chemistry'], ['pu', 'chemistry'],
  ...['SI', 'si', 'qty', 'unit', 'num', 'ang', 'SIrange', 'numrange', 'qtyrange', 'SIlist', 'numlist', 'qtylist', 'tablenum']
    .map((n): [string, string] => [n, 'units']),
  ...['gls', 'Gls', 'glspl', 'Glspl', 'acrshort', 'acrlong', 'acrfull', 'ac', 'acs', 'acl', 'acp']
    .map((n): [string, string] => [n, 'glossary key']),
]);
