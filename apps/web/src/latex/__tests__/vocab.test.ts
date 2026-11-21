import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as vocab from '../vocab';
import { MATH_FUNCTIONS, UNICODE_MATH } from '../../editor/visual/html2latex';

/**
 * The vocabulary has a byte-identical twin on the server (the web image
 * builds from apps/web alone, and NodeNext cannot import across the apps).
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)));

const LISTS = [
  'MATH_ENVIRONMENTS', 'INNER_MATH_ENVIRONMENTS', 'VERBATIM_ENVIRONMENTS', 'CODE_ENVIRONMENTS', 'THEOREM_ENVIRONMENTS',
  'FLOAT_ENVIRONMENTS', 'LIST_ENVIRONMENTS', 'TEXT_ENVIRONMENTS', 'CITE_COMMANDS', 'REF_COMMANDS', 'LABEL_COMMANDS',
  'TEXT_IN_MATH_COMMANDS', 'MONO_COMMANDS', 'VERBATIM_READ_COMMANDS', 'PREAMBLE_TEXT_COMMANDS', 'MATH_OPERATOR_NAMES',
  'GREEK_LETTERS', 'MATH_ONLY_COMMANDS',
] as const;

describe('the LaTeX vocabulary', () => {
  it('is byte-identical to the server copy and imports nothing', () => {
    const web = read('../vocab.ts');
    const server = read('../../../../server/src/latex/vocab.ts');
    expect(Buffer.compare(web, server)).toBe(0);
    expect(web.toString('utf8')).not.toMatch(/^\s*import\s/m);
  });

  it('lists bare names once each', () => {
    for (const name of LISTS) {
      const list = vocab[name];
      expect(list.length, name).toBeGreaterThan(0);
      expect(new Set(list).size, `${name} has a duplicate`).toBe(list.length);
      for (const n of list) expect(n, name).toMatch(/^[A-Za-z@]+\*?$/);
    }
  });

  it('gives every table environment a family, and argument signatures only to table environments', () => {
    for (const family of Object.values(vocab.TABLE_ENVIRONMENTS)) expect(['tabular', 'array', 'align']).toContain(family);
    for (const [env, sig] of Object.entries(vocab.TABLE_ENVIRONMENT_ARGS)) {
      expect(vocab.TABLE_ENVIRONMENTS, env).toHaveProperty([env]);
      expect(sig).toMatch(/^[{[]*$/);
    }
    expect(vocab.TABLE_ENVIRONMENTS.tblr).toBe('tabular');
    expect(vocab.TABLE_ENVIRONMENTS.pmatrix).toBe('array');
    expect(vocab.TABLE_ENVIRONMENTS['align*']).toBe('align');
    expect(Object.keys(vocab.TABLE_ENVIRONMENTS)).not.toContain('gather');
  });

  it('writes argument roles with role letters only', () => {
    for (const [name, roles] of [...Object.entries(vocab.COMMAND_ARGS), ...Object.entries(vocab.ENVIRONMENT_ARGS)]) {
      expect(roles, name).toMatch(/^[UPKRLGECNDOXVTM]+$/i);
    }
    expect(vocab.COMMAND_ARGS.parencite).toBe('ttK');
    expect(vocab.COMMAND_ARGS.eqref).toBe('R');
    expect(vocab.COMMAND_ARGS.title).toBe('tT');
    expect(vocab.COMMAND_ARGS.newcommand).toBe('NooD');
  });

  it('keeps citation and reference commands apart', () => {
    const cites = new Set(vocab.CITE_COMMANDS);
    expect(vocab.REF_COMMANDS.filter((r) => cites.has(r))).toEqual([]);
  });

  it('knows every operator name and Greek letter the Visual paste converts', () => {
    const names = new Set(vocab.MATH_OPERATOR_NAMES);
    for (const n of MATH_FUNCTIONS.source.replace(/^\^\(\?:|\)\$$/g, '').split('|')) expect(names.has(n), n).toBe(true);
    const greek = new Set(vocab.GREEK_LETTERS);
    for (const cmd of Object.values(UNICODE_MATH).filter((c) => /^\\[A-Za-z]+$/.test(c))) {
      const name = cmd.slice(1);
      if (/^(var)?[a-z]*(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)$/i.test(name)) {
        expect(greek.has(name), name).toBe(true);
      }
    }
  });
});
