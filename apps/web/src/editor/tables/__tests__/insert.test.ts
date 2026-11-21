import { describe, expect, it } from 'vitest';
import { defaultRuleStyle, floatRefusal, insertRefusal, needsPackage, tableTemplate } from '../insert';
import { contextAt } from '../../texContext';
import { at, inDoc } from '../../texContext/__tests__/helpers';
import { alignTable } from '../align';

describe('the inserted table (F4)', () => {
  it('writes a booktabs float with the caption above, the header rule, and empty cells as fields', () => {
    const t = tableTemplate({ cols: 3, rows: 3, float: true, header: true, lines: 'booktabs', align: 'l' });
    expect(t.text).toBe([
      '\\begin{table}[htbp]',
      '  \\centering',
      '  \\caption{}',
      '  \\label{tab:}',
      '  \\begin{tabular}{lll}',
      '    \\toprule',
      '     &  &  \\\\',
      '    \\midrule',
      '     &  &  \\\\',
      '     &  &  \\\\',
      '    \\bottomrule',
      '  \\end{tabular}',
      '\\end{table}',
    ].join('\n'));
    expect(t.fields.map((f) => f.kind)).toEqual([...Array(9).fill('cell'), 'caption', 'label']);
    expect(t.text.slice(t.fields[9].from - 9, t.fields[9].from)).toBe('\\caption{');
    expect(t.text.slice(t.fields[10].from - 11, t.fields[10].from)).toBe('\\label{tab:');
    expect(t.firstCell).toBe(t.text.indexOf('     &') + 4);
    expect(t.text).not.toMatch(/\$\{|#\{|\\\{/);
  });

  it('writes \\hline rules, no rules, a bare tabular, and the indentation it is given', () => {
    expect(tableTemplate({ cols: 2, rows: 2, float: false, header: true, lines: 'hline', align: 'c' }).text)
      .toBe('\\begin{tabular}{cc}\n  \\hline\n   &  \\\\\n  \\hline\n   &  \\\\\n  \\hline\n\\end{tabular}');
    expect(tableTemplate({ cols: 2, rows: 1, float: false, header: true, lines: 'none', align: 'r', indent: '\t', unit: '\t' }).text)
      .toBe('\t\\begin{tabular}{rr}\n\t\t &  \\\\\n\t\\end{tabular}');
    // clamped to the picker's grid
    expect(tableTemplate({ cols: 40, rows: 0, float: false, header: false, lines: 'none', align: 'l' }).fields).toHaveLength(12);
  });

  it('is not changed by the aligner', () => {
    const t = tableTemplate({ cols: 4, rows: 3, float: false, header: true, lines: 'booktabs', align: 'l' });
    expect(alignTable(t.text)).toEqual([]);
  });

  it('adds booktabs only when needed, and picks the starting rule style', () => {
    expect(needsPackage('booktabs', new Set())).toBe(true);
    expect(needsPackage('booktabs', new Set(['booktabs']))).toBe(false);
    expect(needsPackage('hline', new Set())).toBe(false);
    expect(defaultRuleStyle(new Set(['booktabs']), false)).toBe('booktabs');
    expect(defaultRuleStyle(new Set(), true)).toBe('booktabs');
    expect(defaultRuleStyle(new Set(), false)).toBe('hline');
  });

  it('refuses math, comments and verbatim, and allows only a bare tabular inside a float or a table', () => {
    const ctx = (src: string) => { const { state, pos } = at(inDoc(src)); return contextAt(state, pos); };
    expect(insertRefusal(ctx('Text ¦ here'))).toBeNull();
    expect(insertRefusal(ctx('$x¦$'))).toMatch(/inside a formula/);
    expect(insertRefusal(ctx('% a ¦ comment'))).toMatch(/comment/);
    expect(insertRefusal(ctx('\\begin{verbatim}\n¦\n\\end{verbatim}'))).toMatch(/exactly as written/);
    expect(floatRefusal(ctx('Text ¦ here'))).toBeNull();
    expect(floatRefusal(ctx('\\begin{figure}\n¦\n\\end{figure}'))).toMatch(/bare tabular/);
    expect(floatRefusal(ctx('\\begin{tabular}{ll}\na & ¦ \\\\\n\\end{tabular}'))).toMatch(/bare tabular/);
  });
});
