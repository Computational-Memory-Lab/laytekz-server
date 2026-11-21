import { describe, expect, it } from 'vitest';
import { TABLE_ENVIRONMENTS } from '../../../latex/vocab';
import { TABLE_FAMILY_NAMES, familyInfo } from '../families';
import { tableModelFromSource } from '../model';
import { displayWidth } from '../width';

describe('table families (F4)', () => {
  it('covers every table environment in the vocabulary, each one read without its arguments as cells', () => {
    expect(TABLE_FAMILY_NAMES.length).toBe(Object.keys(TABLE_ENVIRONMENTS).length);
    for (const name of TABLE_FAMILY_NAMES) {
      const info = familyInfo(name)!;
      expect(info, name).not.toBeNull();
      expect(info.family).toBe(TABLE_ENVIRONMENTS[name]);
      // every argument the signature names, filled in, then two rows
      const args = [...info.args].map((a) => (a === '{' ? '{ll}' : '[t]')).join('');
      const model = tableModelFromSource(`\\begin{${name}}${args}\na & b \\\\\nc & d\n\\end{${name}}`)!;
      expect(model, name).not.toBeNull();
      expect(model.rows.map((r) => r.map((c) => c.text)), name).toEqual([['a', 'b'], ['c', 'd']]);
    }
  });

  it('pads text tables by spec, tabularray and math left, and keeps the spaces after & in equation alignment', () => {
    expect(familyInfo('tabular')).toMatchObject({ justify: 'spec', specArg: 1, keepAfterAmp: false });
    expect(familyInfo('tabular*')).toMatchObject({ specArg: 2 });
    expect(familyInfo('tblr')).toMatchObject({ justify: 'left' });
    expect(familyInfo('pmatrix')).toMatchObject({ family: 'array', justify: 'left', specArg: -1 });
    expect(familyInfo('array')).toMatchObject({ specArg: 1 });
    expect(familyInfo('alignat')).toMatchObject({ family: 'align', specArg: -1, keepAfterAmp: true });
    expect(familyInfo('equation')).toBeNull();
    expect(familyInfo('mytabular')).toBeNull();
    expect(familyInfo('mytabular', 'tabular')).toMatchObject({ args: '[{', specArg: 1 });
  });
});

describe('display width', () => {
  it('counts monospace columns', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('\u00e9')).toBe(1);
    expect(displayWidth('e\u0301')).toBe(1);
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('\u{1F44D}\u{1F3FD}')).toBe(2);
    expect(displayWidth('\u{1F468}\u200d\u{1F469}\u200d\u{1F467}')).toBe(2);
    expect(displayWidth('ＡＢ')).toBe(4);
  });
});
