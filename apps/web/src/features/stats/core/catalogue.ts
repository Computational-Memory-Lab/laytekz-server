import type { Kind } from './format';

/**
 * The statistics catalogue (feature 16). Each entry expands to plain LaTeX in
 * the source: no macro package, so journals, arXiv and co-authors need
 * nothing extra, and KaTeX can preview it.
 *
 * Template syntax:
 * - `⟦label:KIND⟧` is a field, in textual order; `⟦label:KIND=95⟧` is prefilled.
 *   KIND is a formatting kind from format.ts. Labels are unique within an entry.
 * - `⟪…⟫` is an optional part, removed when all its fields are left empty.
 * - `$…$` is math. In prose each statistic gets its own `$…$`; inside existing
 *   math the `$` signs are dropped (render.ts).
 * - `⟨KW⟩` is the Kruskal–Wallis symbol and `⟨CRI⟩` the credible-interval
 *   label, both set by the house style.
 * Symbols are italic unless they are abbreviations (APA): multi-letter symbols
 * use \mathit, abbreviations and identifier subscripts \mathrm. Lowercase Greek
 * follows the Greek setting (render.ts).
 */

export type StatGroup =
  | 'Significance' | 'Bayesian' | 'Tests' | 'Correlation and regression' | 'Effect sizes'
  | 'Descriptives and intervals' | 'Reliability and agreement' | 'Model fit' | 'Meta-analysis' | 'Report lines';

export const GROUPS: readonly StatGroup[] = [
  'Significance', 'Bayesian', 'Tests', 'Correlation and regression', 'Effect sizes',
  'Descriptives and intervals', 'Reliability and agreement', 'Model fit', 'Meta-analysis', 'Report lines',
];

export interface StatEntry {
  id: string;
  /** What is typed after the backslash's word ("\\pval"); null for entries only the picker and converter use. */
  trigger: string | null;
  title: string;
  group: StatGroup;
  /** Extra words the picker searches ("mann whitney rank sum"). */
  keywords: string;
  template: string;
  /** One line on the rules, for the completion info ("Exact p; below .001 becomes p < .001"). */
  rule?: string;
}

const P = String.raw`$p ⟦p:P⟧$`;
const CI = (lo: Kind = 'U', label = 'CI', level = '95') =>
  String.raw`⟦level:LVL=${level}⟧\%~${label}~$[⟦lower:${lo}⟧, ⟦upper:${lo}⟧]$`;

type Row = [trigger: string | null, title: string, keywords: string, template: string, rule?: string];

