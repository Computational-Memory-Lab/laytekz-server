import type { AnySettingDef } from '../../settings/types';
import { isStatsStyleDiff, STATS_STYLE_SETTING } from './core/style';

/** The 'stats.*' settings (WP38; core: WP33). Pure data: import types only, never the store or UI code. */

export const STATS_SETTING_IDS = {
  style: STATS_STYLE_SETTING,
  triggers: 'stats.triggers',
  formatOnLeave: 'stats.formatOnLeave',
  typed: 'stats.typed',
  pasteOffer: 'stats.pasteOffer',
} as const;

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

export const settings: readonly AnySettingDef[] = [
  {
    id: STATS_SETTING_IDS.style,
    section: 'statistics',
    label: 'House style for statistics',
    hint: 'How numbers are written in this project: APA 7 unless you change it. Everyone on the project gets the same style',
    keywords: 'apa leading zero decimals p value threshold greek upright statistics style',
    scope: 'project',
    default: {},
    validate: isStatsStyleDiff,
    control: { kind: 'custom', load: () => import('./StyleControl') },
    order: 10,
  },
  {
    id: STATS_SETTING_IDS.triggers,
    section: 'statistics',
    label: 'List statistics in the \\ completions',
    hint: 'Typing \\pval, \\ttest or \\bayes10 offers the statistic; Enter or Tab inserts it with fields for the numbers',
    keywords: 'statistics trigger completion backslash command p value t test bayes factor',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    palette: true,
    order: 20,
  },
  {
    id: STATS_SETTING_IDS.formatOnLeave,
    section: 'statistics',
    label: 'Format each number as I leave its field',
    hint: 'p = 0.0004 becomes p < .001 when you press Tab. Off keeps the fields but leaves the numbers as typed',
    keywords: 'statistics format round leading zero field tab',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    order: 30,
  },
  {
    id: STATS_SETTING_IDS.typed,
    section: 'statistics',
    label: 'Format statistics typed in prose',
    hint: 'When automatic math mode wraps t(28) = 2.31 or p = 0.028, it uses the house style: $t(28) = 2.31$, $p = .028$',
    keywords: 'statistics typed prose automatic math apa',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    dependsOn: 'automath.wrap',
    order: 40,
  },
  {
    id: STATS_SETTING_IDS.pasteOffer,
    section: 'statistics',
    label: 'Offer to convert pasted statistics',
    hint: 'After you paste R or Python test output, Laytekz offers to rewrite it in the house style. Nothing changes unless you click Convert',
    keywords: 'statistics paste convert r python scipy output apa',
    scope: 'account',
    default: true,
    validate: isBool,
    control: { kind: 'switch' },
    automatic: true,
    order: 50,
  },
];
