import { describe, expect, it } from 'vitest';
import { formatValue, parseDecimal, roundDec } from '../format';
import { APA7, type StatsStyle } from '../style';

const style = (o: Partial<StatsStyle>): StatsStyle => ({ ...APA7, ...o });
const f = (kind: Parameters<typeof formatValue>[0], raw: string, s: StatsStyle = APA7) => formatValue(kind, raw, s).text;

describe('decimal strings', () => {
  it('parses without binary floats', () => {
    expect(parseDecimal('4.3e-05')).toEqual({ neg: false, int: '', frac: '000043' });
    expect(parseDecimal('−2.31')).toEqual({ neg: true, int: '2', frac: '31' });
    expect(parseDecimal('1{,}234.57')).toEqual({ neg: false, int: '1234', frac: '57' });
    expect(parseDecimal('0{,}84')).toEqual({ neg: false, int: '', frac: '84' });
    expect(parseDecimal('1.23 \\times 10^{4}')).toEqual({ neg: false, int: '12300', frac: '' });
    expect(parseDecimal('2.31***')).toEqual({ neg: false, int: '2', frac: '31' });
    expect(parseDecimal('abc')).toBeNull();
  });

  it('rounds half away from zero and never pads', () => {
    expect(roundDec(parseDecimal('0.0285')!, 3)).toEqual({ neg: false, int: '', frac: '029' });
    expect(roundDec(parseDecimal('-0.415')!, 2)).toEqual({ neg: true, int: '', frac: '42' });
    expect(roundDec(parseDecimal('9.995')!, 2)).toEqual({ neg: false, int: '10', frac: '00' });
    expect(roundDec(parseDecimal('.03')!, 3)).toEqual({ neg: false, int: '', frac: '03' });
  });
});

describe('p values', () => {
  it('follows APA 7', () => {
    expect(formatValue('P', '0.0285').value).toBe('.029');
    expect(f('P', '0.0285')).toBe('= .029');
    expect(f('P', '4.3e-05')).toBe('< .001');
    expect(f('P', '0.0004')).toBe('< .001');
    expect(f('P', '0.00099999')).toBe('< .001');
    expect(f('P', '0.001')).toBe('= .001');
    expect(f('P', '0.0496')).toBe('= .050');
    expect(f('P', '.05')).toBe('= .05');
    expect(f('P', '0.9996')).toBe('> .999');
    expect(f('P', '1')).toBe('> .999');
    expect(f('P', '0')).toBe('< .001');
    expect(f('P', '.000')).toBe('< .001');
    expect(f('P', '< 2.2e-16')).toBe('< .001');
    expect(f('P', '< .05')).toBe('< .05');
    expect(f('P', 'p-value = 0.07939')).toBe('= .079');
  });

  it('compares the threshold before rounding', () => {
    // .00096 rounds to .001 but lies below the threshold.
    expect(f('P', '0.00096')).toBe('< .001');
  });

  it('keeps out-of-range values and warns', () => {
    const r = formatValue('P', '1.2');
    expect(r.text).toBe('1.2');
    expect(r.warning).toBeTruthy();
  });

  it('passes macros through', () => {
    expect(f('P', '\\StudyOneP')).toBe('= \\StudyOneP');
    expect(f('U', '\\StudyOneT')).toBe('\\StudyOneT');
  });

  it('follows the style', () => {
    expect(f('P', '0.0285', style({ pDecimals: 2 }))).toBe('= .03');
    expect(f('P', '4.3e-05', style({ pThreshold: 'none' }))).toBe('= 4.3 \\times 10^{-5}');
    expect(f('P', '0.0285', style({ leadingZero: 'always' }))).toBe('= 0.029');
    expect(f('P', '0.05', style({ padDecimals: true }))).toBe('= .050');
    expect(f('PC', '0.015')).toBe('.015');
    expect(f('PC', '0.0001')).toBe('$<$.001');
  });
});

describe('other kinds', () => {
  it('formats bounded, unbounded and descriptive values', () => {
    expect(f('B', '0.42')).toBe('.42');
    expect(f('B', '-0.418')).toBe('-.42');
    expect(formatValue('B', '1.4').warning).toBeTruthy();
    expect(f('U', '.84')).toBe('0.84');
    expect(f('U', '1234.567')).toBe('1{,}234.57');
    expect(f('U', '1,234')).toBe('1{,}234');
    expect(f('U', '-1.8608')).toBe('-1.86');
    expect(f('U', '-0.001')).toBe('0.00');
    expect(f('M', '4.567', style({ descriptiveDecimals: 1 }))).toBe('4.6');
    expect(f('U', '.84', style({ decimalMarker: 'comma' }))).toBe('0{,}84');
    expect(f('U', '1234.567', style({ decimalMarker: 'comma' }))).toBe('1\\,234{,}57');
    expect(f('B', '0.42', style({ leadingZero: 'always' }))).toBe('0.42');
    expect(f('U', '0.84', style({ leadingZero: 'never' }))).toBe('.84');
  });

  it('formats df, counts, Bayes factors, percentages and thresholds', () => {
    expect(f('DF', '17.776')).toBe('17.78');
    expect(f('DF', '1200')).toBe('1200');
    expect(f('DF', '2.000')).toBe('2');
    expect(f('N', '1234')).toBe('1{,}234');
    expect(f('N', '12.5')).toBe('12.5');
    expect(f('BF', '3.2145')).toBe('3.21');
    expect(f('BF', '12345')).toBe('1.23 \\times 10^{4}');
    expect(f('BF', '0.0004567')).toBe('4.57 \\times 10^{-4}');
    expect(formatValue('BF', '0').warning).toBeTruthy();
    expect(f('PCT', '37.5%')).toBe('37.5');
    expect(f('PCT', '37.56')).toBe('37.6');
    expect(f('PT', '0.05')).toBe('.05');
    expect(f('LVL', '95')).toBe('95');
    expect(f('RAW', '2, 1')).toBe('2, 1');
    expect(f('U', '')).toBe('');
  });
});
