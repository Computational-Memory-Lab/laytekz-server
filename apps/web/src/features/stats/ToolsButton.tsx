import { useChordLabel } from '../../keys/registry';
import type { SlotProps } from '../../slots/types';
import { openPicker } from './ui';
import './stats.css';

/** The editor header's "Insert statistic" button (slot editor.tools, order 200). */
export default function ToolsButton(_: SlotProps) {
  const keys = useChordLabel('stats.insert');
  const label = keys ? `Insert a statistic (${keys})` : 'Insert a statistic';
  return (
    <button
      type="button"
      className="btn btn--ghost btn--small btn--icon stats-tools-button"
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={openPicker}
      data-testid="stats-insert-button"
    >
      <span aria-hidden="true">p</span>
    </button>
  );
}
