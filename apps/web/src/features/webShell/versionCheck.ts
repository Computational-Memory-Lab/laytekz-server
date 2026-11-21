/**
 * F6 web readiness (WP45): "Laytekz was updated" after a deploy.
 *
 * The server stamps the build it serves into the app page
 * (`<meta name="laytekz-rev">`, http-headers.ts) and answers the same value
 * as `rev` in /api/capabilities. A tab compares the two when it becomes
 * visible again, when the network comes back, and every ten minutes; when
 * the server's differs, it shows one toast per new revision with a Reload
 * button. The reload goes through the browser's own unload, so the editor's
 * unsaved-edits guard still asks first. Nothing reloads by itself.
 */

export const UPDATE_SETTING = 'webShell.updateNotice';
export const CHECK_EVERY_MS = 10 * 60 * 1000;
/** A tab that comes back sooner than this after the last check does not ask again. */
export const MIN_GAP_MS = 60 * 1000;
export const UPDATE_TEXT = 'Laytekz was updated. Reload to get the new version.';

/** The revision this page was built from, or '' when the server stamped none (the dev server). */
export function pageRevision(doc: Pick<Document, 'querySelector'> | null = typeof document !== 'undefined' ? document : null): string {
  try {
    return doc?.querySelector('meta[name="laytekz-rev"]')?.getAttribute('content')?.trim() || '';
  } catch {
    return '';
  }
}

export interface VersionCheckDeps {
  /** This page's revision ('' turns the check off). */
  own: string;
  /** The server's current revision ('' or a throw: unknown, ask again later). */
  fetchRev(): Promise<string>;
  /** Whether the notice is wanted (the setting). */
  enabled(): boolean;
  notify(text: string, action: { label: string; run(): void }): void;
  reload(): void;
  now(): number;
}

/** The decision core, free of timers and the DOM so it is testable. */
export function createVersionCheck(d: VersionCheckDeps) {
  let last = -Infinity;
  let busy = false;
  const told = new Set<string>();
  return {
    told,
    /** Asks the server unless asked recently (`force` skips the gap); resolves to the revision it told about, or null. */
    async check(force = false): Promise<string | null> {
      if (!d.own || busy || !d.enabled()) return null;
      const t = d.now();
      if (!force && t - last < MIN_GAP_MS) return null;
      last = t;
      busy = true;
      let rev = '';
      try { rev = (await d.fetchRev()) || ''; } catch { rev = ''; } finally { busy = false; }
      if (!rev || rev === d.own || told.has(rev) || !d.enabled()) return null;
      told.add(rev);
      d.notify(UPDATE_TEXT, { label: 'Reload', run: () => d.reload() });
      return rev;
    },
  };
}
