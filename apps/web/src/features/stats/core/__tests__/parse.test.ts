import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertStatistics, looksLikeTestOutput, recognise, reformatStatistics } from '../parse';
import { APA7, type StatsStyle } from '../style';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const convert = (text: string, o: Partial<StatsStyle> = {}) => convertStatistics(text, { style: { ...APA7, ...o } }).text.trim();

describe('converting R output', () => {
  it('turns the Welch sleep t test into APA form', () => {
    expect(convert(fixture('r-welch-sleep.txt'))).toBe('$t(17.78) = -1.86$, $p = .079$, 95\\%~CI~$[-3.37, 0.21]$');
  });

  it('reads cor.test with its estimate and a bounded interval', () => {
    expect(convert(fixture('r-cor-test.txt'))).toBe('$r(48) = .42$, 95\\%~CI~$[.16, .62]$, $p = .002$');
  });

  it('leaves the chi-square N as an empty field', () => {
    const r = convertStatistics(fixture('r-chisq.txt'));
    expect(r.text.trim()).toBe('$\\chi^2(1, N = ) = 4.19$, $p = .041$');
    const n = r.fields.find((f) => f.label === 'N')!;
    expect(n.from).toBe(n.to);
  });

  it('tells Shapiro W from Wilcoxon W and V', () => {
    expect(convert(fixture('r-shapiro.txt'))).toBe('$W = .95$, $p = .045$');
    expect(convert(fixture('r-wilcox-v.txt'))).toBe('$V = 5$, $p = .039$');
  });

  it('reads Kruskal-Wallis with the style symbol', () => {
    expect(convert(fixture('r-kruskal.txt'))).toBe('$H(4) = 29.27$, $p < .001$');
    expect(convert(fixture('r-kruskal.txt'), { kruskalSymbol: 'chi2' })).toBe('$\\chi^2(4) = 29.27$, $p < .001$');
  });

  it('reads an lm summary', () => {
    const out = convert(fixture('r-lm.txt'));
    expect(out).toContain('$R^2 = .83$, $R^2_{\\mathrm{adj}} = .81$, $F(2, 29) = 69.21$, $p < .001$');
    expect(out).toContain('Residual standard error');
  });
});

describe('converting SciPy, BayesFactor and APA-like text', () => {
  it('reads a TtestResult with np.float64 wrappers', () => {
    expect(convert(fixture('scipy-ttest.txt'))).toBe('$t(17.78) = -1.86$, $p = .079$');
  });

  it('opens an empty df when SciPy prints none', () => {
    const r = convertStatistics('Ttest_indResult(statistic=2.31, pvalue=0.028)');
    expect(r.text).toBe('$t() = 2.31$, $p = .028$');
  });

  it('reads BayesFactor output', () => {
    expect(convert('[1] Alt., r=0.707 : 1.271468 ±0%')).toBe('$\\mathit{BF}_{10} = 1.27$');
  });

  it('rewrites APA-like text inside a sentence', () => {
    expect(convert('The effect was reliable, t(28) = 2.31, p = 0.0285, d = 0.84.'))
      .toBe('The effect was reliable, $t(28) = 2.31$, $p = .029$, $d = 0.84$.');
    expect(convert('χ2(1, N = 90) = 4.5, p = .034')).toBe('$\\chi^2(1, N = 90) = 4.5$, $p = .034$');
    expect(convert('F(2, 45) = 3.21, p < .001, ηp² = 0.12')).toBe('$F(2, 45) = 3.21$, $p < .001$, $\\eta^2_{\\mathrm{p}} = .12$');
    expect(convert('M = 4.5, SD = 1.2; 95% CI [0.12, 0.45]')).toBe('$M = 4.5$, $\\mathit{SD} = 1.2$, 95\\%~CI~$[0.12, 0.45]$');
  });

  it('leaves text it does not recognise alone, and math already written', () => {
    expect(convert('Nothing to see here.')).toBe('Nothing to see here.');
    expect(convert('As $t(28) = 2.31$ shows')).toBe('As $t(28) = 2.31$ shows');
    expect(recognise('plain words only')).toEqual([]);
  });

  it('offers to convert program output, not a single stray match', () => {
    expect(looksLikeTestOutput(fixture('r-welch-sleep.txt'))).toBe(true);
    expect(looksLikeTestOutput('t(28) = 2.31, p = .028')).toBe(true);
    expect(looksLikeTestOutput('we set d = 3 here')).toBe(false);
  });
});

describe('reformatting statistics in a file', () => {
  it('applies a new style to whole statistic spans only', () => {
    const doc = 'A $r(48) = .42$, $p = .002$ and $x = 1$ % $p = .5$ in a comment\n';
    const r = reformatStatistics(doc, { style: { ...APA7, leadingZero: 'always' } });
    expect(r.text).toBe('A $r(48) = 0.42$, $p = 0.002$ and $x = 1$ % $p = .5$ in a comment\n');
    expect(r.count).toBe(2);
  });

  it('is idempotent on its own output and keeps bounded intervals', () => {
    const doc = convert(fixture('r-cor-test.txt'));
    expect(reformatStatistics(doc).count).toBe(0);
    expect(reformatStatistics('$W = .95$').count).toBe(0);
  });

  it('rounds raw values and leaves macros alone', () => {
    expect(reformatStatistics('$t(17.776) = -1.8608$, $p = 0.07939$').text).toBe('$t(17.78) = -1.86$, $p = .079$');
    expect(reformatStatistics('$p = \\StudyOneP$').count).toBe(0);
    expect(reformatStatistics('$$p = 0.07939$$').count).toBe(0);
  });
});
