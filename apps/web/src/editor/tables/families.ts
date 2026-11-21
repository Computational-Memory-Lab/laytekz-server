import { TABLE_ENVIRONMENTS, TABLE_ENVIRONMENT_ARGS } from '../../latex/vocab';
import type { TableFamilyName } from '../../latex/vocab';

/**
 * The table-like environments the aligner and the table operations know:
 * each one's family and the arguments after `\begin{name}`, read from the
 * shared vocabulary (latex/vocab.ts), so typing, tables and the server agree
 * on one list.
 *
 * - `tabular`: text tables; cells are padded by the column spec (r right, c
 *   centred, anything else left), except tabularray's `tblr` family, whose
 *   spec is key-value and is padded left.
 * - `array`: math arrays, matrices, cases; padded left.
 * - `align`: equation alignment; only the spaces before each `&` are padded,
 *   never the ones after it, so `&=` and `& \quad` stay as typed.
 */
export type TableFamily = TableFamilyName;

export interface FamilyInfo {
  name: string;
  family: TableFamily;
  /** the arguments after \begin{name}: `{` mandatory, `[` optional */
  args: string;
  /** which of `args` is the column spec, or -1 when the environment has none */
  specArg: number;
  /** how cells are padded: by the column spec, or always left */
  justify: 'spec' | 'left';
  /** the spaces after `&` are kept as typed (equation alignment) */
  keepAfterAmp: boolean;
}

/** tabularray's environments: the column spec is key-value (`colspec={…}`), so it says nothing about padding. */
const KEY_VALUE_SPEC = /^(?:tblr|longtblr|talltblr)$/;

/** Every environment the vocabulary lists as table-like. */
export const TABLE_FAMILY_NAMES: readonly string[] = Object.keys(TABLE_ENVIRONMENTS);

/**
 * What the aligner needs to know about environment `name`. `family`: the
 * family when the caller already knows it (an unknown, user-listed or
 * wrapper environment from texContext's tableEnvAt); such an environment
 * reads like `tabular` (`[{`). Null for an environment that has no cells.
 */
export function familyInfo(name: string, family?: TableFamily | null): FamilyInfo | null {
  const fam = TABLE_ENVIRONMENTS[name] ?? family ?? null;
  if (!fam) return null;
  const known = name in TABLE_ENVIRONMENTS;
  const args = TABLE_ENVIRONMENT_ARGS[name] ?? (known ? '' : fam === 'tabular' ? '[{' : '');
  // the spec is the last mandatory argument of a text table or of an array
  // (alignat's mandatory argument is a column count, not a spec)
  const hasSpec = fam === 'tabular' || /Array$|^array$/.test(name);
  const specArg = hasSpec ? args.lastIndexOf('{') : -1;
  return {
    name,
    family: fam,
    args,
    specArg,
    justify: fam === 'tabular' && !KEY_VALUE_SPEC.test(name) ? 'spec' : 'left',
    keepAfterAmp: fam === 'align',
  };
}
