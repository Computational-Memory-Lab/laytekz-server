/**
 * Opening an address found in the source (WP20). It takes the page's normal
 * external-link path: `window.open` in a new tab, which the desktop app's
 * window-open handler hands to the system browser after its own scheme and
 * credential checks; a mail address goes through an anchor, as the browser
 * opens mailto links. Nothing but http, https and mailto ever opens.
 */
import { safeLinkUrl } from '../../util/pdfLinks';

/** Opens `href`; false when it may not open (another scheme, credentials, malformed). */
export function openExternal(href: string): boolean {
  const safe = safeLinkUrl(href);
  if (!safe) return false;
  if (safe.startsWith('mailto:')) {
    const a = document.createElement('a');
    a.href = safe;
    a.rel = 'noopener noreferrer';
    a.click();
    return true;
  }
  window.open(safe, '_blank', 'noopener,noreferrer');
  return true;
}

/** Puts the address on the clipboard; false when the browser refused. */
export async function copyAddress(href: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(href);
    return true;
  } catch {
    return false;
  }
}
