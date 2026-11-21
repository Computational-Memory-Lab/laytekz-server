/**
 * The "Smarter suggestions (experimental)" row's control (WP43): the switch,
 * the one-time download with its progress and Cancel, Remove once stored,
 * and the reason when this browser cannot run the model. Turning the switch
 * on downloads the model if it is not stored yet; a cancel or a failure turns
 * it back off.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { CustomControlProps } from '../../../settings/types';
import { megabytes } from './manifest';
import { modelManager, type ModelStatus } from './manager';
import './model.css';

function statusText(s: ModelStatus, on: boolean, size: string, label: string): string {
  switch (s.kind) {
    case 'checking': return 'Checking this browser…';
    case 'unsupported': return `${s.reason} Word suggestions keep working.`;
    case 'absent': return on
      ? 'The model is not on this device (the browser may have removed it). Download it again to use it.'
      : `Not downloaded. Turning this on downloads ${size} once.`;
    case 'downloading': {
      const pct = s.total ? Math.floor((s.loaded / s.total) * 100) : 0;
      return `Downloading ${pct}% · ${Math.round(s.loaded / 1_000_000)} of ${Math.round(s.total / 1_000_000)} MB`;
    }
    case 'installed': return on ? `${label} · ${size} on this device · starts with your next suggestion` : `${label} · ${size} on this device · not in use`;
    case 'loading': return `${label} · starting…`;
    case 'ready': return `${label} · ${size} on this device · running`;
    case 'error': return s.message;
  }
}

export default function ModelControl({ def, value, onChange, disabled }: CustomControlProps<boolean>) {
  const m = modelManager();
  const s = useSyncExternalStore(m.subscribe, m.status, m.status);
  useEffect(() => { void m.refresh(); }, [m]);
  const on = value === true;
  const size = megabytes(m.manifest.bytes);
  const stored = s.kind === 'installed' || s.kind === 'loading' || s.kind === 'ready';
  const unsupported = s.kind === 'unsupported';

  const download = async () => {
    const ok = await m.download();
    if (!ok) onChange(false);
  };
  const toggle = (next: boolean) => {
    if (!next) {
      if (s.kind === 'downloading') m.cancel();
      else void m.unload(); // frees the memory now; the stored model stays for next time
      onChange(false);
      return;
    }
    onChange(true);
    if (!stored) void download();
  };

  return (
    <div className="suggest-model" data-testid="suggest-model">
      <input
        type="checkbox"
        role="switch"
        aria-label={def.label}
        checked={on && !unsupported}
        disabled={disabled || unsupported || s.kind === 'checking'}
        onChange={(e) => toggle(e.target.checked)}
        data-testid="suggest-model-switch"
      />
      <span className="suggest-model__status" role="status" data-testid="suggest-model-status" data-state={s.kind}>
        {statusText(s, on, size, m.manifest.label)}
      </span>
      {s.kind === 'downloading' && (
        <progress className="suggest-model__progress" max={s.total || 1} value={s.loaded} data-testid="suggest-model-progress" aria-label="Model download" />
      )}
      <span className="suggest-model__actions">
        {s.kind === 'downloading' && (
          <button type="button" className="btn btn--small" onClick={() => { m.cancel(); onChange(false); }} data-testid="suggest-model-cancel">Cancel download</button>
        )}
        {(s.kind === 'absent' && on) || (s.kind === 'error' && s.during === 'download') ? (
          <button type="button" className="btn btn--small" disabled={disabled} onClick={() => { onChange(true); void download(); }} data-testid="suggest-model-retry">Download again</button>
        ) : null}
        {(stored || (s.kind === 'error' && s.during === 'load')) && (
          <button type="button" className="btn btn--small btn--ghost" onClick={() => { onChange(false); void m.remove(); }} data-testid="suggest-model-remove">Remove model</button>
        )}
      </span>
    </div>
  );
}
