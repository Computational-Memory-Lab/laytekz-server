import { useSyncExternalStore, type CSSProperties } from 'react';
import type { SlotProps } from '../../slots/types';
import { chipSnapshot, subscribeChip } from './chip';

const STYLE: CSSProperties = {
  marginLeft: 'var(--space-2, 8px)',
  padding: '0 6px',
  lineHeight: '18px',
  fontSize: 'var(--text-xs, 11px)',
  fontFamily: 'var(--font-ui)',
  color: 'var(--text-2)',
  background: 'var(--bg-inset)',
  border: '1px solid var(--hairline)',
  borderRadius: 'var(--radius-s, 4px)',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  flex: 'none',
};

/** The typing context at the cursor, beside the file name; a click opens the typing settings. */
export default function ContextChip({ page }: SlotProps) {
  const info = useSyncExternalStore(subscribeChip, chipSnapshot, chipSnapshot);
  if (!page || !info) return null;
  return (
    <button
      type="button"
      className="typing-mode-chip"
      style={STYLE}
      data-testid="typing-mode"
      data-kind={info.kind}
      title={`${info.tip} Click for the typing settings.`}
      aria-label={`Typing context: ${info.label}. Open the typing settings.`}
      onClick={() => page.openSettings({ section: 'typing', setting: 'escape.chip' })}
    >
      {info.label}
    </button>
  );
}
