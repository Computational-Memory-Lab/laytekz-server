import { describe, expect, it } from 'vitest';
import { at, inDoc } from '../../texContext/__tests__/helpers';
import { alignAfterFormat, alignTableAt, alignTablesIn, cellAt, tableAlignedAt, tableAt, tablesIn } from '../locate';
import type { Change } from '../align';

const apply = (src: string, changes: Change[]) => {
  let out = src;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
};

const DOC = inDoc([
  'Text.',
  '\\begin{tabular}{lr}',
  'a & 1 \\\\',
  'ccc & 100 \\\\',
  '\\end{tabular}',
  '% \\begin{tabular}{ll}',
  '\\begin{align}',
  'x &= 1 \\\\',
  'yyy &= 2',
  '\\end{align}',
].join('\n'));

describe('finding tables in the document (F4)', () => {
  it('finds the table at a position, its cell, and none outside one', () => {
    const { state } = at(DOC);
    const pos = DOC.indexOf('ccc');
    const t = tableAt(state, pos)!;
    expect(t.name).toBe('tabular');
    expect(cellAt(t.model, pos - t.from)).toEqual({ r: 1, c: 0 });
    expect(cellAt(t.model, DOC.indexOf('100') - t.from)).toEqual({ r: 1, c: 1 });
    expect(tableAt(state, DOC.indexOf('Text'))).toBeNull();
    expect(alignTableAt(state, DOC.indexOf('Text'))).toBeNull();
  });

  it('aligns the table at the cursor, or every table, skipping commented ones', () => {
    const { state } = at(DOC);
    expect(tablesIn(state).map((t) => t.name)).toEqual(['tabular', 'align']);
    const one = apply(DOC, alignTableAt(state, DOC.indexOf('ccc'))!);
    expect(one).toContain('a   &   1 \\\\\nccc & 100 \\\\');
    expect(one).toContain('x &= 1 \\\\\nyyy &= 2');
    const all = apply(DOC, alignTablesIn(state));
    expect(all).toContain('a   &   1 \\\\\nccc & 100 \\\\');
    expect(all).toContain('x   &= 1 \\\\\nyyy &= 2');
    expect(alignAfterFormat(at(all).state)).toBeNull();
    expect(tableAlignedAt(at(all).state, all.indexOf('ccc'))).toBe(true);
    expect(tableAlignedAt(state, DOC.indexOf('ccc'))).toBe(false);
  });
});