const TABLE: Record<StatGroup, Row[]> = {
  'Significance': [
    ['pval', 'p value', 'significance probability exact', P, 'Exact p; below .001 becomes p < .001, and p that rounds to 1 becomes p > .999'],
    ['pless', 'p below a threshold', 'significance less than inequality', String.raw`$p < ⟦threshold:PT⟧$`, 'Inequality form, such as p < .05'],
    ['pcell', 'p value in a table cell', 'table column significance', String.raw`⟦p:PC⟧`, 'APA table form: .015 or <.001'],
    ['pnote', 'Significance note for a table', 'stars asterisks table note',
      String.raw`\textsuperscript{*}$p < .05$. \textsuperscript{**}$p < .01$. \textsuperscript{***}$p < .001$.`],
    ['alphalevel', 'Alpha level', 'significance criterion', String.raw`$\alpha = ⟦alpha:PT=.05⟧$`],
  ],
  'Bayesian': [
    ['bayes10', 'Bayes factor BF10', 'bf10 bayes factor evidence alternative', String.raw`$\mathit{BF}_{10} = ⟦bf:BF⟧$`, 'Two decimals; at or above 1000 and below .001 in scientific form'],
    ['bayes01', 'Bayes factor BF01', 'bf01 bayes factor evidence null', String.raw`$\mathit{BF}_{01} = ⟦bf:BF⟧$`, 'Two decimals; at or above 1000 and below .001 in scientific form'],
    ['bayesplus', 'Bayes factor BF+0 (one-sided)', 'bf+0 bayes factor directional one sided', String.raw`$\mathit{BF}_{+0} = ⟦bf:BF⟧$`],
    ['logbf', 'Log Bayes factor', 'log bf10 bayes', String.raw`$\log(\mathit{BF}_{10}) = ⟦logbf:U⟧$`],
    ['postprob', 'Posterior probability', 'posterior model probability bayes', String.raw`$P(H_1 \mid D) = ⟦prob:B⟧$`],
    ['cri', 'Credible interval', 'bayes credible interval hdi', CI('U', '⟨CRI⟩'), 'The label follows the house style (CrI or HDI)'],
    ['hdi', 'Highest density interval', 'bayes hdi credible interval', CI('U', 'HDI')],
    ['rhat', 'R-hat convergence', 'gelman rubin convergence mcmc', String.raw`$\hat{R} = ⟦rhat:U⟧$`],
    ['ess', 'Effective sample size', 'mcmc ess bulk tail', String.raw`$\mathrm{ESS} = ⟦ess:N⟧$`],
    ['bayesttest', 'Bayesian t test', 'bayes factor delta effect credible', String.raw`$\mathit{BF}_{10} = ⟦bf:BF⟧$, $\delta = ⟦delta:U⟧$, ${CI('U', '⟨CRI⟩')}`],
  ],
  'Tests': [
    ['ttest', 't test', 'student independent paired one sample', String.raw`$t(⟦df:DF⟧) = ⟦t:U⟧$, ${P}`, 'df in parentheses; t to 2 decimals'],
    ['welch', 'Welch t test', 'unequal variances t test', String.raw`$t(⟦df:DF⟧) = ⟦t:U⟧$, ${P}`, 'Fractional df to 2 decimals'],
    ['ftest', 'F test', 'anova f statistic', String.raw`$F(⟦df1:DF⟧, ⟦df2:DF⟧) = ⟦F:U⟧$, ${P}`],
    ['chisq', 'Chi-square test', 'chi squared contingency independence goodness of fit', String.raw`$\chi^2(⟦df:DF⟧, N = ⟦N:N⟧) = ⟦chisq:U⟧$, ${P}`],
    ['ztest', 'z test', 'normal z statistic', String.raw`$z = ⟦z:U⟧$, ${P}`],
    ['mannwhitney', 'Mann–Whitney U test', 'mann whitney rank sum wilcoxon nonparametric', String.raw`$U = ⟦U:N⟧$⟪, $z = ⟦z:U⟧$⟫, ${P}`],
    ['wilcoxonw', 'Wilcoxon rank-sum test (W)', 'wilcoxon rank sum nonparametric', String.raw`$W = ⟦W:N⟧$, ${P}`],
    ['wilcoxonv', 'Wilcoxon signed-rank test (V)', 'wilcoxon signed rank paired nonparametric', String.raw`$V = ⟦V:N⟧$, ${P}`],
    ['wilcoxont', 'Wilcoxon signed-rank test (T)', 'wilcoxon signed rank paired nonparametric', String.raw`$T = ⟦T:N⟧$, ${P}`],
    ['kruskal', 'Kruskal–Wallis test', 'kruskal wallis rank anova nonparametric', String.raw`$⟨KW⟩(⟦df:DF⟧) = ⟦H:U⟧$, ${P}`, 'H or chi-square, by the house style'],
    ['friedman', 'Friedman test', 'friedman rank repeated nonparametric', String.raw`$\chi^2_{\mathrm{F}}(⟦df:DF⟧) = ⟦chisq:U⟧$, ${P}`],
    ['binomtest', 'Binomial test', 'binomial sign test proportion successes', String.raw`⟦k:N⟧ of ⟦n:N⟧, binomial ${P}`],
    ['shapiro', 'Shapiro–Wilk test', 'normality shapiro wilk', String.raw`$W = ⟦W:B⟧$, ${P}`],
  ],
  'Correlation and regression': [
    ['pearson', 'Pearson correlation', 'correlation r pearson product moment', String.raw`$r(⟦df:DF⟧) = ⟦r:B⟧$, ${P}`],
    ['spearman', 'Spearman correlation', 'rank correlation rho spearman', String.raw`$r_{\mathrm{s}}⟪(⟦df:DF⟧)⟫ = ⟦r:B⟧$, ${P}`],
    ['kendall', 'Kendall’s tau', 'rank correlation tau kendall', String.raw`$\tau_{\mathrm{b}} = ⟦tau:B⟧$, ${P}`],
    ['rsq', 'R squared', 'r2 coefficient of determination variance explained', String.raw`$R^2 = ⟦rsq:B⟧$`],
    ['rsqadj', 'Adjusted R squared', 'r2 adjusted', String.raw`$R^2_{\mathrm{adj}} = ⟦rsq:B⟧$`],
    ['deltarsq', 'R squared change', 'delta r2 hierarchical regression', String.raw`$\Delta R^2 = ⟦drsq:B⟧$, $F(⟦df1:DF⟧, ⟦df2:DF⟧) = ⟦F:U⟧$, ${P}`],
    ['regmodel', 'Regression model', 'regression model fit f r2', String.raw`$F(⟦df1:DF⟧, ⟦df2:DF⟧) = ⟦F:U⟧$, ${P}, $R^2 = ⟦rsq:B⟧$`],
    ['bcoef', 'Regression coefficient', 'unstandardized b slope standard error', String.raw`$b = ⟦b:U⟧$, $\mathit{SE} = ⟦se:U⟧$`],
    ['regfull', 'Regression coefficient with test', 'b se t coefficient', String.raw`$b = ⟦b:U⟧$, $\mathit{SE} = ⟦se:U⟧$, $t(⟦df:DF⟧) = ⟦t:U⟧$, ${P}`],
    ['betacoef', 'Standardized coefficient', 'beta standardized regression weight', String.raw`$\beta = ⟦beta:U⟧$`, 'Keeps the leading zero (can exceed 1)'],
    ['se', 'Standard error', 'se standard error', String.raw`$\mathit{SE} = ⟦se:U⟧$`],
    ['oddsratio', 'Odds ratio', 'or logistic odds', String.raw`$\mathit{OR} = ⟦or:U⟧$, ${CI()}`],
    ['riskratio', 'Risk ratio', 'rr relative risk', String.raw`$\mathit{RR} = ⟦rr:U⟧$, ${CI()}`],
    ['hazardratio', 'Hazard ratio', 'hr cox survival', String.raw`$\mathit{HR} = ⟦hr:U⟧$, ${CI()}`],
    ['indirect', 'Indirect effect', 'mediation ab indirect bootstrap', String.raw`$ab = ⟦ab:U⟧$, ${CI()}`],
  ],
  'Effect sizes': [
    ['cohend', 'Cohen’s d', 'effect size standardized mean difference', String.raw`$d = ⟦d:U⟧$`],
    ['dz', 'Cohen’s d_z', 'effect size paired within', String.raw`$d_{\mathrm{z}} = ⟦d:U⟧$`],
    ['hedgesg', 'Hedges’ g', 'effect size corrected', String.raw`$g = ⟦g:U⟧$`],
    ['cohendci', 'Cohen’s d with interval', 'effect size confidence interval', String.raw`$d = ⟦d:U⟧$, ${CI()}`],
    ['etasq', 'Eta squared', 'effect size anova eta', String.raw`$\eta^2 = ⟦eta:B⟧$`, 'Bounded, so no leading zero'],
    ['etasqp', 'Partial eta squared', 'effect size anova eta partial', String.raw`$\eta^2_{\mathrm{p}} = ⟦eta:B⟧$`, 'Bounded, so no leading zero'],
    ['etasqg', 'Generalized eta squared', 'effect size anova eta generalized', String.raw`$\eta^2_{\mathrm{G}} = ⟦eta:B⟧$`],
    ['omegasq', 'Omega squared', 'effect size anova omega', String.raw`$\omega^2 = ⟦omega:B⟧$`],
    ['omegasqp', 'Partial omega squared', 'effect size anova omega partial', String.raw`$\omega^2_{\mathrm{p}} = ⟦omega:B⟧$`],
    ['cohenf', 'Cohen’s f', 'effect size f anova power', String.raw`$f = ⟦f:U⟧$`],
    ['cohenfsq', 'Cohen’s f squared', 'effect size f2 regression', String.raw`$f^2 = ⟦f2:U⟧$`],
    ['cohenw', 'Cohen’s w', 'effect size chi square', String.raw`$w = ⟦w:U⟧$`],
    ['phicoef', 'Phi coefficient', 'effect size 2x2 contingency phi', String.raw`$\phi = ⟦phi:B⟧$`],
    ['cramerv', 'Cramér’s V', 'effect size contingency cramer', String.raw`$V = ⟦V:B⟧$`],
    ['rankbis', 'Rank-biserial correlation', 'effect size mann whitney rank biserial', String.raw`$r_{\mathrm{rb}} = ⟦r:B⟧$`],
    ['cliffd', 'Cliff’s delta', 'effect size ordinal dominance', String.raw`$\delta = ⟦delta:B⟧$`],
    ['dprime', 'd prime (sensitivity)', 'signal detection sensitivity', String.raw`$d' = ⟦d:U⟧$`],
    ['sdtc', 'Criterion c', 'signal detection bias criterion', String.raw`$c = ⟦c:U⟧$`],
    ['aprime', 'A prime', 'signal detection nonparametric sensitivity', String.raw`$A' = ⟦a:B⟧$`],
    ['auc', 'Area under the curve', 'auc roc classification', String.raw`$\mathrm{AUC} = ⟦auc:B⟧$`],
    ['power', 'Statistical power', 'power 1 minus beta', String.raw`$1 - \beta = ⟦power:B⟧$`],
  ],
  'Descriptives and intervals': [
    ['msd', 'Mean and SD', 'mean standard deviation descriptives', String.raw`$M = ⟦M:M⟧$, $\mathit{SD} = ⟦SD:M⟧$`],
    ['mean', 'Mean', 'average m', String.raw`$M = ⟦M:M⟧$`],
    ['sd', 'Standard deviation', 'sd spread', String.raw`$\mathit{SD} = ⟦SD:M⟧$`],
    ['mdn', 'Median', 'median mdn', String.raw`$\mathit{Mdn} = ⟦mdn:M⟧$`],
    ['iqr', 'Interquartile range', 'iqr spread', String.raw`$\mathit{IQR} = ⟦iqr:M⟧$`],
    ['mdniqr', 'Median and IQR', 'median interquartile range', String.raw`$\mathit{Mdn} = ⟦mdn:M⟧$, $\mathit{IQR} = ⟦iqr:M⟧$`],
    ['rangeof', 'Range', 'minimum maximum range', String.raw`range ⟦min:M⟧--⟦max:M⟧`],
    ['ntotal', 'Total sample size', 'n participants sample size total', String.raw`$N = ⟦N:N⟧$`],
    ['nsub', 'Subgroup size', 'n subsample group size', String.raw`$n = ⟦n:N⟧$`],
    ['npct', 'Count and percentage', 'n percent frequency', String.raw`$n = ⟦n:N⟧$ (⟦pct:PCT⟧\%)`],
    ['pct', 'Percentage', 'percent proportion', String.raw`⟦pct:PCT⟧\%`],
    ['mage', 'Mean age', 'participants age years', String.raw`$M_{\mathrm{age}} = ⟦M:M⟧$~years, $\mathit{SD} = ⟦SD:M⟧$`],
    ['meanci', 'Mean with interval', 'mean confidence interval', String.raw`$M = ⟦M:M⟧$, ${CI('M')}`],
    ['ci', 'Confidence interval', 'confidence interval brackets', CI(), 'Brackets (APA)'],
    ['predint', 'Prediction interval', 'prediction interval meta', CI('U', 'PI')],
  ],
  'Reliability and agreement': [
    ['cronbach', 'Cronbach’s alpha', 'reliability internal consistency alpha', String.raw`$\alpha = ⟦alpha:B⟧$`],
    ['mcdonald', 'McDonald’s omega', 'reliability omega', String.raw`$\omega = ⟦omega:B⟧$`],
    ['cohenkappa', 'Cohen’s kappa', 'agreement interrater kappa', String.raw`$\kappa = ⟦kappa:B⟧$`],
    ['icc', 'Intraclass correlation', 'icc reliability agreement', String.raw`$\mathrm{ICC}⟪(⟦model:RAW⟧)⟫ = ⟦icc:B⟧$⟪, ${CI('B')}⟫`],
  ],
  'Model fit': [
    ['aic', 'AIC', 'akaike information criterion', String.raw`$\mathrm{AIC} = ⟦aic:U⟧$`],
    ['bic', 'BIC', 'bayesian information criterion schwarz', String.raw`$\mathrm{BIC} = ⟦bic:U⟧$`],
    ['waic', 'WAIC', 'widely applicable information criterion', String.raw`$\mathrm{WAIC} = ⟦waic:U⟧$`],
    ['looic', 'LOOIC', 'leave one out cross validation', String.raw`$\mathrm{LOOIC} = ⟦looic:U⟧$`],
    ['deltaaic', 'AIC difference', 'delta aic model comparison', String.raw`$\Delta\mathrm{AIC} = ⟦daic:U⟧$`],
    ['elpd', 'Expected log predictive density', 'elpd loo', String.raw`$\mathrm{elpd}_{\mathrm{LOO}} = ⟦elpd:U⟧$ ($\mathit{SE} = ⟦se:U⟧$)`],
    ['loglik', 'Log-likelihood', 'log likelihood ll', String.raw`$\mathrm{LL} = ⟦ll:U⟧$`],
    ['deviance', 'Deviance', 'minus two log likelihood', String.raw`$-2\mathrm{LL} = ⟦dev:U⟧$`],
    ['lrt', 'Likelihood-ratio test', 'model comparison chi square difference', String.raw`$\Delta\chi^2(⟦df:DF⟧) = ⟦chisq:U⟧$, ${P}`],
    ['cfi', 'CFI', 'comparative fit index sem', String.raw`$\mathrm{CFI} = ⟦cfi:B⟧$`],
    ['tli', 'TLI', 'tucker lewis index sem', String.raw`$\mathrm{TLI} = ⟦tli:U⟧$`, 'Keeps the leading zero (can exceed 1)'],
    ['rmsea', 'RMSEA', 'root mean square error approximation sem', String.raw`$\mathrm{RMSEA} = ⟦rmsea:B⟧$, ${CI('B', 'CI', '90')}`],
    ['srmr', 'SRMR', 'standardized root mean square residual sem', String.raw`$\mathrm{SRMR} = ⟦srmr:B⟧$`],
    ['semfit', 'SEM fit summary', 'structural equation model fit indices',
      String.raw`$\chi^2(⟦df:DF⟧) = ⟦chisq:U⟧$, ${P}, $\mathrm{CFI} = ⟦cfi:B⟧$, $\mathrm{TLI} = ⟦tli:U⟧$, $\mathrm{RMSEA} = ⟦rmsea:B⟧$, ${CI('B', 'CI', '90')}, $\mathrm{SRMR} = ⟦srmr:B⟧$`],
  ],
  'Meta-analysis': [
    ['qtest', 'Q test of heterogeneity', 'cochran q heterogeneity meta analysis', String.raw`$Q(⟦df:DF⟧) = ⟦Q:U⟧$, ${P}`],
    ['isq', 'I squared', 'heterogeneity i2 meta analysis', String.raw`$I^2 = ⟦isq:PCT⟧\%$`],
    ['tausq', 'Tau squared', 'between study variance meta analysis', String.raw`$\tau^2 = ⟦tausq:U⟧$`],
  ],
  'Report lines': [
    ['ttestfull', 't test with effect size', 't test cohen d confidence interval report', String.raw`$t(⟦df:DF⟧) = ⟦t:U⟧$, ${P}, $d = ⟦d:U⟧$, ${CI()}`],
    ['anova', 'ANOVA result', 'anova f mse partial eta squared report', String.raw`$F(⟦df1:DF⟧, ⟦df2:DF⟧) = ⟦F:U⟧$⟪, $\mathit{MSE} = ⟦mse:U⟧$⟫, ${P}, $\eta^2_{\mathrm{p}} = ⟦eta:B⟧$`],
    ['chisqfull', 'Chi-square test with effect size', 'chi square cramer v report', String.raw`$\chi^2(⟦df:DF⟧, N = ⟦N:N⟧) = ⟦chisq:U⟧$, ${P}, $V = ⟦V:B⟧$`],
    ['corfull', 'Correlation with interval', 'pearson correlation confidence interval report', String.raw`$r(⟦df:DF⟧) = ⟦r:B⟧$, ${CI('B')}, ${P}`],
    ['mannwhitneyfull', 'Mann–Whitney test with effect size', 'mann whitney rank biserial report', String.raw`$U = ⟦U:N⟧$, $z = ⟦z:U⟧$, ${P}, $r_{\mathrm{rb}} = ⟦r:B⟧$`],
  ],
};

