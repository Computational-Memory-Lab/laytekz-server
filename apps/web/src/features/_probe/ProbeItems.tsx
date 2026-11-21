import type { CSSProperties } from 'react';
import type { SlotId, SlotProps } from '../../slots/types';

const TAG: CSSProperties = { fontSize: 10, lineHeight: '16px', padding: '0 4px', borderRadius: 4, color: 'var(--text-3)', border: '1px dashed var(--hairline-strong)', whiteSpace: 'nowrap' };
/** The overlays are drawn over the page, so they must not push its layout around. */
const FLOATING: CSSProperties = { ...TAG, position: 'fixed', bottom: 4, zIndex: 1, pointerEvents: 'none', background: 'var(--bg-panel)' };

/** A tag that marks one slot; `data-testid="probe-slot-<slot>"`, with the page it was given. */
export function probeSlotItem(slot: SlotId) {
  const style = slot === 'editor.overlay' ? { ...FLOATING, left: 4 } : slot === 'pdf.overlay' ? { ...FLOATING, right: 4 } : TAG;
  function ProbeSlotItem({ page, app }: SlotProps) {
    return (
      <span style={style} data-testid={`probe-slot-${slot}`} data-page={page ? `${page.projectId}::${page.branch}` : ''} data-desktop={app.desktop ? '1' : '0'}>
        probe
      </span>
    );
  }
  return ProbeSlotItem;
}

export function ProbeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="5" strokeDasharray="2 2" />
    </svg>
  );
}

export function ProbePanel({ page }: SlotProps) {
  return <div className="probe-panel" style={{ padding: 12 }} data-testid="probe-panel">Probe panel for {page?.project()?.name ?? 'no project'}</div>;
}

export function ProbeMorePanel() {
  return <div className="probe-panel" style={{ padding: 12 }} data-testid="probe-more-panel">Probe panel in the More menu</div>;
}
