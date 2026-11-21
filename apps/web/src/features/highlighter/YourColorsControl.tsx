/** The "Your colours" settings row (WP37): the custom colours, each removable. */
import type { CustomControlProps } from '../../settings/types';
import { cleanCustomList, removeCustom } from './colors';
import './ui.css';

export default function YourColorsControl({ value, onChange, disabled }: CustomControlProps<string[]>) {
  const list = cleanCustomList(value);
  if (!list.length) return <span className="hl-panel__note" data-testid="setting-your-colors-empty">None yet</span>;
  return (
    <div className="hl-dialog__chips" data-testid="setting-your-colors">
      {list.map((c) => (
        <span key={c} className="hl-dialog__chip" title={c}>
          <span className="hl-swatch-btn" aria-hidden="true"><span className="hl-swatch hl-swatch--custom" style={{ ['--hl' as string]: c }} /></span>
          <span className="hl-row__where">{c}</span>
          <button
            type="button"
            className="hl-dialog__remove"
            aria-label={`Remove ${c} from your colours`}
            disabled={disabled}
            onClick={() => onChange(removeCustom(value, c))}
            data-testid={`setting-your-colors-remove-${c.slice(1)}`}
          >×</button>
        </span>
      ))}
    </div>
  );
}