export const CATALOGUE: readonly StatEntry[] = GROUPS.flatMap((group) =>
  TABLE[group].map(([trigger, title, keywords, template, rule]) => ({
    id: trigger ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    trigger: trigger ? `\\${trigger}` : null,
    title, group, keywords, template, ...(rule ? { rule } : {}),
  })),
);

const BY_ID = new Map(CATALOGUE.map((e) => [e.id, e]));
const BY_TRIGGER = new Map(CATALOGUE.filter((e) => e.trigger).map((e) => [e.trigger!, e]));

export const entryById = (id: string): StatEntry | undefined => BY_ID.get(id);
/** The entry for a trigger as typed, backslash included ("\\pval"). */
export const entryByTrigger = (trigger: string): StatEntry | undefined => BY_TRIGGER.get(trigger);

/** Entries whose trigger starts with the typed prefix ("\\pv"), in catalogue order. */
export const triggersStartingWith = (prefix: string): StatEntry[] =>
  CATALOGUE.filter((e) => e.trigger && e.trigger.startsWith(prefix));

/** Picker search over title, trigger and keywords: every word must match somewhere. */
export function searchCatalogue(query: string): StatEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...CATALOGUE];
  return CATALOGUE.filter((e) => {
    const hay = `${e.title} ${e.trigger ?? ''} ${e.keywords} ${e.group}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
