/**
 * What the probe saw, for the e2e specs: `window.__laytekzProbe` counts each
 * extension point that ran ('boot', 'event:docChanged', 'modClick', …), and
 * `<html data-probe-last>` names the latest.
 */
export interface ProbeLog { counts: Record<string, number>; last: string | null }

declare global {
  interface Window { __laytekzProbe?: ProbeLog }
}

export function probeRecord(what: string): void {
  if (typeof window === 'undefined') return;
  const log = (window.__laytekzProbe ??= { counts: {}, last: null });
  log.counts[what] = (log.counts[what] ?? 0) + 1;
  log.last = what;
  document.documentElement.dataset.probeLast = what;
}
