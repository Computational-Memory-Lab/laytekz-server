/**
 * F6 web readiness (WP45): what other code may use from this feature
 * (ProductCredit's sign-in fine print). Pure: no React, no store.
 */

/** The download link's label for this platform, or null where the desktop app does not run or is already open. */
export function desktopLinkLabel(userAgent: string): string | null {
  if (/\bElectron\//.test(userAgent) || /\bLaytekz-Desktop\//.test(userAgent)) return null;
  if (/iPhone|iPad|iPod|Android/i.test(userAgent)) return 'Get the desktop app for macOS and Windows';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'Download the desktop app for macOS';
  if (/Windows/.test(userAgent)) return 'Download the desktop app for Windows';
  return 'Get the desktop app for macOS and Windows';
}

/** The `desktopUrl` capability when it is an https URL. */
export function desktopUrlOf(caps: Record<string, unknown>): string | null {
  const v = caps.desktopUrl;
  if (typeof v !== 'string') return null;
  try { return new URL(v).protocol === 'https:' ? v : null; } catch { return null; }
}

export const ABOUT_PATH = '/about';

/** The admin chip's text: "1 waiting", "3 waiting", or null when nobody waits. */
export function waitingLabel(count: number): string | null {
  return Number.isInteger(count) && count > 0 ? `${count} waiting` : null;
}
