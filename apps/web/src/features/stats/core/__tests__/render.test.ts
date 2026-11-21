import { describe, expect, it } from 'vitest';
import { entryById } from '../catalogue';
import { greekMode, render, sample, textToMath } from '../render';
import { APA7, type StatsStyle } from '../style';

const e = (id: string) => entryById(id)!;
const style = (o: Partial<StatsStyle>): StatsStyle => ({ ...APA7, ...o });

describe('rendering a statistic', () => {
  it('formats the values and reports the field ranges', () => {
    const r = render(e('ttest'), { values: { df: '17.776', t: '-1.8608', p: '0.07939' } });
    expect(r.text).toBe('$t(17.78) = -1.86$, $p = .079$');
    expect(r.fields.map((f) => [f.label, r.text.slice(f.from, f.to)])).toEqual([['df', '17.78'], ['t', '-1.86'], ['p', '= .079']]);
  });

  it('leaves empty fields empty, with prefilled levels', () => {
    const r = render(e('ci'));
    expect(r.text).toBe('95\\%~CI~$[, ]$');
    expect(r.fields.map((f) => f.label)).toEqual(['level', 'lower', 'upper']);
    expect(r.fields[1].from).toBe(r.fields[1].to);
  });

  it('prunes empty optional parts only when asked', () => {
    const values = { df1: '2', df2: '45', F: '3.2', p: '0.0496', eta: '0.12' };
    expect(render(e('anova'), { values, prune: true }).text).toBe('$F(2, 45) = 3.2$, $p = .050$, $\\eta^2_{\\mathrm{p}} = .12$');
    expect(render(e('anova'), { values }).text).toContain('\\mathit{MSE} = $');
    expect(render(e('anova'), { values: { ...values, mse: '1.234' }, prune: true }).text).toContain('$\\mathit{MSE} = 1.23$');
  });

  it('drops the dollars inside math and writes text runs upright', () => {
    expect(render(e('cohendci'), { context: 'math', values: { d: '0.5', lower: '0.1', upper: '0.9' } }).text)
      .toBe('d = 0.5,\\ 95\\%\\ \\mathrm{CI}\\ [0.1, 0.9]');
    expect(textToMath('range ')).toBe('\\mathrm{range}\\ ');
  });

  it('writes Greek letters by the preamble', () => {
    const v = { eta: '.12' };
    expect(render(e('etasqp'), { values: v }).text).toBe('$\\eta^2_{\\mathrm{p}} = .12$');
    expect(render(e('etasqp'), { values: v, greek: 'upgreek' }).text).toBe('$\\upeta^2_{\\mathrm{p}} = .12$');
    expect(render(e('etasqp'), { values: v, greek: 'unicode-math' }).text).toBe('$\\symup{\\eta}^2_{\\mathrm{p}} = .12$');
    expect(greekMode(APA7, {})).toBe('italic');
    expect(greekMode(APA7, { upgreek: true })).toBe('upgreek');
    expect(greekMode(APA7, { unicodeMath: true })).toBe('unicode-math');
    expect(greekMode(style({ greek: 'italic' }), { upgreek: true })).toBe('italic');
    expect(greekMode(style({ greek: 'upright' }))).toBe('upgreek');
  });

  it('writes table cells, braced in siunitx S columns', () => {
    expect(render(e('pcell'), { context: 'cell', values: { p: '0.015' } }).text).toBe('.015');
    expect(render(e('pcell'), { context: 'cell', values: { p: '0.0001' } }).text).toBe('$<$.001');
    expect(render(e('pcell'), { context: 'cell', sColumn: true, values: { p: '0.015' } }).text).toBe('{.015}');
    expect(render(e('pcell'), { context: 'math', values: { p: '0.0001' } }).text).toBe('<.001');
  });

  it('follows the style switches', () => {
    expect(render(e('kruskal'), { style: style({ kruskalSymbol: 'chi2' }), values: { df: '4', H: '29.267', p: '6.9e-06' } }).text)
      .toBe('$\\chi^2(4) = 29.27$, $p < .001$');
    expect(render(e('cri'), { style: style({ credibleLabel: 'HDI' }), values: { lower: '0.1', upper: '0.5' } }).text)
      .toBe('95\\%~HDI~$[0.1, 0.5]$');
    expect(render(e('pearson'), { style: style({ leadingZero: 'always' }), values: { df: '48', r: '0.42', p: '0.002' } }).text)
      .toBe('$r(48) = 0.42$, $p = 0.002$');
  });

  it('wraps a negative value in a text run in math', () => {
    expect(render(e('rangeof'), { values: { min: '-3', max: '4' } }).text).toBe('range $-3$--4');
  });

  it('keeps values as typed when formatting is off', () => {
    expect(render(e('pval'), { values: { p: '0.0004' }, format: false }).text).toBe('$p 0.0004$');
  });

  it('gives previews with example numbers', () => {
    expect(sample(e('pval'))).toBe('$p = .028$');
    expect(sample(e('msd'))).toBe('$M = 4.52$, $\\mathit{SD} = 4.52$');
  });
});
