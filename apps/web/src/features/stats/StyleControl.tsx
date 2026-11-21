import type { CustomControlProps } from '../../settings/types';
import { isApa7, resolveStyle, styleDiff, type StatsStyle } from './core/style';
import './stats.css';

/**
 * The project's house style for statistics (Settings › Statistics, over a
 * project). The stored value holds only what differs from APA 7, so "Reset to
 * APA 7" stores an empty object.
 */

type Option = { value: string | number | boolean; label: string };
const ROWS: { key: keyof StatsStyle; label: string; options: Option[] }[] = [
  { key: 'leadingZero', label: 'Leading zero', options: [
    { value: 'apa', label: 'Only where a value can exceed 1 (APA)' }, { value: 'always', label: 'Always' }, { value: 'never', label: 'Never' },
  ] },
  { key: 'decimals', label: 'Decimals for statistics', options: [1, 2, 3].map((n) => ({ value: n, label: String(n) })) },
  { key: 'pDecimals', label: 'Decimals for p values', options: [{ value: 3, label: '3' }, { value: 2, label: '2' }] },
  { key: 'descriptiveDecimals', label: 'Decimals for means and SDs', options: [{ value: 2, label: '2' }, { value: 1, label: '1 (integer scales)' }, { value: 3, label: '3' }] },
  { key: 'pThreshold', label: 'Smallest p written exactly', options: [
    { value: '.001', label: 'p < .001' }, { value: '.01', label: 'p < .01' }, { value: '.0001', label: 'p < .0001' }, { value: 'none', label: 'None (exact values)' },
  ] },
  { key: 'largestP', label: 'Largest p', options: [{ value: 'cap', label: 'p > .999' }, { value: 'exact', label: 'Exact' }] },
  { key: 'padDecimals', label: 'Always show the set number of decimals', options: [{ value: false, label: 'Off' }, { value: true, label: 'On' }] },
  { key: 'greek', label: 'Greek letters', options: [
    { value: 'auto', label: 'Automatic (upright with upgreek or unicode-math)' }, { value: 'upright', label: 'Upright' }, { value: 'italic', label: 'Italic' },
  ] },
  { key: 'decimalMarker', label: 'Decimal marker', options: [{ value: 'point', label: 'Point (0.84)' }, { value: 'comma', label: 'Comma (0,84)' }] },
  { key: 'credibleLabel', label: 'Credible interval label', options: [{ value: 'CrI', label: 'CrI' }, { value: 'HDI', label: 'HDI' }] },
  { key: 'kruskalSymbol', label: 'Kruskal–Wallis symbol', options: [{ value: 'H', label: 'H' }, { value: 'chi2', label: 'χ²' }] },
];

export default function StyleControl({ value, onChange, disabled }: CustomControlProps<Partial<StatsStyle>>) {
  const style = resolveStyle(value);
  const apa = isApa7(value ?? {});
  const change = (key: keyof StatsStyle, raw: string) => {
    const option = ROWS.find((r) => r.key === key)?.options.find((o) => String(o.value) === raw);
    if (!option) return;
    onChange(styleDiff({ ...style, [key]: option.value }));
  };
  return (
    <div className="stats-style" data-testid="stats-style">
      <div className="stats-style__head">
        <span className="stats-style__name" data-testid="stats-style-name">{apa ? 'APA 7' : 'Custom'}</span>
        {!apa && (
          <button type="button" className="btn btn--small" disabled={disabled} onClick={() => onChange({})} data-testid="stats-style-reset">
            Reset to APA 7
          </button>
        )}
      </div>
      {ROWS.map((r) => (
        <label key={r.key} className="stats-style__row">
          <span className="stats-style__label">{r.label}</span>
          <select
            className="input stats-style__select"
            value={String(style[r.key])}
            disabled={disabled}
            onChange={(e) => change(r.key, e.target.value)}
            data-testid={`stats-style-${r.key}`}
          >
            {r.options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
          </select>
        </label>
      ))}
    </div>
  );
}
